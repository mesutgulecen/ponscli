import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeFunctionData,
  erc20Abi,
  numberToHex,
  pad,
  toEventSelector,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'

import { launchAndBuyAbi, launchDeployerAbi, memeHookAbi, v2FactoryAbi } from '../src/abi/index.js'
import { addresses } from '../src/chain/addresses.js'
import {
  MAX_SNIPE_TAX_EXEMPTIONS,
  buildLaunchAndBuyPlan,
  buildLaunchPlan,
  openingCurveState,
  previewEconomics,
  saltFor,
  validateLaunch,
  type LaunchContext,
  type LaunchIntent,
} from '../src/core/adapters/v2launch.js'
import type { PairToken } from '../src/core/pairs.js'
import { ExitCode } from '../src/errors.js'
import { run } from '../src/program.js'
import { fakeChain, type Answer, type FakeLog } from './fakeChain.js'
import { BufferSink, createTempHome, type TempHome } from './helpers.js'

/**
 * Fixtures are the live config and fee policy, read on 2026-08-25: config 0
 * with a billion supply, a 1% curve fee, a 1.68 ETH phantom reserve and a
 * 4.2 ETH threshold; `launchFee` 0.0005 ETH; `maxCreatorTaxBps` 1000.
 */
const FACTORY = addresses.v2Factory as Address
const LAUNCHER: Address = '0x000000000000000000000000000000000000dEaD'
const NATIVE: Address = '0x0000000000000000000000000000000000000000'
const NVDA: Address = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'
const SUPPLY = 1_000_000_000_000_000_000_000_000_000n
const LAUNCH_FEE = 500_000_000_000_000n
const HEAD = 45_676_251

const ETH: PairToken = {
  address: NATIVE,
  symbol: 'ETH',
  name: 'Native ETH',
  decimals: 18,
  native: true,
  phantomQuote: 1_680_000_000_000_000_000n,
  graduationThreshold: 4_200_000_000_000_000_000n,
  expectedDecimals: 18,
  approvedAtBlock: 0n,
}

const NVDA_PAIR: PairToken = {
  address: NVDA,
  symbol: 'NVDA',
  name: 'NVIDIA',
  decimals: 18,
  native: false,
  phantomQuote: 16_640_000_000_000_000_000n,
  graduationThreshold: 41_600_000_000_000_000_000n,
  expectedDecimals: 18,
  approvedAtBlock: 1n,
}

const CONTEXT: LaunchContext = {
  configId: 0n,
  config: {
    supply: SUPPLY,
    curveFeeBps: 100n,
    phantomQuote: 1_680_000_000_000_000_000n,
    graduationThreshold: 4_200_000_000_000_000_000n,
    poolFee: 0,
    tickSpacing: 200,
    enabled: true,
  },
  policy: {
    protocolFeeRecipient: LAUNCHER,
    protocolFeeShareBps: 3_000,
    buybackBurnBps: 5_000,
    hookFeeBps: 100,
    maxInternalPriceImpactBps: 500,
  },
  launchFee: LAUNCH_FEE,
  launchEnabled: true,
  canLaunch: true,
  maxCreatorTaxBps: 1_000n,
  snipeTaxStartBps: 9_900n,
  snipeTaxSeconds: 3n,
  economics: `0x${'ab'.repeat(32)}`,
  launchDeployer: addresses.launchDeployer,
  launchForwarder: addresses.launchAndBuy,
}

const DEFAULT_PARAMS: LaunchIntent['params'] = {
  name: 'Ponscli Probe',
  symbol: 'PROBE',
  logo: '',
  description: '',
  socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
  creatorFeeRecipient: NATIVE,
  creatorTaxBps: 0,
  buybackEnabled: false,
  expectedEconomics: CONTEXT.economics,
  salt: saltFor({ name: 'Ponscli Probe', symbol: 'PROBE' }, ''),
}

/** Overrides merge into `params` rather than replacing it wholesale. */
function intent(overrides: Partial<LaunchIntent> = {}): LaunchIntent {
  const { params, ...rest } = overrides
  return {
    configId: 0n,
    pair: ETH,
    exemptions: [],
    devBuy: 0n,
    slippageBps: 100n,
    recipient: LAUNCHER,
    ...rest,
    params: { ...DEFAULT_PARAMS, ...params },
  }
}

describe('launch validation', () => {
  it('accepts a plain native launch', () => {
    expect(() => validateLaunch(intent(), CONTEXT)).not.toThrow()
  })

  it('measures metadata in bytes, not characters', () => {
    // Sixteen emoji are sixteen characters and sixty-four bytes, which is
    // exactly the name limit; seventeen overflow it while still looking short.
    const seventeen = '🐈'.repeat(17)
    expect(() => validateLaunch(intent({ params: { name: seventeen } as LaunchIntent['params'] }), CONTEXT)).toThrow(
      /--name is 68 bytes; the contract accepts 64/,
    )
  })

  it('rejects an empty symbol', () => {
    expect(() => validateLaunch(intent({ params: { symbol: '' } as LaunchIntent['params'] }), CONTEXT)).toThrow(
      /needs both --name and --symbol/,
    )
  })

  it('holds the creator tax to the live ceiling', () => {
    expect(() =>
      validateLaunch(intent({ params: { creatorTaxBps: 1_001 } as LaunchIntent['params'] }), CONTEXT),
    ).toThrow(/caps it at 10%/)
  })

  it('refuses a launch on a disabled config', () => {
    const disabled = { ...CONTEXT, config: { ...CONTEXT.config, enabled: false } }
    expect(() => validateLaunch(intent(), disabled)).toThrow(/is disabled/)
  })

  it('refuses when the address cannot launch', () => {
    const closed = { ...CONTEXT, launchEnabled: false, canLaunch: false }
    expect(() => validateLaunch(intent(), closed)).toThrow(/not whitelisted/)
  })

  it('accepts the full exemption list and refuses one more', () => {
    const list = Array.from({ length: MAX_SNIPE_TAX_EXEMPTIONS }, (_, index) =>
      pad(numberToHex(index + 1), { size: 20 }),
    )
    expect(() => validateLaunch(intent({ exemptions: list }), CONTEXT)).not.toThrow()
    expect(() =>
      validateLaunch(intent({ exemptions: [...list, LAUNCHER] }), CONTEXT),
    ).toThrow(/at most 32 are accepted/)
  })

  it('leaves one exemption slot for the router when there is a dev buy', () => {
    // The router appends the buy's recipient whether or not the caller listed
    // them, so the creator's own list has to stop at 31.
    const list = Array.from({ length: MAX_SNIPE_TAX_EXEMPTIONS }, (_, index) =>
      pad(numberToHex(index + 1), { size: 20 }),
    )
    expect(() =>
      validateLaunch(intent({ exemptions: list, devBuy: 1n }), CONTEXT),
    ).toThrow(/at most 31 are accepted, since the router appends the buy recipient/)
  })

  it('refuses a quote asset whose decimals no longer match the record', () => {
    const drifted: PairToken = { ...NVDA_PAIR, decimals: 6 }
    expect(() => validateLaunch(intent({ pair: drifted }), CONTEXT)).toThrow(
      /reports 6 decimals but the factory sized its economics for 18/,
    )
  })

  it('refuses to launch with the guard waived', () => {
    expect(() =>
      validateLaunch(
        intent({ params: { expectedEconomics: `0x${'00'.repeat(32)}` } as LaunchIntent['params'] }),
        CONTEXT,
      ),
    ).toThrow(/without an economics guard/)
  })
})

describe('launch economics', () => {
  it('reserves the share of supply that seeds the pool', () => {
    const state = openingCurveState(CONTEXT.config, ETH, 0)
    // supply * phantom / (phantom + threshold), which `initialize` computes.
    expect(state.reservedTokens).toBe(285_714_285_714_285_714_285_714_285n)
    expect(state.tokenReserve - state.reservedTokens).toBe(714_285_714_285_714_285_714_285_715n)
  })

  it('shapes an ERC-20 quote curve identically to a native one', () => {
    const native = openingCurveState(CONTEXT.config, ETH, 0)
    const nvda = openingCurveState(CONTEXT.config, NVDA_PAIR, 0)
    // The ratio threshold / (threshold + phantom) is the same for every
    // approved asset, so the reserved allocation is too.
    expect(nvda.reservedTokens).toBe(native.reservedTokens)
  })

  it('prices an opening buy with no snipe tax', () => {
    const economics = previewEconomics(intent({ devBuy: 250_000_000_000_000_000n }), CONTEXT)
    // The recipient is exempt by construction, so the 99% launch-second tax
    // does not apply and the whole amount reaches the curve.
    expect(economics.devBuy).toBe(250_000_000_000_000_000n)
    expect(economics.tokensOut).toBeGreaterThan(0n)
    expect(economics.minTokensOut).toBeLessThan(economics.tokensOut)
  })

  it('charges nothing but the launch fee without a dev buy', () => {
    const economics = previewEconomics(intent(), CONTEXT)
    expect(economics.value).toBe(LAUNCH_FEE)
    expect(economics.tokensOut).toBe(0n)
  })
})

describe('launch plans', () => {
  it('sends exactly the launch fee, never more', () => {
    const plan = buildLaunchPlan(intent(), CONTEXT)
    // The factory checks `msg.value != launchFee` and reverts on anything
    // else, so overpaying is not a way to fold in a dev buy.
    expect(plan.value).toBe(LAUNCH_FEE)
    expect(plan.to).toBe(addresses.v2Factory)
  })

  it('routes a dev buy through the launch router, carrying fee plus buy', () => {
    const plan = buildLaunchAndBuyPlan(intent({ devBuy: 250_000_000_000_000_000n }), CONTEXT)
    expect(plan.to).toBe(addresses.launchAndBuy)
    expect(plan.value).toBe(LAUNCH_FEE + 250_000_000_000_000_000n)
  })

  it('carries only the launch fee when the opening buy is an ERC-20', () => {
    const plan = buildLaunchAndBuyPlan(
      intent({ pair: NVDA_PAIR, devBuy: 5_000_000_000_000_000_000n }),
      CONTEXT,
    )
    // The router pulls the quote asset with `transferFrom`; only the fee is
    // native, and it checks the sum exactly.
    expect(plan.value).toBe(LAUNCH_FEE)
  })

  it('holds the opening buy to the floor it quoted', () => {
    const plan = buildLaunchAndBuyPlan(intent({ devBuy: 250_000_000_000_000_000n }), CONTEXT)
    const { args } = decodeFunctionData({ abi: launchAndBuyAbi, data: plan.data })
    expect((args as readonly unknown[])[4]).toBe(BigInt(plan.economics['minTokensOut'] as string))
  })

  it('passes the economics guard through untouched', () => {
    const plan = buildLaunchPlan(intent(), CONTEXT)
    const { args } = decodeFunctionData({ abi: v2FactoryAbi, data: plan.data })
    const params = (args as readonly unknown[])[0] as { expectedEconomics: Hex }
    expect(params.expectedEconomics).toBe(CONTEXT.economics)
  })

  it('warns that the buyback vault is paid for by the creator', () => {
    const plan = buildLaunchPlan(intent({ params: { buybackEnabled: true } as LaunchIntent['params'] }), CONTEXT)
    expect(plan.warnings.map((warning) => warning.code)).toContain('buyback')
  })

  it('escalates a dev buy that takes most of the supply', () => {
    const plan = buildLaunchAndBuyPlan(intent({ devBuy: 20_000_000_000_000_000_000n }), CONTEXT)
    const warning = plan.warnings.find((entry) => entry.code === 'large-dev-buy')
    expect(warning?.severity).toBe('danger')
  })

  it('gives two different launches two different salts', () => {
    expect(saltFor({ name: 'A', symbol: 'A' }, '')).not.toBe(saltFor({ name: 'B', symbol: 'B' }, ''))
    expect(saltFor({ name: 'A', symbol: 'A' }, '')).toBe(saltFor({ name: 'A', symbol: 'A' }, ''))
  })
})

/**
 * The command end to end. The fixture answers everything `pons launch` reads,
 * including the deployer's address prediction, so the plan it prints is built
 * from the same path the live command takes.
 */
const PREDICTED_TOKEN: Address = '0xaf0074244dE17205F1BC20883d44cd11508284A1'
const PREDICTED_CURVE: Address = '0x16dfBA70f7f83adf1EF2E4E61b3956FC505dC7d0'

function launchAnswers(): Answer[] {
  return [
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'getLaunchConfig',
      args: [0n],
      result: { ...CONTEXT.config },
    },
    { address: addresses.memeHook, abi: memeHookAbi, functionName: 'currentFeePolicy', result: { ...CONTEXT.policy } },
    { address: FACTORY, abi: v2FactoryAbi, functionName: 'launchFee', result: LAUNCH_FEE },
    { address: FACTORY, abi: v2FactoryAbi, functionName: 'launchEnabled', result: true },
    { address: FACTORY, abi: v2FactoryAbi, functionName: 'canLaunch', args: [LAUNCHER], result: true },
    { address: FACTORY, abi: v2FactoryAbi, functionName: 'maxCreatorTaxBps', result: 1_000n },
    { address: FACTORY, abi: v2FactoryAbi, functionName: 'snipeTaxStartBps', result: 9_900n },
    { address: FACTORY, abi: v2FactoryAbi, functionName: 'snipeTaxSeconds', result: 3n },
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'launchDeployer',
      result: addresses.launchDeployer,
    },
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'launchForwarder',
      result: addresses.launchAndBuy,
    },
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'previewLaunchEconomics',
      args: [0n, NATIVE],
      result: CONTEXT.economics,
    },
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'previewLaunchEconomics',
      args: [0n, NVDA],
      // Deliberately not the native digest: a launch pinned to the wrong
      // asset's terms would revert with `LaunchEconomicsMismatch`.
      result: `0x${'cd'.repeat(32)}`,
    },
    { address: FACTORY, abi: v2FactoryAbi, functionName: 'approvedPairTokens', args: [NVDA], result: true },
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'pairTokenEconomics',
      args: [NVDA],
      result: [NVDA_PAIR.phantomQuote, NVDA_PAIR.graduationThreshold, 18],
    },
    { address: NVDA, abi: erc20Abi, functionName: 'symbol', result: 'NVDA' },
    { address: NVDA, abi: erc20Abi, functionName: 'name', result: 'NVIDIA' },
    { address: NVDA, abi: erc20Abi, functionName: 'decimals', result: 18 },
  ]
}

/**
 * Spelled out rather than looked up by name: `launchToken` is overloaded, and
 * the exemption-carrying overload is the one the CLI builds.
 */
const LAUNCH_TOKEN_SELECTOR = toFunctionSelector(
  'launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address[])',
)
const LAUNCH_AND_BUY_SELECTOR = toFunctionSelector(
  'launchAndBuy((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,uint256,uint256,address,address[])',
)

const APPROVAL_TOPIC = toEventSelector('PairTokenApprovalUpdated(address,bool)')
const APPROVAL_LOGS: FakeLog[] = [
  {
    address: FACTORY,
    topics: [APPROVAL_TOPIC, pad(NVDA, { size: 32 })],
    data: numberToHex(1, { size: 32 }),
    blockNumber: 26_841_846,
  },
]

/**
 * The command emits the plan, not a preview: everything the preview showed a
 * person rides on `plan.economics` for a machine, and one invocation writes
 * exactly one payload.
 */
interface LaunchPayload {
  plan: {
    to: Address
    value: string
    summary: string
    economics: Record<string, string>
  }
}

describe('pons launch', () => {
  let home: TempHome

  afterEach(() => {
    home.cleanup()
  })

  async function invoke(argv: string[]): Promise<{ code: number; stdout: BufferSink; stderr: BufferSink }> {
    home = createTempHome()
    const stdout = new BufferSink()
    const stderr = new BufferSink()
    const code = await run({
      argv: [...argv, '--json'],
      env: home.env,
      home: home.home,
      isTTY: false,
      stdout,
      stderr,
      dispatch: fakeChain({
        answers: [
          ...launchAnswers(),
          {
            address: addresses.launchDeployer,
            abi: launchDeployerAbi,
            functionName: 'predictLaunchAddresses',
            // Whatever struct the command assembles: reproducing all nineteen
            // fields here would assert on the fixture, not on the command.
            anyArgs: true,
            result: [PREDICTED_TOKEN, PREDICTED_CURVE],
          },
        ],
        succeed: [
          { address: FACTORY, selector: LAUNCH_TOKEN_SELECTOR },
          { address: addresses.launchAndBuy, selector: LAUNCH_AND_BUY_SELECTOR },
        ],
        logs: APPROVAL_LOGS,
        methods: { eth_blockNumber: numberToHex(HEAD), eth_getCode: '0x' },
      }),
    })
    return { code, stdout, stderr }
  }

  const BASE = ['launch', '--name', 'Ponscli Probe', '--symbol', 'PROBE', '--from', LAUNCHER]

  it('prints the launch it would make without sending anything', async () => {
    const { code, stdout } = await invoke(BASE)
    expect(code).toBe(ExitCode.Ok)
    const { plan } = stdout.json<LaunchPayload>()
    expect(plan.summary).toMatch(/launch PROBE \(Ponscli Probe\) against ETH/)
    expect(plan.value).toBe(LAUNCH_FEE.toString())
    expect(plan.to).toBe(addresses.v2Factory)
  })

  it('writes exactly one payload', async () => {
    const { stdout } = await invoke(BASE)
    expect(() => stdout.json()).not.toThrow()
  })

  it('names the address the token will land at before it exists', async () => {
    const { stdout } = await invoke(BASE)
    expect(stdout.json<LaunchPayload>().plan.economics['token']).toBe(PREDICTED_TOKEN)
    expect(stdout.json<LaunchPayload>().plan.economics['curve']).toBe(PREDICTED_CURVE)
  })

  it('refuses a creator tax above the live ceiling', async () => {
    const { code, stderr } = await invoke([...BASE, '--creator-tax', '2000'])
    expect(code).toBe(ExitCode.Usage)
    expect(stderr.text).toMatch(/caps it at 10%/)
  })

  it('refuses a quote asset that is not approved', async () => {
    const { code, stderr } = await invoke([...BASE, '--pair', 'TSLA'])
    expect(code).toBe(ExitCode.Usage)
    expect(stderr.text).toMatch(/no approved quote asset is called TSLA/)
  })

  it('resolves an approved symbol to its address', async () => {
    const { code, stdout } = await invoke([...BASE, '--pair', 'nvda'])
    expect(code).toBe(ExitCode.Ok)
    expect(stdout.json<LaunchPayload>().plan.summary).toMatch(/against NVDA/)
  })

  it('pins the quote asset own economics, not the native ones', async () => {
    const { stdout } = await invoke([...BASE, '--pair', 'nvda'])
    const guard = stdout.json<LaunchPayload>().plan.economics['expectedEconomics']
    expect(guard).toBe(`0x${'cd'.repeat(32)}`)
    expect(guard).not.toBe(CONTEXT.economics)
  })
})
