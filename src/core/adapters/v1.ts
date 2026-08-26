import { erc20Abi, type Address, type PublicClient } from 'viem'

import { v1FactoryAbi, v1LockerAbi, v1TokenAbi } from '../../abi/index.js'
import { addresses } from '../../chain/addresses.js'
import { ExitCode, PonsError } from '../../errors.js'
import { readV3Pool, spotPriceFrom, type V3PoolState } from '../routes/v3.js'

/**
 * Reading a Pons V1 launch.
 *
 * V1 has no bonding curve. A launch deploys the token, creates a Uniswap V3
 * pool, mints the whole supply into a single-sided position and hands that
 * position to the locker — so from the first block the token trades on a real
 * pool and "graduation" is a threshold measured against that position rather
 * than a phase the token moves through.
 *
 * **V1 is closed to new launches.** `launchEnabled()` is false, switched off by
 * the owner on 2026-08-12, and that transaction is the last log the factory
 * ever emitted. What remains is the reason this adapter exists: over eight
 * thousand tokens that still hold liquidity and still trade.
 */

export interface V1Launch {
  token: Address
  /** Where the token trades. Derived from the factory's record, not searched. */
  pool: Address
  deployer: Address
  /** The pool's other side. WETH for every launch config today. */
  pairToken: Address
  positionManager: Address
  positionId: bigint
  dexId: bigint
  launchConfigId: bigint
  poolFee: number
  /** Whether the launch token sorted first in the pool. */
  isToken0: boolean
  metadata: { name: string; symbol: string; decimals: number; totalSupply: bigint }
  pair: { address: Address; symbol: string; decimals: number }
  poolState: V3PoolState
  graduation: {
    /** Pair-asset principal the position has accumulated, in its own units. */
    raised: bigint
    threshold: bigint
    graduated: boolean
  }
  /**
   * The launch-window transfer caps.
   *
   * Both are permanent numbers on the token, but they only bind while
   * `block.number <= restrictionEndBlock` — two blocks after deployment on
   * every launch config that has existed. For anything tradeable today the
   * window is long closed, and reporting the caps without that fact reads as a
   * live restriction.
   */
  restrictions: {
    maxWallet: bigint
    maxTx: bigint
    endBlock: bigint
    /** True only while the window is still open. */
    active: boolean
  }
  /**
   * Who the locker pays this launch's V3 position fees to.
   *
   * The creator's declared redirect, or the deployer when there is none — the
   * locker resolves the zero address that way and so must anything reporting
   * it, or a launch with no redirect reads as paying nobody.
   */
  feeRecipient: Address
  /** Protocol's cut of each fee collection, as a **percent**, not bps. */
  protocolFeeSharePercent: bigint
}

/**
 * Read everything about one V1 launch.
 *
 * Two aggregated calls: the record has to come back before the pool's address
 * is known, and everything else rides in one multicall after it.
 */
export async function readV1Launch(client: PublicClient, token: Address): Promise<V1Launch> {
  const record = await client.readContract({
    address: addresses.v1Factory,
    abi: v1FactoryAbi,
    functionName: 'getLaunchedToken',
    args: [token],
  })
  if (!record.exists) {
    throw new PonsError('TOKEN_NOT_FOUND', `${token} is not a Pons V1 launch`, {
      exitCode: ExitCode.Usage,
      details: { token },
      hint: 'the address may be a V2 launch, or not a Pons token at all',
    })
  }

  const pool = await poolFor(client, record.token, record.pairedToken, record.poolFee)
  const blockNumber = await client.getBlockNumber()

  const [
    name,
    symbol,
    decimals,
    totalSupply,
    pairSymbol,
    pairDecimals,
    status,
    maxWallet,
    maxTx,
    endBlock,
    redirect,
    protocolShare,
  ] = await client.multicall({
      contracts: [
        { address: token, abi: erc20Abi, functionName: 'name' },
        { address: token, abi: erc20Abi, functionName: 'symbol' },
        { address: token, abi: erc20Abi, functionName: 'decimals' },
        { address: token, abi: erc20Abi, functionName: 'totalSupply' },
        { address: record.pairedToken, abi: erc20Abi, functionName: 'symbol' },
        { address: record.pairedToken, abi: erc20Abi, functionName: 'decimals' },
        { address: addresses.v1Factory, abi: v1FactoryAbi, functionName: 'graduationStatus', args: [token] },
        { address: token, abi: v1TokenAbi, functionName: 'maxWalletLimit' },
        { address: token, abi: v1TokenAbi, functionName: 'maxTxLimit' },
        { address: token, abi: v1TokenAbi, functionName: 'restrictionEndBlock' },
        { address: addresses.v1Locker, abi: v1LockerAbi, functionName: 'feeRedirects', args: [token] },
        {
          address: addresses.v1Locker,
          abi: v1LockerAbi,
          functionName: 'tokenProtocolFeeShares',
          args: [token],
        },
      ],
      allowFailure: false,
    })

  const poolState = await readV3Pool(client, pool)

  return {
    token: record.token,
    pool,
    deployer: record.deployer,
    pairToken: record.pairedToken,
    positionManager: record.positionManager,
    positionId: record.positionId,
    dexId: record.dexId,
    launchConfigId: record.launchConfigId,
    poolFee: record.poolFee,
    isToken0: record.isToken0,
    metadata: { name, symbol, decimals, totalSupply },
    pair: { address: record.pairedToken, symbol: pairSymbol, decimals: pairDecimals },
    poolState,
    graduation: { raised: status[0], threshold: status[1], graduated: status[2] },
    restrictions: {
      maxWallet,
      maxTx,
      endBlock,
      active: blockNumber <= endBlock,
    },
    feeRecipient: redirect === ZERO_ADDRESS ? record.deployer : redirect,
    protocolFeeSharePercent: protocolShare,
  }
}

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/**
 * The pool a launch trades in.
 *
 * Asked of the V3 factory rather than computed. Computing it needs the pool
 * init-code hash, and this chain's V3 factory is a local deployment that is
 * verified nowhere — so the hash would be an assumption, while `getPool` is
 * the factory's own answer.
 */
async function poolFor(
  client: PublicClient,
  token: Address,
  pairToken: Address,
  fee: number,
): Promise<Address> {
  const pool: Address = await client.readContract({
    address: addresses.v3Factory,
    abi: V3_FACTORY_ABI,
    functionName: 'getPool',
    args: [token, pairToken, fee],
  })
  if (pool === ZERO_ADDRESS) {
    throw new PonsError('NO_POOL', 'the factory records this launch but its pool does not exist', {
      exitCode: ExitCode.Network,
      details: { token, pairToken, fee },
    })
  }
  return pool
}

/**
 * `getPool`, and nothing else.
 *
 * Robinhood's Uniswap V3 factory is a chain-local deployment verified on
 * neither Sourcify nor Blockscout, so there is no ABI to generate. One
 * function of the canonical, unchanged V3 interface is written out here rather
 * than pretending the whole contract has provenance it does not have.
 */
const V3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

/** Spot price of one whole token, in the pair asset's base units. */
export function spotPrice(launch: V1Launch): bigint {
  return spotPriceFrom(launch.poolState.sqrtPriceX96, launch.isToken0, launch.metadata.decimals)
}

/** Fully diluted value, in the pair asset's base units. */
export function marketCap(launch: V1Launch): bigint {
  const price = spotPrice(launch)
  return (price * launch.metadata.totalSupply) / 10n ** BigInt(launch.metadata.decimals)
}

/** How far the launch is towards its graduation threshold, in basis points. */
export function graduationProgress(launch: V1Launch): bigint {
  const { raised, threshold } = launch.graduation
  if (threshold === 0n) return 0n
  return (raised * 10_000n) / threshold
}
