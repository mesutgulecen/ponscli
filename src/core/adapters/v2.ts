import { erc20Abi, getAddress, type Address, type PublicClient } from 'viem'

import { v2CurveAbi, v2FactoryAbi } from '../../abi/index.js'
import { NATIVE_PAIR_TOKEN, addresses } from '../../chain/addresses.js'
import { ExitCode, PonsError } from '../../errors.js'

/**
 * V2 read path: the bonding curve and the factory's record of a launch.
 *
 * Everything here is a read. Nothing in this module signs, and nothing decides
 * what to print; it returns the launch's state and lets a command render it.
 */

/**
 * An address the curve will never have exempted from the snipe tax.
 *
 * `exemptFromSnipeTax` is only ever called by the factory, for the creator,
 * their fee recipient and whatever addresses the launch declared, so the zero
 * address answers for an arbitrary buyer.
 */
const STRANGER: Address = '0x0000000000000000000000000000000000000000'

/** `enum GraduationPhase` in `ILaunchpadV2.sol`, in declaration order. */
export const GRADUATION_PHASES = ['NotGraduated', 'Swept', 'PoolCreated', 'Rescued'] as const

export type GraduationPhase = (typeof GRADUATION_PHASES)[number]

export interface QuoteAsset {
  address: Address
  /** True for the native asset, which the protocol writes as the zero address. */
  native: boolean
  symbol: string
  decimals: number
}

export interface V2Launch {
  token: Address
  curve: Address
  /** Current creator fee recipient. The factory renames this on transfer. */
  creatorFeeRecipient: Address
  deployer: Address
  phase: GraduationPhase
  quote: QuoteAsset
  metadata: { name: string; symbol: string; decimals: number; totalSupply: bigint }
  reserves: {
    /** Tradeable quote reserve, including the phantom (virtual) part. */
    quote: bigint
    /** Quote the curve physically holds, net of fees pending sweep. */
    realQuote: bigint
    /** Virtual quote liquidity the curve was seeded with. */
    phantomQuote: bigint
    token: bigint
    /** Tokens still buyable before the curve stops selling. */
    sellable: bigint
    /** Tokens held back to seed the graduated pool. */
    reserved: bigint
  }
  graduation: { threshold: bigint; ready: boolean; graduated: boolean }
  snipeTax: {
    startBps: bigint
    windowSeconds: bigint
    /** What a non-exempt buyer would pay right now, per the curve itself. */
    currentBps: bigint
  }
  fees: {
    /** Curve trade fee, charged on the quote leg. */
    curveFeeBps: bigint
    creatorTaxBps: bigint
    /** Snapshotted at launch, not the hook's current global policy. */
    protocolFeeShareBps: number
    buybackBurnBps: number
    hookFeeBps: number
    maxInternalPriceImpactBps: number
  }
  buyback: { enabled: boolean; quoteBalance: bigint }
  /** Charged but not yet swept. Excluded from the tradeable reserves. */
  pending: { quoteFees: bigint; creatorTax: bigint }
  launchedAt: bigint
  swept: { quote: bigint; tokens: bigint; at: bigint }
}

/**
 * Snipe tax in basis points `elapsed` seconds after launch.
 *
 * A copy of `PonsV2BondingCurve.currentSnipeTaxBps` for a non-exempt buyer:
 * fourteen halvings spread evenly across the window, in integer arithmetic.
 * The curve's own answer is what gets reported; this exists to project the tax
 * forward to the second a transaction would actually land, which no `eth_call`
 * at the current head can tell us.
 */
export function snipeTaxBpsAt(startBps: bigint, windowSeconds: bigint, elapsed: bigint): bigint {
  if (startBps === 0n || windowSeconds === 0n) return 0n
  if (elapsed >= windowSeconds) return 0n
  if (elapsed < 0n) return startBps
  return startBps >> BigInt((elapsed * 14n) / windowSeconds)
}

/**
 * Spot price of one whole token, in base units of the quote asset.
 *
 * The marginal price off the reserves, before fees, tax and slippage. It is the
 * number to compare two launches with, not the number a trade will clear at;
 * an actual quote comes from the curve's own `getAmountOut`.
 */
export function spotPrice(launch: V2Launch): bigint {
  const { quote, token } = launch.reserves
  if (token === 0n) return 0n
  return (quote * 10n ** BigInt(launch.metadata.decimals)) / token
}

/** Fully diluted value in quote base units, at the spot price. */
export function marketCap(launch: V2Launch): bigint {
  return (spotPrice(launch) * launch.metadata.totalSupply) / 10n ** BigInt(launch.metadata.decimals)
}

/**
 * How far the curve is towards graduation, as a ratio of the real quote
 * reserve to the threshold.
 *
 * Quote-side rather than token-side because that is the number the user is
 * shown everywhere else ("2.1 of 4.2 ETH"). The contract triggers on the token
 * side, but the two are the same point by construction, since the reserved token
 * allocation is derived from this threshold.
 */
export function graduationProgress(launch: V2Launch): { raised: bigint; threshold: bigint } {
  return { raised: launch.reserves.realQuote, threshold: launch.graduation.threshold }
}

function decodePhase(phase: number): GraduationPhase {
  return GRADUATION_PHASES[phase] ?? 'NotGraduated'
}

/** Unwrap one `allowFailure` result, naming the call that failed. */
function required<T>(result: { status: 'success'; result: T } | { status: 'failure' }, label: string): T {
  if (result.status === 'failure') {
    throw new PonsError('READ_FAILED', `the chain did not answer ${label}`, {
      exitCode: ExitCode.Network,
      hint: "run 'pons doctor' to see which endpoints are answering",
    })
  }
  return result.result
}

/**
 * Read a V2 launch in full.
 *
 * Two round trips, not one: the curve's address comes out of the factory's
 * record, so nothing about the curve can be asked for until that returns.
 * Everything after it rides a single Multicall3 aggregate, which is what keeps
 * the reserves, the fee balances and the graduation state on one block, which is a
 * second call could land on an endpoint 24 blocks behind and quietly mix two
 * views of the curve into one report.
 */
export async function readV2Launch(client: PublicClient, token: Address): Promise<V2Launch> {
  const factory = addresses.v2Factory as Address
  const record = await client.readContract({
    address: factory,
    abi: v2FactoryAbi,
    functionName: 'getLaunchedToken',
    args: [token],
  })

  if (!record.exists) {
    throw new PonsError('TOKEN_NOT_FOUND', `${token} is not a Pons V2 launch`, {
      exitCode: ExitCode.Usage,
      details: { token, factory },
      hint: 'check the address; the token may be a V1 launch, which every command detects on its own',
    })
  }

  const curve = record.curve
  const state = await client.multicall({
    contracts: [
      { address: curve, abi: v2CurveAbi, functionName: 'getReserves' },
      { address: curve, abi: v2CurveAbi, functionName: 'realQuoteReserve' },
      { address: curve, abi: v2CurveAbi, functionName: 'phantomQuote' },
      { address: curve, abi: v2CurveAbi, functionName: 'sellableTokens' },
      { address: curve, abi: v2CurveAbi, functionName: 'reservedTokens' },
      { address: curve, abi: v2CurveAbi, functionName: 'readyToGraduate' },
      { address: curve, abi: v2CurveAbi, functionName: 'graduated' },
      { address: curve, abi: v2CurveAbi, functionName: 'launchedAt' },
      { address: curve, abi: v2CurveAbi, functionName: 'snipeTaxStartBps' },
      { address: curve, abi: v2CurveAbi, functionName: 'snipeTaxSeconds' },
      // The zero address is never exempt, so this is the tax a stranger pays.
      // A wallet of the user's own would answer for them specifically; that
      // belongs to the trade path, not to an information command.
      { address: curve, abi: v2CurveAbi, functionName: 'currentSnipeTaxBps', args: [STRANGER] },
      { address: curve, abi: v2CurveAbi, functionName: 'feeBps' },
      { address: curve, abi: v2CurveAbi, functionName: 'creatorTaxBps' },
      { address: curve, abi: v2CurveAbi, functionName: 'buybackEnabled' },
      { address: curve, abi: v2CurveAbi, functionName: 'buybackQuoteBalance' },
      { address: curve, abi: v2CurveAbi, functionName: 'quoteFeeBalance' },
      { address: curve, abi: v2CurveAbi, functionName: 'creatorTaxBalance' },
      { address: token, abi: erc20Abi, functionName: 'name' },
      { address: token, abi: erc20Abi, functionName: 'symbol' },
      { address: token, abi: erc20Abi, functionName: 'decimals' },
      { address: token, abi: erc20Abi, functionName: 'totalSupply' },
      { address: factory, abi: v2FactoryAbi, functionName: 'getLaunchFeePolicy', args: [token] },
    ],
  })

  const [
    reserves,
    realQuote,
    phantomQuote,
    sellable,
    reserved,
    ready,
    graduated,
    launchedAt,
    snipeTaxStartBps,
    snipeTaxSeconds,
    currentSnipeTaxBps,
    curveFeeBps,
    creatorTaxBps,
    buybackEnabled,
    buybackQuoteBalance,
    quoteFeeBalance,
    creatorTaxBalance,
    name,
    symbol,
    decimals,
    totalSupply,
    feePolicy,
  ] = state

  const [quoteReserve, tokenReserve] = required(reserves, 'the curve reserves')
  const policy = required(feePolicy, "the launch's fee policy")
  const quote = await readQuoteAsset(client, record.pairToken)

  return {
    token: getAddress(token),
    curve: getAddress(curve),
    creatorFeeRecipient: record.creatorFeeRecipient,
    deployer: record.deployer,
    phase: decodePhase(record.phase),
    quote,
    metadata: {
      name: required(name, "the token's name"),
      symbol: required(symbol, "the token's symbol"),
      decimals: required(decimals, "the token's decimals"),
      totalSupply: required(totalSupply, "the token's supply"),
    },
    reserves: {
      quote: quoteReserve,
      realQuote: required(realQuote, 'the real quote reserve'),
      phantomQuote: required(phantomQuote, 'the phantom quote reserve'),
      token: tokenReserve,
      sellable: required(sellable, 'the sellable supply'),
      reserved: required(reserved, 'the reserved supply'),
    },
    graduation: {
      threshold: record.graduationThreshold,
      ready: required(ready, 'the graduation check'),
      graduated: required(graduated, 'the graduated flag'),
    },
    snipeTax: {
      startBps: required(snipeTaxStartBps, 'the snipe tax start'),
      windowSeconds: required(snipeTaxSeconds, 'the snipe tax window'),
      currentBps: required(currentSnipeTaxBps, 'the current snipe tax'),
    },
    fees: {
      curveFeeBps: required(curveFeeBps, 'the curve fee'),
      creatorTaxBps: required(creatorTaxBps, 'the creator tax'),
      protocolFeeShareBps: policy.protocolFeeShareBps,
      buybackBurnBps: policy.buybackBurnBps,
      hookFeeBps: policy.hookFeeBps,
      maxInternalPriceImpactBps: policy.maxInternalPriceImpactBps,
    },
    buyback: {
      enabled: required(buybackEnabled, 'the buyback flag'),
      quoteBalance: required(buybackQuoteBalance, 'the buyback balance'),
    },
    pending: {
      quoteFees: required(quoteFeeBalance, 'the pending fees'),
      creatorTax: required(creatorTaxBalance, 'the pending creator tax'),
    },
    launchedAt: required(launchedAt, 'the launch timestamp'),
    swept: { quote: record.sweptQuote, tokens: record.sweptTokens, at: record.sweptAt },
  }
}

/**
 * Resolve the quote asset's symbol and decimals.
 *
 * A separate call from the state read above on purpose: this is immutable
 * metadata, so it cannot go stale between blocks, and keeping it out means the
 * numbers that *can* move still come from a single block. USDG is the reason
 * decimals are read rather than assumed, because it is the one approved pair token
 * that is not 18-decimal.
 */
async function readQuoteAsset(client: PublicClient, pairToken: Address): Promise<QuoteAsset> {
  if (pairToken === NATIVE_PAIR_TOKEN) {
    return { address: NATIVE_PAIR_TOKEN, native: true, symbol: 'ETH', decimals: 18 }
  }
  const [symbol, decimals] = await client.multicall({
    contracts: [
      { address: pairToken, abi: erc20Abi, functionName: 'symbol' },
      { address: pairToken, abi: erc20Abi, functionName: 'decimals' },
    ],
  })
  return {
    address: getAddress(pairToken),
    native: false,
    // A quote asset that will not name itself is still tradeable, so this
    // degrades to the address rather than failing the whole read.
    symbol: symbol.status === 'success' ? symbol.result : pairToken.slice(0, 10),
    decimals: required(decimals, "the quote asset's decimals"),
  }
}

/** One entry of the factory's launch config table. */
export interface LaunchConfig {
  id: number
  supply: bigint
  curveFeeBps: bigint
  /** Virtual quote reserve the curve starts with, in native units. */
  phantomQuote: bigint
  graduationThreshold: bigint
  /** Zero for V2: the graduated pool's fee is dynamic, set by the meme hook. */
  poolFee: number
  tickSpacing: number
  enabled: boolean
}

/** The factory's own settings, all of them owner-mutable and read live. */
export interface FactoryPolicy {
  factory: Address
  launchEnabled: boolean
  launchFee: bigint
  maxCreatorTaxBps: bigint
  snipeTaxStartBps: bigint
  snipeTaxSeconds: bigint
  configs: LaunchConfig[]
}

/**
 * Read the factory's launch policy and every launch config it holds.
 *
 * Nothing here is cached or defaulted. Every one of these values is settable by
 * the owner and at least one of them has already moved away from what the
 * source says: `snipeTaxSeconds` is declared as 15 in the contract and reads 3
 * on chain. A CLI that printed the source's number would be confidently wrong.
 */
export async function readFactoryPolicy(client: PublicClient): Promise<FactoryPolicy> {
  const factory = addresses.v2Factory as Address

  const [launchEnabled, launchFee, maxCreatorTaxBps, snipeTaxStartBps, snipeTaxSeconds, count] =
    await client.multicall({
      contracts: [
        { address: factory, abi: v2FactoryAbi, functionName: 'launchEnabled' },
        { address: factory, abi: v2FactoryAbi, functionName: 'launchFee' },
        { address: factory, abi: v2FactoryAbi, functionName: 'maxCreatorTaxBps' },
        { address: factory, abi: v2FactoryAbi, functionName: 'snipeTaxStartBps' },
        { address: factory, abi: v2FactoryAbi, functionName: 'snipeTaxSeconds' },
        { address: factory, abi: v2FactoryAbi, functionName: 'launchConfigCount' },
      ],
    })

  const total = Number(required(count, 'the launch config count'))
  // A second aggregate rather than one: the count is what says how many
  // configs to ask for, and guessing a range would either miss a new config or
  // spend calls on ids that do not exist.
  const entries = await client.multicall({
    contracts: Array.from({ length: total }, (_, id) => ({
      address: factory,
      abi: v2FactoryAbi,
      functionName: 'getLaunchConfig' as const,
      args: [BigInt(id)] as const,
    })),
  })

  return {
    factory,
    launchEnabled: required(launchEnabled, 'the launch switch'),
    launchFee: required(launchFee, 'the launch fee'),
    maxCreatorTaxBps: required(maxCreatorTaxBps, 'the creator tax ceiling'),
    snipeTaxStartBps: required(snipeTaxStartBps, 'the snipe tax start'),
    snipeTaxSeconds: required(snipeTaxSeconds, 'the snipe tax window'),
    configs: entries.map((entry, id) => {
      const config = required(entry, `launch config ${id.toString()}`)
      return {
        id,
        supply: config.supply,
        curveFeeBps: config.curveFeeBps,
        phantomQuote: config.phantomQuote,
        graduationThreshold: config.graduationThreshold,
        poolFee: config.poolFee,
        tickSpacing: config.tickSpacing,
        enabled: config.enabled,
      }
    }),
  }
}
