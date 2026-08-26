import { afterEach, describe, expect, it } from 'vitest'
import {
  erc20Abi,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { v2CurveAbi, v2FactoryAbi } from '../src/abi/index.js'
import { addresses } from '../src/chain/addresses.js'
import type { Dispatch } from '../src/chain/pool.js'
import { ExitCode } from '../src/errors.js'
import { run } from '../src/program.js'
import { fakeChain, type Answer } from './fakeChain.js'
import { BufferSink, createTempHome, type TempHome } from './helpers.js'

/**
 * The write path, exercised end to end with no network and no key.
 *
 * The fixture is the live launch the curve maths was verified against, so the
 * numbers a test asserts are numbers the deployed contract produced.
 */
const TOKEN: Address = '0x44D6736eB4Bc60c17Fe8220062d8fdE3C28920f4'
const CURVE: Address = '0x60CeF8379Aa278F087074bC60595778985c1bD8E'
const TRADER: Address = '0xCAefbb5e99d0c48a7Aa49936662b174a3c2eaD61'
const NATIVE: Address = '0x0000000000000000000000000000000000000000'
const FACTORY = addresses.v2Factory as Address

interface ChainOptions {
  /** A second address the token answers `balanceOf` and `allowance` for. */
  holder?: Address
  phase?: number
  graduated?: boolean
  ready?: boolean
  sellable?: bigint
  balance?: bigint
  allowance?: bigint
  snipeTaxBps?: bigint
}

function chainFor(options: ChainOptions = {}): Dispatch {
  const answers: Answer[] = [
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'getLaunchedToken',
      args: [TOKEN],
      result: {
        token: TOKEN,
        curve: CURVE,
        deployer: TRADER,
        creatorFeeRecipient: TRADER,
        pairToken: NATIVE,
        graduationThreshold: 4_200_000_000_000_000_000n,
        poolFee: 0,
        tickSpacing: 200,
        creatorTaxBps: 0,
        buybackEnabled: false,
        phase: options.phase ?? 0,
        sweptQuote: 0n,
        sweptTokens: 0n,
        sweptAt: 0n,
        exists: true,
      },
    },
    {
      address: FACTORY,
      abi: v2FactoryAbi,
      functionName: 'getLaunchFeePolicy',
      args: [TOKEN],
      result: {
        protocolFeeRecipient: TRADER,
        protocolFeeShareBps: 3000,
        buybackBurnBps: 5000,
        hookFeeBps: 100,
        maxInternalPriceImpactBps: 300,
      },
    },
    { address: CURVE, abi: v2CurveAbi, functionName: 'getReserves', result: [1_680_000_000_000_000_001n, 10n ** 27n] },
    { address: CURVE, abi: v2CurveAbi, functionName: 'realQuoteReserve', result: 1n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'phantomQuote', result: 1_680_000_000_000_000_000n },
    {
      address: CURVE,
      abi: v2CurveAbi,
      functionName: 'sellableTokens',
      result: options.sellable ?? 714_285_714_285_714_285_714_285_715n,
    },
    { address: CURVE, abi: v2CurveAbi, functionName: 'reservedTokens', result: 285_714_285_714_285_714_285_714_285n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'readyToGraduate', result: options.ready ?? false },
    { address: CURVE, abi: v2CurveAbi, functionName: 'graduated', result: options.graduated ?? false },
    { address: CURVE, abi: v2CurveAbi, functionName: 'launchedAt', result: 1_787_654_670n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'snipeTaxStartBps', result: 9900n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'snipeTaxSeconds', result: 3n },
    {
      address: CURVE,
      abi: v2CurveAbi,
      functionName: 'currentSnipeTaxBps',
      args: [NATIVE],
      result: options.snipeTaxBps ?? 0n,
    },
    { address: CURVE, abi: v2CurveAbi, functionName: 'feeBps', result: 100n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'creatorTaxBps', result: 0n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'buybackEnabled', result: false },
    { address: CURVE, abi: v2CurveAbi, functionName: 'buybackQuoteBalance', result: 0n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'quoteFeeBalance', result: 0n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'creatorTaxBalance', result: 0n },
    { address: TOKEN, abi: erc20Abi, functionName: 'name', result: 'Danmao' },
    { address: TOKEN, abi: erc20Abi, functionName: 'symbol', result: 'Danmao' },
    { address: TOKEN, abi: erc20Abi, functionName: 'decimals', result: 18 },
    { address: TOKEN, abi: erc20Abi, functionName: 'totalSupply', result: 10n ** 27n },
    {
      address: TOKEN,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [TRADER],
      result: options.balance ?? 10n ** 24n,
    },
    {
      address: TOKEN,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [TRADER, CURVE],
      result: options.allowance ?? 0n,
    },
    ...(options.holder === undefined
      ? []
      : [
          {
            address: TOKEN,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [options.holder],
            result: options.balance ?? 10n ** 24n,
          },
          {
            address: TOKEN,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [options.holder, CURVE],
            result: options.allowance ?? 0n,
          },
        ]),
  ]

  return fakeChain({
    answers,
    // The trade itself, the approval and both graduation calls execute; what
    // they return is not what these tests are about. `sell` is left out when
    // there is no allowance, because that is what the token does: the transfer
    // inside `sell` reverts until the curve has been approved.
    succeed: [
      { address: CURVE, abi: v2CurveAbi, functionName: 'buy' },
      ...((options.allowance ?? 0n) > 0n
        ? [{ address: CURVE, abi: v2CurveAbi, functionName: 'sell' }]
        : []),
      { address: TOKEN, abi: erc20Abi, functionName: 'approve' },
      { address: FACTORY, abi: v2FactoryAbi, functionName: 'graduate' },
      { address: FACTORY, abi: v2FactoryAbi, functionName: 'createGraduatedPool' },
    ],
    methods: {
      eth_getBlockByNumber: {
        number: numberToHex(45_676_251),
        hash: `0x${'11'.repeat(32)}`,
        parentHash: `0x${'22'.repeat(32)}`,
        timestamp: numberToHex(1_787_655_354),
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

async function invoke(
  argv: string[],
  dispatch: Dispatch,
): Promise<{ code: number; stdout: BufferSink; stderr: BufferSink }> {
  temp ??= createTempHome()
  const stdout = new BufferSink()
  const stderr = new BufferSink()
  const code = await run({ argv, env: temp.env, home: temp.home, isTTY: false, stdout, stderr, dispatch })
  return { code, stdout, stderr }
}

interface ExecutePayload {
  mode: string
  plan: {
    kind: string
    route: string
    to: string
    data: string
    value: string
    warnings: { code: string; severity: string }[]
    economics: Record<string, string>
  }
  prerequisites: { kind: string; to: string }[]
  simulation?: { ok: boolean; blockedByPrerequisite: boolean }
}

describe('pons buy', () => {
  it('prices the trade the way the deployed curve does', async () => {
    // The same 0.05 ETH buy `buy.staticCall` answered on chain.
    const { code, stdout } = await invoke(
      ['buy', TOKEN, '0.05', '--from', TRADER, '--json'],
      chainFor(),
    )
    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<ExecutePayload>()
    expect(payload.plan.route).toBe('curve')
    expect(payload.plan.to).toBe(CURVE)
    expect(payload.plan.economics['tokensOut']).toBe('28620988725065047685099168')
    // A native launch sends the quote as value; `_receiveQuote` requires it.
    expect(payload.plan.value).toBe('50000000000000000')
  })

  it('sends nothing without --confirm', async () => {
    const { stdout } = await invoke(['buy', TOKEN, '0.05', '--from', TRADER, '--json'], chainFor())
    const payload = stdout.json<ExecutePayload>()
    expect(payload.mode).toBe('plan')
    expect(payload).not.toHaveProperty('transaction')
  })

  it('applies the slippage tolerance to the floor, not to the quote', async () => {
    const { stdout } = await invoke(
      ['buy', TOKEN, '0.05', '--from', TRADER, '--slippage', '500', '--json'],
      chainFor(),
    )
    const { economics } = stdout.json<ExecutePayload>().plan
    const expected = economics['tokensOut']
    const floor = economics['minTokensOut']
    expect(BigInt(floor ?? '0')).toBe((BigInt(expected ?? '0') * 9500n) / 10_000n)
  })

  it('warns loudly while the snipe tax is live', async () => {
    const { stdout } = await invoke(
      ['buy', TOKEN, '0.05', '--from', TRADER, '--json'],
      chainFor({ snipeTaxBps: 9900n }),
    )
    const payload = stdout.json<ExecutePayload>()
    const warning = payload.plan.warnings.find((entry) => entry.code === 'snipe-tax')
    // 99% of the input in the launch second. That is a danger, not a note.
    expect(warning?.severity).toBe('danger')
    expect(BigInt(payload.plan.economics['snipeTax'] ?? '0')).toBeGreaterThan(0n)
  })

  it('emits calldata and simulates nothing with --unsigned', async () => {
    const { stdout } = await invoke(
      ['buy', TOKEN, '0.05', '--from', TRADER, '--unsigned', '--json'],
      chainFor(),
    )
    const payload = stdout.json<ExecutePayload>()
    expect(payload.mode).toBe('unsigned')
    expect(payload.plan.data).toMatch(/^0x/)
    // Simulating as somebody else would report a result that does not apply
    // to whoever ends up signing it.
    expect(payload.simulation).toBeUndefined()
  })

  it('refuses to route a graduated token onto its curve', async () => {
    const { code, stderr } = await invoke(
      ['buy', TOKEN, '0.05', '--from', TRADER, '--route', 'curve', '--json'],
      chainFor({ phase: 2, graduated: true }),
    )
    expect(code).toBe(ExitCode.Usage)
    expect(stderr.text).toMatch(/graduated/)
  })
})

/**
 * The send path, with a real key and a real signature, against the fake chain.
 *
 * Everything below `--confirm` was covered only at the `sendPlan` seam. What
 * was never checked end to end is the claim the whole design rests on: that the
 * plan a user reads is the plan that gets signed. Here the raw transaction is
 * caught on its way out and taken apart.
 */
describe('pons buy --confirm', () => {
  const RECEIPT_BLOCK = 45_676_252

  function sendable(inner: Dispatch, onSent?: () => void): {
    dispatch: Dispatch
    raw: () => Hex | undefined
    all: () => readonly Hex[]
  } {
    const broadcast: Hex[] = []
    let raw: Hex | undefined
    const dispatch: Dispatch = async (endpoint, method, params) => {
      switch (method) {
        case 'eth_getTransactionCount':
          return numberToHex(7)
        case 'eth_maxPriorityFeePerGas':
          return numberToHex(1_000_000_000)
        // With no `baseFeePerGas` the client falls back to legacy pricing; this
        // chain is 1559, so the fixture has to look like it.
        case 'eth_getBlockByNumber':
          return {
            ...((await inner(endpoint, method, params)) as Record<string, unknown>),
            baseFeePerGas: numberToHex(100_000_000),
          }
        case 'eth_getBalance':
          return numberToHex(10n ** 18n)
        case 'eth_sendRawTransaction':
          raw = params[0] as Hex
          broadcast.push(raw)
          onSent?.()
          return keccak256(raw)
        case 'eth_getTransactionReceipt':
          return {
            blockHash: `0x${'33'.repeat(32)}`,
            blockNumber: numberToHex(RECEIPT_BLOCK),
            contractAddress: null,
            cumulativeGasUsed: numberToHex(102_852),
            effectiveGasPrice: numberToHex(1_000_000_000),
            from: `0x${'44'.repeat(20)}`,
            gasUsed: numberToHex(102_852),
            logs: [],
            logsBloom: `0x${'00'.repeat(256)}`,
            status: '0x1',
            to: CURVE,
            transactionHash: params[0],
            transactionIndex: numberToHex(0),
            type: '0x2',
          }
        default:
          return inner(endpoint, method, params)
      }
    }
    return { dispatch, raw: () => raw, all: () => broadcast }
  }

  const KEY = `0x${'ab'.repeat(32)}` as const
  const KEY_ADDRESS = privateKeyToAccount(KEY).address

  /** Import a key through the CLI itself, the way the docs say to. */
  async function withKey(dispatch: Dispatch): Promise<Address> {
    const key = KEY
    temp ??= createTempHome()
    temp.env['PONS_PRIVATE_KEY'] = key
    temp.env['PONS_PASSWORD'] = 'a test passphrase'
    const { code } = await invoke(['wallet', 'import', '--json'], dispatch)
    expect(code).toBe(ExitCode.Ok)
    delete temp.env['PONS_PRIVATE_KEY']
    return privateKeyToAccount(key).address
  }

  it('signs the plan it printed, with the key it was given', async () => {
    const { dispatch, raw } = sendable(chainFor())
    const address = await withKey(dispatch)
    const { code, stdout } = await invoke(['buy', TOKEN, '0.05', '--confirm', '--json'], dispatch)
    expect(code).toBe(ExitCode.Ok)

    const payload = stdout.json<ExecutePayload & { transaction?: { hash: Hex; status: string } }>()
    expect(payload.mode).toBe('sent')

    const bytes = raw()
    expect(bytes).toBeDefined()
    const signed = parseTransaction(bytes as Hex)
    // The three fields that decide where the money goes, compared against the
    // plan the user was shown rather than against the builder that made both.
    expect(signed.to?.toLowerCase()).toBe(payload.plan.to.toLowerCase())
    expect(signed.value).toBe(BigInt(payload.plan.value))
    expect(signed.data).toBe(payload.plan.data)
    // And the signature is the keystore's, not somebody else's.
    await expect(
      recoverTransactionAddress({ serializedTransaction: bytes as `0x02${string}` }),
    ).resolves.toBe(address)
  })

  it('reports the hash of the bytes it actually sent', async () => {
    const { dispatch, raw } = sendable(chainFor())
    await withKey(dispatch)
    const { stdout } = await invoke(['buy', TOKEN, '0.05', '--confirm', '--json'], dispatch)
    const payload = stdout.json<{ transaction: { hash: Hex; status: string; block: number } }>()
    expect(payload.transaction.hash).toBe(keccak256(raw() as Hex))
    expect(payload.transaction.status).toBe('success')
  })

  it('signs with the nonce the pinned endpoint gave it', async () => {
    const { dispatch, raw } = sendable(chainFor())
    await withKey(dispatch)
    await invoke(['buy', TOKEN, '0.05', '--confirm', '--json'], dispatch)
    expect(parseTransaction(raw() as Hex).nonce).toBe(7)
  })

  /**
   * A chain that only honours the sell once the approval has been broadcast.
   *
   * Which is the whole difficulty: the sell cannot be simulated before its
   * approval lands, so it produces no gas estimate, and a limit read from that
   * simulation is missing exactly when a prerequisite exists.
   */
  function afterApproval(): { chain: Dispatch; landed: () => void } {
    const before = chainFor({ holder: KEY_ADDRESS, allowance: 0n })
    const after = chainFor({ holder: KEY_ADDRESS, allowance: 10n ** 30n })
    let approved = false
    return {
      chain: async (endpoint, method, params) =>
        (approved ? after : before)(endpoint, method, params),
      landed: () => {
        approved = true
      },
    }
  }

  it('sends the approval and then the sell it could not price beforehand', async () => {
    // The gas limit used to be read from the simulation at the top of the run,
    // which for a plan with a prerequisite is the one that prerequisite blocked
    // — so it never produced an estimate. `sell --confirm` failed with
    // NO_GAS_LIMIT for every account whose allowance was still zero, which is
    // every account the first time it sells.
    const chain = afterApproval()
    const { dispatch, all } = sendable(chain.chain, chain.landed)
    await withKey(dispatch)
    const { code, stdout } = await invoke(
      ['sell', TOKEN, '50%', '--confirm', '--json'],
      dispatch,
    )
    expect(code).toBe(ExitCode.Ok)
    expect(all()).toHaveLength(2)
    const payload = stdout.json<{
      prerequisiteTransactions?: { hash: Hex }[]
      transaction?: { hash: Hex }
    }>()
    expect(payload.prerequisiteTransactions).toHaveLength(1)
    expect(payload.transaction?.hash).toBe(keccak256(all()[1] as Hex))
  })

  it('signs the sell with a gas limit, not with a guess', async () => {
    const chain = afterApproval()
    const { dispatch, all } = sendable(chain.chain, chain.landed)
    await withKey(dispatch)
    await invoke(['sell', TOKEN, '50%', '--confirm', '--json'], dispatch)
    const sell = parseTransaction(all()[1] as `0x02${string}`)
    // 100,000 is what the fixture's `eth_estimateGas` answers, and the CLI pads
    // by 25% for the poster cost. A limit that is merely non-zero would pass a
    // weaker test while the estimate was still being read from the wrong call.
    expect(sell.gas).toBe(125_000n)
  })

  it('adds a bought token to the tracked list once the buy has landed', async () => {
    // The tracked list is the CLI's whole answer to ERC-20 discovery, and it is
    // documented as filling itself on a buy. Without this, buying a token and
    // then looking for it in `wallet balance` finds nothing.
    const { dispatch } = sendable(chainFor())
    await withKey(dispatch)
    await invoke(['buy', TOKEN, '0.05', '--confirm', '--json'], dispatch)
    const { stdout } = await invoke(['config', 'get', 'wallet.tracked', '--json'], dispatch)
    const value = JSON.stringify(stdout.json<{ value: unknown }>().value).toLowerCase()
    expect(value).toContain(TOKEN.toLowerCase())
  })

  it('does not track anything when nothing was sent', async () => {
    await invoke(['buy', TOKEN, '0.05', '--from', TRADER, '--json'], chainFor())
    const { stdout } = await invoke(['config', 'get', 'wallet.tracked', '--json'], chainFor())
    expect(stdout.json<{ value: unknown }>().value).toEqual([])
  })

  it('refuses to sign when the password is wrong, before anything is sent', async () => {
    const { dispatch, raw } = sendable(chainFor())
    await withKey(dispatch)
    temp!.env['PONS_PASSWORD'] = 'not the passphrase'
    const { code } = await invoke(['buy', TOKEN, '0.05', '--confirm', '--json'], dispatch)
    expect(code).toBe(ExitCode.Wallet)
    expect(raw()).toBeUndefined()
  })
})

describe('an account that cannot pay', () => {
  // An empty wallet used to be told the call "reverted without returning a
  // reason" — sending its owner to look for a contract bug instead of at their
  // balance. The node's own words were discarded, and the reply was walked
  // across every endpoint on the way.

  /** What the official endpoint answers a sender holding nothing. */
  function brokeOn(inner: Dispatch): Dispatch {
    return async (endpoint, method, params) => {
      // Only the plan's own call carries value from the sender; the reads that
      // resolve the launch have to keep working, or the failure under test
      // never happens.
      const request = params[0] as { value?: string } | undefined
      const spends = request?.value !== undefined && BigInt(request.value) > 0n
      if (spends && (method === 'eth_call' || method === 'eth_estimateGas')) {
        const message =
          'err: insufficient funds for gas * price + value: address ' +
          `${TRADER} have 0 want 50000000000000000 (supplied gas 50000000)`
        throw Object.assign(new Error('RPC Request failed.'), {
          name: 'RpcRequestError',
          cause: Object.assign(new Error(message), { code: -32000, details: message }),
        })
      }
      return inner(endpoint, method, params)
    }
  }

  it('says so, with its own exit code rather than the revert one', async () => {
    const { code, stderr } = await invoke(
      ['buy', TOKEN, '0.05', '--from', TRADER, '--json'],
      brokeOn(chainFor()),
    )
    expect(code).toBe(ExitCode.Funds)
    const error = stderr.json<{ error: { code: string; details: Record<string, string> } }>().error
    expect(error.code).toBe('INSUFFICIENT_FUNDS')
    expect(error.details['have']).toBe('0')
    expect(error.details['want']).toBe('50000000000000000')
  })

  it('keeps the node\'s words instead of inventing a revert', async () => {
    const { stdout } = await invoke(
      ['buy', TOKEN, '0.05', '--from', TRADER, '--json'],
      brokeOn(chainFor()),
    )
    const payload = stdout.json<{ simulation: { failure?: string; revert?: unknown } }>()
    expect(payload.simulation.failure).toContain('insufficient funds')
    // There was no revert payload, so there is no revert to report.
    expect(payload.simulation.revert).toBeUndefined()
  })
})

describe('the four execution modes', () => {
  // The documented table used to describe the default as building a plan and
  // stopping, when it has always simulated too. The docs now say so, and these
  // hold them to it.

  it('simulates on the default path, with no flag asking for it', async () => {
    const { stdout } = await invoke(['buy', TOKEN, '0.05', '--from', TRADER, '--json'], chainFor())
    const payload = stdout.json<ExecutePayload>()
    expect(payload.mode).toBe('plan')
    expect(payload.simulation?.ok).toBe(true)
  })

  it('gives --dry-run the same result, differing only in the mode it reports', async () => {
    const plan = (
      await invoke(['buy', TOKEN, '0.05', '--from', TRADER, '--json'], chainFor())
    ).stdout.json<ExecutePayload>()
    const dry = (
      await invoke(['buy', TOKEN, '0.05', '--from', TRADER, '--dry-run', '--json'], chainFor())
    ).stdout.json<ExecutePayload>()
    expect(dry.mode).toBe('dry-run')
    expect({ ...dry, mode: 'plan' }).toEqual(plan)
  })

  it('does not simulate under --unsigned, which is what makes it the odd one', async () => {
    // Nothing is being proposed for this account, so there is nothing to check
    // against live state — the calldata is for somebody else to sign.
    const { stdout } = await invoke(
      ['buy', TOKEN, '0.05', '--from', TRADER, '--unsigned', '--json'],
      chainFor(),
    )
    const payload = stdout.json<ExecutePayload>()
    expect(payload.mode).toBe('unsigned')
    expect(payload.simulation).toBeUndefined()
  })

  it('never reports a transaction in any of the three free modes', async () => {
    for (const flags of [[], ['--dry-run'], ['--unsigned']]) {
      const { stdout } = await invoke(
        ['buy', TOKEN, '0.05', '--from', TRADER, ...flags, '--json'],
        chainFor(),
      )
      expect(stdout.json<ExecutePayload>()).not.toHaveProperty('transaction')
    }
  })
})

describe('pons sell', () => {
  it('takes the fee off the output, as the curve does', async () => {
    const { code, stdout } = await invoke(
      ['sell', TOKEN, 'all', '--from', TRADER, '--json'],
      chainFor({ allowance: 10n ** 30n }),
    )
    expect(code).toBe(ExitCode.Ok)
    const { economics } = stdout.json<ExecutePayload>().plan
    expect(economics['gross']).toBe('1678321678321678')
    expect(economics['quoteOut']).toBe('1661538461538462')
  })

  it('resolves a percentage against the balance', async () => {
    const { stdout } = await invoke(
      ['sell', TOKEN, '50%', '--from', TRADER, '--json'],
      chainFor({ balance: 10n ** 24n, allowance: 10n ** 30n }),
    )
    expect(stdout.json<ExecutePayload>().plan.economics['tokensIn']).toBe('500000000000000000000000')
  })

  it('plans the approval a sell needs and does not call it a failure', async () => {
    // The sell simulation reverts on the allowance until the approval lands.
    // Reporting that as the sell's own fault sends the user hunting for a
    // fault that is about to fix itself.
    const { code, stdout } = await invoke(
      ['sell', TOKEN, 'all', '--from', TRADER, '--json'],
      chainFor({ allowance: 0n }),
    )
    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<ExecutePayload>()
    expect(payload.prerequisites).toHaveLength(1)
    expect(payload.prerequisites[0]?.kind).toBe('approve')
    expect(payload.simulation?.blockedByPrerequisite).toBe(true)
  })

  it('redirects rather than surfacing a raw revert at the threshold', async () => {
    // `sell()` reverts once `readyToGraduate()` is true, and the next step is
    // a call anybody can make.
    const { code, stderr } = await invoke(
      ['sell', TOKEN, 'all', '--from', TRADER, '--json'],
      chainFor({ ready: true, sellable: 0n }),
    )
    expect(code).toBe(ExitCode.Revert)
    const error = stderr.json<{ error: { code: string; hint: string } }>()
    expect(error.error.code).toBe('READY_TO_GRADUATE')
    expect(error.error.hint).toMatch(/pons graduate/)
  })

  it('refuses a sell for an account that holds nothing', async () => {
    const { code, stderr } = await invoke(
      ['sell', TOKEN, 'all', '--from', TRADER, '--json'],
      chainFor({ balance: 0n }),
    )
    expect(code).toBe(ExitCode.Usage)
    expect(stderr.json<{ error: { code: string } }>().error.code).toBe('NOTHING_TO_SELL')
  })
})

describe('pons graduate', () => {
  it('refuses a curve that has not reached its threshold', async () => {
    const { code, stderr } = await invoke(['graduate', TOKEN, '--json'], chainFor())
    expect(code).toBe(ExitCode.Revert)
    const error = stderr.json<{ error: { code: string; hint: string } }>()
    expect(error.error.code).toBe('NOT_READY')
    expect(error.error.hint).toMatch(/%/)
  })

  it('plans both phases when the curve is ready', async () => {
    const { code, stdout } = await invoke(
      ['graduate', TOKEN, '--json'],
      chainFor({ ready: true, sellable: 0n }),
    )
    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<ExecutePayload>()
    // `graduate()` drains the curve, `createGraduatedPool()` spends what it
    // drained. Both are permissionless.
    expect(payload.prerequisites).toHaveLength(1)
    expect(payload.prerequisites[0]?.kind).toBe('graduate')
    expect(payload.plan.kind).toBe('create-pool')
    expect(payload.plan.to).toBe(FACTORY)
  })

  it('does the phase that is left when the curve is already drained', async () => {
    const { stdout } = await invoke(
      ['graduate', TOKEN, '--json'],
      chainFor({ phase: 1, ready: false, graduated: true }),
    )
    const payload = stdout.json<ExecutePayload>()
    expect(payload.prerequisites).toHaveLength(0)
    expect(payload.plan.kind).toBe('create-pool')
  })
})
