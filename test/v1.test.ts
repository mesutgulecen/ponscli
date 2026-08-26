import { afterEach, describe, expect, it } from 'vitest'
import { decodeFunctionData, erc20Abi, numberToHex, type Address } from 'viem'

import { v1FactoryAbi, v1LockerAbi, v1TokenAbi, v2FactoryAbi, v3PoolAbi, v3QuoterAbi, v3SwapRouterAbi } from '../src/abi/index.js'
import { addresses } from '../src/chain/addresses.js'
import { detectGeneration } from '../src/core/adapters/detect.js'
import {
  buildV1LaunchPlan,
  validateV1Launch,
  type V1LaunchContext,
  type V1LaunchIntent,
} from '../src/core/adapters/v1launch.js'
import { ADDRESS_THIS, encodeV3Buy, encodeV3Sell, spotPriceFrom } from '../src/core/routes/v3.js'
import { ExitCode } from '../src/errors.js'
import { run } from '../src/program.js'
import { fakeChain, type Answer } from './fakeChain.js'
import { BufferSink, createTempHome, type TempHome } from './helpers.js'
import { createPublicClient, toFunctionSelector } from 'viem'
import { robinhoodChain } from '../src/chain/definition.js'
import { poolTransport } from '../src/chain/transport.js'

/**
 * The fixture is BANKERS, a real V1 launch read off the chain on 2026-08-25:
 * token `0x9713…C7EC`, pool `0x2D0e…4a7c`, paired against WETH at a 1% fee,
 * with the launch token sorted second.
 */
const TOKEN: Address = '0x97133372cC4391A4F6889b4d52387649B76BC7EC'
const POOL: Address = '0x2D0edeF70886383C395D8207Bf22B8c29c974a7c'
const DEPLOYER: Address = '0x50e037eCC7c2D79b912950102a53377841A67D1D'
const WETH = addresses.weth as Address
const POOL_FEE = 10_000
const MULTICALL_WITH_DEADLINE = toFunctionSelector('multicall(uint256,bytes[])')
const SUPPLY = 1_000_000_000_000_000_000_000_000_000n

describe('V3 encoding', () => {
  const base = {
    token: TOKEN,
    pairToken: WETH,
    fee: POOL_FEE,
    amountIn: 10_000_000_000_000_000n,
    amountOutMinimum: 7_000_000_000_000_000_000_000_000n,
    recipient: DEPLOYER,
    deadline: 1_787_664_165n,
  }

  it('wraps a buy in a deadline-carrying multicall', () => {
    const { functionName, args } = decodeFunctionData({ abi: v3SwapRouterAbi, data: encodeV3Buy(base) })
    expect(functionName).toBe('multicall')
    const [deadline, calls] = args as [bigint, readonly `0x${string}`[]]
    expect(deadline).toBe(base.deadline)
    expect(calls).toHaveLength(1)
  })

  it('pays the buyer directly and pays in WETH', () => {
    const { args } = decodeFunctionData({ abi: v3SwapRouterAbi, data: encodeV3Buy(base) })
    const calls = (args as [bigint, readonly `0x${string}`[]])[1]
    const swap = decodeFunctionData({ abi: v3SwapRouterAbi, data: calls[0] as `0x${string}` })
    const params = (swap.args as readonly unknown[])[0] as { tokenIn: Address; recipient: Address }
    // The router wraps `msg.value` when the token being paid is WETH9, which
    // is why a buy needs no separate wrap call.
    expect(params.tokenIn.toLowerCase()).toBe(WETH.toLowerCase())
    expect(params.recipient).toBe(DEPLOYER)
  })

  it('sells through the router and unwraps in a second call', () => {
    const { args } = decodeFunctionData({ abi: v3SwapRouterAbi, data: encodeV3Sell(base) })
    const calls = (args as [bigint, readonly `0x${string}`[]])[1]
    expect(calls).toHaveLength(2)

    const swap = decodeFunctionData({ abi: v3SwapRouterAbi, data: calls[0] as `0x${string}` })
    const params = (swap.args as readonly unknown[])[0] as { recipient: Address }
    // Paying the seller directly would work and hand them WETH; the output has
    // to stay at the router for `unwrapWETH9` to reach it.
    expect(params.recipient).toBe(ADDRESS_THIS)

    const unwrap = decodeFunctionData({ abi: v3SwapRouterAbi, data: calls[1] as `0x${string}` })
    expect(unwrap.functionName).toBe('unwrapWETH9')
    expect(unwrap.args).toEqual([base.amountOutMinimum, DEPLOYER])
  })

  it('carries the same floor on both legs of a sell', () => {
    const { args } = decodeFunctionData({ abi: v3SwapRouterAbi, data: encodeV3Sell(base) })
    const calls = (args as [bigint, readonly `0x${string}`[]])[1]
    const swap = decodeFunctionData({ abi: v3SwapRouterAbi, data: calls[0] as `0x${string}` })
    const params = (swap.args as readonly unknown[])[0] as { amountOutMinimum: bigint }
    const unwrap = decodeFunctionData({ abi: v3SwapRouterAbi, data: calls[1] as `0x${string}` })
    expect(params.amountOutMinimum).toBe((unwrap.args as readonly bigint[])[0])
  })
})

describe('spotPriceFrom', () => {
  // sqrtPriceX96 read from the BANKERS pool on 2026-08-25, at tick 204054.
  const SQRT = 2_136_225_678_807_995_638_799_767_125_602_415n

  it('inverts the price when the launch token sorted second', () => {
    const asToken1 = spotPriceFrom(SQRT, false, 18)
    const asToken0 = spotPriceFrom(SQRT, true, 18)
    // The pool holds WETH first and BANKERS second, so reading it the wrong
    // way round prices one token at hundreds of millions of WETH.
    expect(asToken1).toBeLessThan(asToken0)
    expect(asToken1).toBeGreaterThan(0n)
  })

  it('answers zero for an uninitialised pool rather than dividing by it', () => {
    expect(spotPriceFrom(0n, true, 18)).toBe(0n)
    expect(spotPriceFrom(0n, false, 18)).toBe(0n)
  })
})

const V1_CONTEXT: V1LaunchContext = {
  launchConfigId: 0n,
  dexId: 0n,
  config: {
    pairToken: WETH,
    graduationThreshold: 4_200_000_000_000_000_000n,
    initialTick: -204_200,
    supply: SUPPLY,
    maxWalletBps: 500,
    maxTxBps: 550,
    restrictionBlocks: 2,
    reservedFee: 0,
    enabled: true,
    routerRequiresDeadline: false,
  },
  dex: {
    name: 'uniswap v3',
    factory: addresses.v3Factory,
    positionManager: addresses.v3PositionManager,
    swapRouter: addresses.v3SwapRouter,
    poolFee: POOL_FEE,
    tickSpacing: 200,
    enabled: true,
  },
  launchFee: 500_000_000_000_000n,
  // Live state is `false`; the tests that are about anything else open it.
  launchEnabled: true,
  whitelisted: false,
}

const V1_INTENT: V1LaunchIntent = {
  params: {
    name: 'Ponscli Probe',
    symbol: 'PROBE',
    logo: '',
    description: '',
    socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
    feeWallet: '0x0000000000000000000000000000000000000000',
  },
  launchConfigId: 0n,
  dexId: 0n,
  salt: `0x${'11'.repeat(32)}`,
  devBuy: 0n,
}

describe('V1 launch', () => {
  it('refuses when the factory is closed and the address is not whitelisted', () => {
    // The live condition: `launchEnabled()` went false on 2026-08-12 and no
    // address has ever been whitelisted.
    const closed = { ...V1_CONTEXT, launchEnabled: false, whitelisted: false }
    expect(() => validateV1Launch(V1_INTENT, closed)).toThrow(/closed to new launches/)
  })

  it('allows a whitelisted address through a closed factory', () => {
    const closed = { ...V1_CONTEXT, launchEnabled: false, whitelisted: true }
    expect(() => validateV1Launch(V1_INTENT, closed)).not.toThrow()
  })

  it('refuses a disabled dex', () => {
    const disabled = { ...V1_CONTEXT, dex: { ...V1_CONTEXT.dex, enabled: false } }
    expect(() => validateV1Launch(V1_INTENT, disabled)).toThrow(/dex 0 \(uniswap v3\) is disabled/)
  })

  it('folds the opening buy into the value, unlike V2', () => {
    const plan = buildV1LaunchPlan({ ...V1_INTENT, devBuy: 50_000_000_000_000_000n }, V1_CONTEXT)
    // V1 checks `msg.value >= launchFee` and spends the excess on the buy; V2
    // checks equality and needs a separate router for the same thing.
    expect(plan.value).toBe(V1_CONTEXT.launchFee + 50_000_000_000_000_000n)
    expect(plan.to).toBe(addresses.v1Factory)
  })

  it('sends only the fee when there is no opening buy', () => {
    expect(buildV1LaunchPlan(V1_INTENT, V1_CONTEXT).value).toBe(V1_CONTEXT.launchFee)
  })

  it('warns that the factory sets no floor on its own opening buy', () => {
    const plan = buildV1LaunchPlan({ ...V1_INTENT, devBuy: 1n }, V1_CONTEXT)
    expect(plan.warnings.map((warning) => warning.code)).toContain('unbounded-dev-buy')
  })
})

/** The registry answers both factories give for one token. */
function registryAnswers(options: { v1: boolean; v2: boolean }): Answer[] {
  return [
    {
      address: addresses.v2Factory,
      abi: v2FactoryAbi,
      functionName: 'getLaunchedToken',
      args: [TOKEN],
      result: {
        token: options.v2 ? TOKEN : '0x0000000000000000000000000000000000000000',
        curve: '0x00000000000000000000000000000000000000c0',
        deployer: DEPLOYER,
        creatorFeeRecipient: DEPLOYER,
        pairToken: '0x0000000000000000000000000000000000000000',
        graduationThreshold: 0n,
        poolFee: 0,
        tickSpacing: 200,
        creatorTaxBps: 0,
        buybackEnabled: false,
        phase: 0,
        sweptQuote: 0n,
        sweptTokens: 0n,
        sweptAt: 0n,
        exists: options.v2,
      },
    },
    {
      address: addresses.v1Factory,
      abi: v1FactoryAbi,
      functionName: 'getLaunchedToken',
      args: [TOKEN],
      result: {
        token: options.v1 ? TOKEN : '0x0000000000000000000000000000000000000000',
        deployer: DEPLOYER,
        pairedToken: WETH,
        positionManager: addresses.v3PositionManager,
        positionId: 673_450n,
        dexId: 0n,
        launchConfigId: 0n,
        restrictionsEndBlock: 25_741_081n,
        supply: SUPPLY,
        isToken0: false,
        poolFee: POOL_FEE,
        exists: options.v1,
        initialBuyAmount: 0n,
      },
    },
  ]
}

function v1Answers(): Answer[] {
  return [
    ...registryAnswers({ v1: true, v2: false }),
    {
      address: addresses.v3Factory,
      abi: [
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
      ],
      functionName: 'getPool',
      args: [TOKEN, WETH, POOL_FEE],
      result: POOL,
    },
    { address: TOKEN, abi: erc20Abi, functionName: 'name', result: 'Stonkbankers' },
    { address: TOKEN, abi: erc20Abi, functionName: 'symbol', result: 'BANKERS' },
    { address: TOKEN, abi: erc20Abi, functionName: 'decimals', result: 18 },
    { address: TOKEN, abi: erc20Abi, functionName: 'totalSupply', result: SUPPLY },
    { address: WETH, abi: erc20Abi, functionName: 'symbol', result: 'WETH' },
    { address: WETH, abi: erc20Abi, functionName: 'decimals', result: 18 },
    {
      address: addresses.v1Factory,
      abi: v1FactoryAbi,
      functionName: 'graduationStatus',
      args: [TOKEN],
      result: [9_891_856_272_012_982n, 4_200_000_000_000_000_000n, false],
    },
    { address: TOKEN, abi: v1TokenAbi, functionName: 'maxWalletLimit', result: 50_000_000_000_000_000_000_000_000n },
    { address: TOKEN, abi: v1TokenAbi, functionName: 'maxTxLimit', result: 55_000_000_000_000_000_000_000_000n },
    { address: TOKEN, abi: v1TokenAbi, functionName: 'restrictionEndBlock', result: 25_741_081n },
    { address: addresses.v1Locker, abi: v1LockerAbi, functionName: 'feeRedirects', args: [TOKEN], result: DEPLOYER },
    { address: addresses.v1Locker, abi: v1LockerAbi, functionName: 'tokenProtocolFeeShares', args: [TOKEN], result: 30n },
    {
      address: POOL,
      abi: v3PoolAbi,
      functionName: 'slot0',
      result: [2_136_225_678_807_995_638_799_767_125_602_415n, 204_054, 0, 1, 1, 0, true],
    },
    { address: POOL, abi: v3PoolAbi, functionName: 'liquidity', result: 36_819_258_015_569_838_458_222n },
    { address: POOL, abi: v3PoolAbi, functionName: 'token0', result: WETH },
    { address: POOL, abi: v3PoolAbi, functionName: 'token1', result: TOKEN },
    { address: POOL, abi: v3PoolAbi, functionName: 'fee', result: POOL_FEE },
    {
      address: addresses.v3Quoter,
      abi: v3QuoterAbi,
      functionName: 'quoteExactInputSingle',
      anyArgs: true,
      result: [7_145_507_636_358_008_789_634_327n, 2_100_000_000_000_000_000_000_000_000_000_000n, 1, 94_249n],
    },
    {
      address: TOKEN,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [DEPLOYER, addresses.v3SwapRouter],
      result: 0n,
    },
  ]
}

describe('detectGeneration', () => {
  /**
   * A client that answers from the fixture, through the same pool transport the
   * CLI builds. Going through the transport rather than stubbing the client
   * keeps viem's Multicall3 aggregation in the test, which is what
   * `detectGeneration` relies on to ask both factories at once.
   */
  function client(options: { v1: boolean; v2: boolean }): Parameters<typeof detectGeneration>[0] {
    const dispatch = fakeChain({ answers: registryAnswers(options) })
    const pool = {
      send: (method: string, params: unknown[]) => dispatch({ url: 'test' } as never, method, params),
    } as unknown as Parameters<typeof poolTransport>[0]
    return createPublicClient({
      chain: robinhoodChain,
      transport: poolTransport(pool),
      batch: { multicall: true },
    })
  }

  it('names a V2 launch', async () => {
    await expect(detectGeneration(client({ v1: false, v2: true }), TOKEN)).resolves.toMatchObject({
      generation: 'v2',
    })
  })

  it('names a V1 launch', async () => {
    await expect(detectGeneration(client({ v1: true, v2: false }), TOKEN)).resolves.toMatchObject({
      generation: 'v1',
    })
  })

  it('refuses a token neither factory launched', async () => {
    await expect(detectGeneration(client({ v1: false, v2: false }), TOKEN)).rejects.toThrow(
      /not registered with either Pons factory/,
    )
  })
})

describe('pons commands on a V1 token', () => {
  let home: TempHome

  afterEach(() => {
    home.cleanup()
  })

  async function invoke(argv: string[]): Promise<{ code: number; stdout: BufferSink; stderr: BufferSink }> {
    home = createTempHome()
    const stdout = new BufferSink()
    const stderr = new BufferSink()
    const code = await run({
      argv,
      env: home.env,
      home: home.home,
      isTTY: false,
      stdout,
      stderr,
      dispatch: fakeChain({
        answers: v1Answers(),
        succeed: [
          // `multicall` is overloaded three ways; the deadline-carrying one is
          // what the encoder builds.
          { address: addresses.v3SwapRouter, selector: MULTICALL_WITH_DEADLINE },
          { address: TOKEN, abi: erc20Abi, functionName: 'approve' },
          { address: addresses.v1Locker, abi: v1LockerAbi, functionName: 'collectFees' },
        ],
        methods: {
          eth_blockNumber: numberToHex(45_750_188),
          eth_getBlockByNumber: {
            number: numberToHex(45_750_188),
            hash: `0x${'11'.repeat(32)}`,
            parentHash: `0x${'22'.repeat(32)}`,
            timestamp: numberToHex(1_787_664_165),
            gasLimit: numberToHex(0),
            gasUsed: numberToHex(0),
            transactions: [],
            uncles: [],
          },
        },
      }),
    })
    return { code, stdout, stderr }
  }

  it('reads a V1 launch through its own shape', async () => {
    const { code, stdout } = await invoke(['info', TOKEN, '--json'])
    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<{ generation: string; pool: Address; poolFee: number }>()
    expect(payload.generation).toBe('v1')
    expect(payload.pool).toBe(POOL)
    expect(payload.poolFee).toBe(POOL_FEE)
  })

  it('reports the restriction window as closed', async () => {
    const { stdout } = await invoke(['info', TOKEN, '--json'])
    // Two blocks after deployment, twenty million blocks ago.
    expect(stdout.json<{ restrictions: { active: boolean } }>().restrictions.active).toBe(false)
  })

  it('routes a buy to the V3 router with the value attached', async () => {
    const { code, stdout } = await invoke(['buy', TOKEN, '0.01', '--from', DEPLOYER, '--json'])
    expect(code).toBe(ExitCode.Ok)
    const { plan } = stdout.json<{ plan: { to: Address; route: string; value: string } }>()
    expect(plan.route).toBe('v3')
    expect(plan.to).toBe(addresses.v3SwapRouter)
    expect(plan.value).toBe('10000000000000000')
  })

  it('adds the router approval a sell needs', async () => {
    const { stdout } = await invoke(['sell', TOKEN, '1000000', '--from', DEPLOYER, '--json'])
    const payload = stdout.json<{ prerequisites: { to: Address; kind: string }[] }>()
    // Without it the swap reverts with Uniswap's `STF`, which explains nothing.
    expect(payload.prerequisites).toHaveLength(1)
    expect(payload.prerequisites[0]?.kind).toBe('approve')
    expect(payload.prerequisites[0]?.to).toBe(TOKEN)
  })

  it('refuses a venue this token does not trade on', async () => {
    const { code, stderr } = await invoke(['buy', TOKEN, '0.01', '--route', 'v4', '--from', DEPLOYER, '--json'])
    expect(code).toBe(ExitCode.Usage)
    expect(stderr.text).toMatch(/trades on Uniswap V3, not v4/)
  })

  it('sends a collect to the locker, not the escrow', async () => {
    const { code, stdout } = await invoke(['collect', TOKEN, '--from', DEPLOYER, '--json'])
    expect(code).toBe(ExitCode.Ok)
    expect(stdout.json<{ plan: { to: Address } }>().plan.to).toBe(addresses.v1Locker)
  })
})
