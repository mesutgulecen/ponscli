import { afterEach, describe, expect, it } from 'vitest'
import { erc20Abi, numberToHex, pad, toEventSelector, type Address } from 'viem'

import { v2FactoryAbi } from '../src/abi/index.js'
import { addresses } from '../src/chain/addresses.js'
import { resolvePairToken, type PairToken } from '../src/core/pairs.js'
import { ExitCode } from '../src/errors.js'
import { run } from '../src/program.js'
import { fakeChain, type Answer, type FakeLog } from './fakeChain.js'
import { BufferSink, createTempHome, type TempHome } from './helpers.js'

/**
 * The fixture is the live list in miniature, with the one shape that matters
 * kept: a token approved early, a six-decimal one, and one approved and then
 * revoked. RIVN is the real case — approved, then removed — and the reason the
 * fold has to be confirmed against the mapping rather than trusted.
 */
const FACTORY = addresses.v2Factory as Address
const NVDA: Address = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'
const USDG: Address = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const RIVN: Address = '0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114b'

const APPROVAL_TOPIC = toEventSelector('PairTokenApprovalUpdated(address,bool)')
const HEAD = 45_676_251

function approval(token: Address, approved: boolean, blockNumber: number): FakeLog {
  return {
    address: FACTORY,
    topics: [APPROVAL_TOPIC, pad(token, { size: 32 })],
    data: numberToHex(approved ? 1 : 0, { size: 32 }),
    blockNumber,
  }
}

/** The approval order is deliberately not alphabetical: it is the render order. */
const LOGS: FakeLog[] = [
  approval(NVDA, true, 26_841_846),
  approval(USDG, true, 26_841_867),
  approval(RIVN, true, 30_575_223),
  approval(RIVN, false, 35_992_050),
]

function metadata(token: Address, symbol: string, name: string, decimals: number): Answer[] {
  return [
    { address: token, abi: erc20Abi, functionName: 'symbol', result: symbol },
    { address: token, abi: erc20Abi, functionName: 'name', result: name },
    { address: token, abi: erc20Abi, functionName: 'decimals', result: decimals },
  ]
}

interface Overrides {
  /** Lets a test make the mapping disagree with the events. */
  approved?: Partial<Record<Address, boolean>>
}

function answers(overrides: Overrides = {}): Answer[] {
  const approvedOf = (token: Address, fallback: boolean): boolean =>
    overrides.approved?.[token] ?? fallback

  return [
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'getLaunchConfig',
      args: [0n],
      result: {
        supply: 1_000_000_000_000_000_000_000_000_000n,
        curveFeeBps: 100n,
        phantomQuote: 1_680_000_000_000_000_000n,
        graduationThreshold: 4_200_000_000_000_000_000n,
        poolFee: 0,
        tickSpacing: 200,
        enabled: true,
      },
    },
    ...([
      [NVDA, true],
      [USDG, true],
      [RIVN, false],
    ] as const).map(([token, live]) => ({
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'approvedPairTokens',
      args: [token],
      result: approvedOf(token, live),
    })),
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'pairTokenEconomics',
      args: [NVDA],
      result: [16_640_000_000_000_000_000n, 41_600_000_000_000_000_000n, 18],
    },
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'pairTokenEconomics',
      args: [USDG],
      result: [3_236_000_000n, 8_090_000_000n, 6],
    },
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'pairTokenEconomics',
      args: [RIVN],
      result: [209_300_000_000_000_000_000n, 523_300_000_000_000_000_000n, 18],
    },
    ...metadata(NVDA, 'NVDA', 'NVIDIA', 18),
    ...metadata(USDG, 'USDG', 'Global Dollar', 6),
    ...metadata(RIVN, 'RIVN', 'Rivian', 18),
  ]
}

interface PairsPayload {
  count: number
  pairs: { symbol: string; address: Address; decimals: number; native: boolean }[]
}

describe('pons pairs', () => {
  let home: TempHome

  afterEach(() => {
    home.cleanup()
  })

  async function invoke(overrides: Overrides = {}, argv: string[] = []): Promise<{
    code: number
    stdout: BufferSink
  }> {
    home = createTempHome()
    const stdout = new BufferSink()
    const code = await run({
      argv: ['pairs', '--json', ...argv],
      env: home.env,
      home: home.home,
      isTTY: false,
      stdout,
      stderr: new BufferSink(),
      dispatch: fakeChain({
        answers: answers(overrides),
        logs: LOGS,
        methods: { eth_blockNumber: numberToHex(HEAD) },
      }),
    })
    return { code, stdout }
  }

  it('lists native ETH first, then the approved assets in approval order', async () => {
    const { code, stdout } = await invoke()
    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<PairsPayload>()
    expect(payload.pairs.map((pair) => pair.symbol)).toEqual(['ETH', 'NVDA', 'USDG'])
    expect(payload.pairs[0]?.native).toBe(true)
  })

  it('drops an asset whose approval was revoked', async () => {
    const { stdout } = await invoke()
    expect(stdout.json<PairsPayload>().pairs.map((pair) => pair.symbol)).not.toContain('RIVN')
  })

  it('believes the mapping over the events', async () => {
    // The events say NVDA is approved; the contract says otherwise. Replaying
    // logs is a reconstruction, and the mapping is the thing being
    // reconstructed — so the mapping wins.
    const { stdout } = await invoke({ approved: { [NVDA]: false } })
    expect(stdout.json<PairsPayload>().pairs.map((pair) => pair.symbol)).toEqual(['ETH', 'USDG'])
  })

  it('keeps USDG at six decimals', async () => {
    const { stdout } = await invoke()
    const usdg = stdout.json<PairsPayload>().pairs.find((pair) => pair.symbol === 'USDG')
    // A wei-denominated phantom reserve on this asset would misprice the curve
    // by twelve orders of magnitude, so the scale has to survive the round trip.
    expect(usdg?.decimals).toBe(6)
  })

  it('takes the native row from the launch config, not the economics mapping', async () => {
    const { stdout } = await invoke()
    const payload = stdout.json<{
      pairs: { symbol: string; phantomQuote: string; graduationThreshold: string }[]
    }>()
    const eth = payload.pairs.find((pair) => pair.symbol === 'ETH')
    // `pairTokenEconomics(address(0))` returns zeros; reading it and believing
    // the answer would report a graduation threshold of nothing.
    expect(eth?.phantomQuote).toBe('1680000000000000000')
    expect(eth?.graduationThreshold).toBe('4200000000000000000')
  })
})

describe('resolvePairToken', () => {
  const tokens: PairToken[] = [
    {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'ETH',
      name: 'Native ETH',
      decimals: 18,
      native: true,
      phantomQuote: 1n,
      graduationThreshold: 2n,
      expectedDecimals: 18,
      approvedAtBlock: 0n,
    },
    {
      address: NVDA,
      symbol: 'NVDA',
      name: 'NVIDIA',
      decimals: 18,
      native: false,
      phantomQuote: 1n,
      graduationThreshold: 2n,
      expectedDecimals: 18,
      approvedAtBlock: 1n,
    },
  ]

  it('matches a symbol case-insensitively', () => {
    expect(resolvePairToken(tokens, 'nvda').address).toBe(NVDA)
  })

  it('accepts an address that is on the list', () => {
    expect(resolvePairToken(tokens, NVDA.toUpperCase().replace('0X', '0x')).symbol).toBe('NVDA')
  })

  it('refuses an address that is not', () => {
    expect(() => resolvePairToken(tokens, USDG)).toThrow(/not an approved quote asset/)
  })

  it('refuses an unknown symbol rather than guessing', () => {
    expect(() => resolvePairToken(tokens, 'TSLA')).toThrow(/no approved quote asset is called/)
  })

  it('refuses to choose between two assets sharing a symbol', () => {
    const twins = [...tokens, { ...(tokens[1] as PairToken), address: USDG }]
    expect(() => resolvePairToken(twins, 'NVDA')).toThrow(/2 approved assets are called/)
  })
})
