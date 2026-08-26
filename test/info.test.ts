import { afterEach, describe, expect, it } from 'vitest'
import { erc20Abi, numberToHex, type Address } from 'viem'

import { v2CurveAbi, v2FactoryAbi } from '../src/abi/index.js'
import { addresses } from '../src/chain/addresses.js'
import { ExitCode } from '../src/errors.js'
import { run } from '../src/program.js'
import type { Dispatch } from '../src/chain/pool.js'
import { fakeChain, type Answer } from './fakeChain.js'
import { BufferSink, createTempHome, type TempHome } from './helpers.js'

/**
 * The fixture is a real launch, read off the chain on 2026-08-25: token
 * `0x44D6…20f4`, quoted in native ETH, minutes old, one dev buy against it.
 */
const TOKEN: Address = '0x44D6736eB4Bc60c17Fe8220062d8fdE3C28920f4'
const CURVE: Address = '0x60CeF8379Aa278F087074bC60595778985c1bD8E'
const DEPLOYER: Address = '0xCAefbb5e99d0c48a7Aa49936662b174a3c2eaD61'
const NATIVE: Address = '0x0000000000000000000000000000000000000000'
const FACTORY = addresses.v2Factory as Address

const LAUNCHED_AT = 1_787_654_670n
const NOW = LAUNCHED_AT + 684n

interface LaunchOverrides {
  phase?: number
  sweptQuote?: bigint
  sweptTokens?: bigint
  sweptAt?: bigint
  exists?: boolean
}

function launchRecord(overrides: LaunchOverrides = {}): Record<string, unknown> {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: DEPLOYER,
    creatorFeeRecipient: DEPLOYER,
    pairToken: NATIVE,
    graduationThreshold: 4_200_000_000_000_000_000n,
    poolFee: 0,
    tickSpacing: 200,
    creatorTaxBps: 0,
    buybackEnabled: false,
    phase: overrides.phase ?? 0,
    sweptQuote: overrides.sweptQuote ?? 0n,
    sweptTokens: overrides.sweptTokens ?? 0n,
    sweptAt: overrides.sweptAt ?? 0n,
    exists: overrides.exists ?? true,
  }
}

interface CurveOverrides {
  quoteReserve?: bigint
  tokenReserve?: bigint
  realQuote?: bigint
  sellable?: bigint
  ready?: boolean
  graduated?: boolean
  currentSnipeTaxBps?: bigint
}

function chainFor(
  launch: Record<string, unknown>,
  curve: CurveOverrides = {},
): Dispatch {
  const answers: Answer[] = [
    { address: FACTORY, abi: v2FactoryAbi, functionName: 'getLaunchedToken', args: [TOKEN], result: launch },
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'getLaunchFeePolicy',
      args: [TOKEN],
      result: {
        protocolFeeRecipient: '0xFdDE5a1E3cDF791Da71E49F817D70C7ceD72CC36',
        protocolFeeShareBps: 3000,
        buybackBurnBps: 5000,
        hookFeeBps: 100,
        maxInternalPriceImpactBps: 300,
      },
    },
    {
      address: CURVE,
      abi: v2CurveAbi,
      functionName: 'getReserves',
      result: [
        curve.quoteReserve ?? 1_680_000_000_000_000_001n,
        curve.tokenReserve ?? 10n ** 27n,
      ],
    },
    { address: CURVE, abi: v2CurveAbi, functionName: 'realQuoteReserve', result: curve.realQuote ?? 1n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'phantomQuote', result: 1_680_000_000_000_000_000n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'sellableTokens', result: curve.sellable ?? 714_285_714_285_714_285_714_285_715n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'reservedTokens', result: 285_714_285_714_285_714_285_714_285n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'readyToGraduate', result: curve.ready ?? false },
    { address: CURVE, abi: v2CurveAbi, functionName: 'graduated', result: curve.graduated ?? false },
    { address: CURVE, abi: v2CurveAbi, functionName: 'launchedAt', result: LAUNCHED_AT },
    { address: CURVE, abi: v2CurveAbi, functionName: 'snipeTaxStartBps', result: 9900n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'snipeTaxSeconds', result: 3n },
    {
      address: CURVE,
      abi: v2CurveAbi,
      functionName: 'currentSnipeTaxBps',
      args: [NATIVE],
      result: curve.currentSnipeTaxBps ?? 0n,
    },
    { address: CURVE, abi: v2CurveAbi, functionName: 'feeBps', result: 100n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'creatorTaxBps', result: 0n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'buybackEnabled', result: false },
    { address: CURVE, abi: v2CurveAbi, functionName: 'buybackQuoteBalance', result: 0n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'quoteFeeBalance', result: 99_499_999_999_999n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'creatorTaxBalance', result: 0n },
    { address: TOKEN, abi: erc20Abi, functionName: 'name', result: '蛋猫' },
    { address: TOKEN, abi: erc20Abi, functionName: 'symbol', result: 'Danmao' },
    { address: TOKEN, abi: erc20Abi, functionName: 'decimals', result: 18 },
    { address: TOKEN, abi: erc20Abi, functionName: 'totalSupply', result: 10n ** 27n },
  ]

  return fakeChain({
    answers,
    methods: {
      eth_getBlockByNumber: {
        number: numberToHex(45_676_251),
        hash: `0x${'11'.repeat(32)}`,
        parentHash: `0x${'22'.repeat(32)}`,
        timestamp: numberToHex(NOW),
        gasLimit: numberToHex(0),
        gasUsed: numberToHex(0),
        transactions: [],
        uncles: [],
      },
    },
  })
}

let temp: TempHome | undefined

afterEach(() => {
  temp?.cleanup()
  temp = undefined
})

interface Invocation {
  code: number
  stdout: BufferSink
  stderr: BufferSink
}

async function invoke(argv: string[], dispatch: Dispatch): Promise<Invocation> {
  temp ??= createTempHome()
  const stdout = new BufferSink()
  const stderr = new BufferSink()
  const code = await run({
    argv,
    env: temp.env,
    home: temp.home,
    isTTY: false,
    stdout,
    stderr,
    dispatch,
  })
  return { code, stdout, stderr }
}

interface InfoPayload {
  symbol: string
  name: string
  phase: string
  price: string | null
  marketCap: string | null
  quote: { symbol: string; decimals: number; native: boolean }
  graduation: { raised: string; threshold: string; ready: boolean }
  snipeTax: { currentBps: number; startBps: number; windowSeconds: number }
  reserves: { quote: string; sellable: string }
}

describe('pons info', () => {
  it('reports the launch as the chain has it', async () => {
    const { code, stdout } = await invoke(['info', TOKEN, '--json'], chainFor(launchRecord()))
    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<InfoPayload>()
    expect(payload.name).toBe('蛋猫')
    expect(payload.symbol).toBe('Danmao')
    expect(payload.phase).toBe('NotGraduated')
    expect(payload.quote).toEqual({
      address: NATIVE,
      native: true,
      symbol: 'ETH',
      decimals: 18,
    })
    // Spot price: the quote reserve, phantom included, over the token reserve.
    expect(payload.price).toBe('1680000000')
    expect(payload.graduation.threshold).toBe('4200000000000000000')
    expect(payload.snipeTax).toEqual({ currentBps: 0, startBps: 9900, windowSeconds: 3 })
  })

  it('renders base units as scaled amounts for a human', async () => {
    const { stdout } = await invoke(['info', TOKEN, '--human'], chainFor(launchRecord()))
    expect(stdout.text).toContain('1,000,000,000 Danmao')
    expect(stdout.text).toContain('0.00000000168 ETH')
    expect(stdout.text).toContain('4.2 ETH')
  })

  it('warns that a curve at its threshold will refuse a sell', async () => {
    // The curve's `sell()` reverts once `readyToGraduate()` is true. Surfacing
    // that here is the difference between a redirect and a raw revert later.
    const { stdout } = await invoke(
      ['info', TOKEN, '--human'],
      chainFor(launchRecord(), { ready: true, sellable: 0n }),
    )
    expect(stdout.text).toContain('ready to graduate')
    expect(stdout.text).toMatch(/pons graduate/)
  })

  it('does not price a graduated token off the drained curve', async () => {
    // After graduation the curve holds only its phantom reserve, so every
    // number it would price with is zero. Reporting null says so.
    const { stdout } = await invoke(
      ['info', TOKEN, '--json'],
      chainFor(launchRecord({ phase: 2 }), { graduated: true, tokenReserve: 0n, sellable: 0n }),
    )
    const payload = stdout.json<InfoPayload>()
    expect(payload.phase).toBe('PoolCreated')
    expect(payload.price).toBeNull()
    expect(payload.marketCap).toBeNull()
  })

  it('names the token that neither factory launched', async () => {
    const { code, stderr } = await invoke(
      ['info', TOKEN, '--json'],
      chainFor(launchRecord({ exists: false })),
    )
    // A bad argument, not a failure: the address is simply not a Pons launch,
    // which is the user's to fix.
    expect(code).toBe(ExitCode.Usage)
    const error = stderr.json<{ error: { code: string; hint: string } }>()
    expect(error.error.code).toBe('TOKEN_NOT_FOUND')
    expect(error.error.hint).toMatch(/not a Pons launch/)
  })

  it('rejects an argument that is not an address', async () => {
    const { code, stderr } = await invoke(['info', 'not-a-token', '--json'], chainFor(launchRecord()))
    expect(code).toBe(ExitCode.Usage)
    expect(stderr.json<{ error: { code: string } }>().error.code).toBe('USAGE')
  })
})
