#!/usr/bin/env -S npx tsx
/**
 * Prove the sequences a single simulation cannot.
 *
 * `--dry-run` and the offline suite between them cover one call against one
 * block. What neither can show is that an approval lands and the sell in the
 * *next* block then succeeds, or that a launch confirms and the curve it
 * created is buyable a block later. Those are the failures that reach a user,
 * and until now the only way to catch them was Foundry's `anvil` or spending
 * real money through `scripts/mainnet-e2e.sh`.
 *
 * Neither is needed. Robinhood Chain answers **`eth_simulateV1`**, which runs a
 * list of blocks, each with a list of calls, carrying state across all of them
 * with overrides, and against live mainnet state. That is exactly a sequence
 * proof, over plain RPC, for free.
 *
 * Two rules make the results mean something:
 *
 * 1. **Every sequence has a control that must fail.** If the sell succeeds
 *    without its approval, the override was doing the work and the passing run
 *    proved nothing.
 * 2. **Status alone is not success.** A call to an address holding no code
 *    returns `status: 0x1` and no output. The buy-without-the-launch control
 *    "passes" on status and is caught only by asserting on output, which is how
 *    that mistake was found while writing this.
 *
 * Network-gated, like `abi:check`: it reaches mainnet and is not part of
 * `npm test`.
 *
 *   npm run test:sequence
 */
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  numberToHex,
  parseEther,
  type Address,
  type Hex,
} from 'viem'

import { v2CurveAbi, v2FactoryAbi } from '../src/abi/index.js'
import { addresses } from '../src/chain/addresses.js'
import { robinhoodChain } from '../src/chain/definition.js'
import { readV1Launch } from '../src/core/adapters/v1.js'
import { buildV1SellPlan } from '../src/core/adapters/v1trade.js'
import {
  buildLaunchPlan,
  predictLaunchAddresses,
  readLaunchContext,
  saltFor,
  type LaunchIntent,
} from '../src/core/adapters/v2launch.js'
import { IndexStore } from '../src/core/index/store.js'
import { readPairTokens, resolvePairToken } from '../src/core/pairs.js'
import { decodeRevert } from '../src/core/revert.js'

const RPC = process.env['PONS_RPC_URL'] ?? 'https://rpc.mainnet.chain.robinhood.com'

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC, {
    timeout: 30_000,
    fetchOptions: { headers: { 'user-agent': 'ponscli-sequence-check' } },
  }),
  batch: { multicall: true },
})

/** An account with nothing in it, funded per simulation by an override. */
const ACTOR: Address = '0x000000000000000000000000000000000000dEaD'

interface Step {
  label: string
  to: Address
  data: Hex
  value?: bigint
  /** What the step is expected to do. A control's last step expects `revert`. */
  expect: 'ok' | 'revert'
  /**
   * Whether a successful step must return something.
   *
   * The EVM answers a call to an address with no code successfully and returns
   * nothing, so a step that is meant to reach real code has to say so.
   */
  expectOutput?: boolean
}

interface Sequence {
  name: string
  why: string
  overrides: Record<string, unknown>
  /** One block per entry. State carries from each to the next. */
  blocks: Step[][]
}

interface CallResult {
  status: Hex
  returnData: Hex
  error?: { message: string; data?: Hex }
}

async function simulate(sequence: Sequence): Promise<boolean> {
  const blockStateCalls = sequence.blocks.map((steps, index) => ({
    ...(index === 0 ? { stateOverrides: sequence.overrides } : {}),
    calls: steps.map((step) => ({
      from: ACTOR,
      to: step.to,
      data: step.data,
      value: numberToHex(step.value ?? 0n),
    })),
  }))

  const result = (await client.request({
    method: 'eth_simulateV1' as never,
    // `validation: false` skips nonce and balance checks between calls, which
    // is what lets one address run several transactions in a row without the
    // simulation inventing a nonce sequence for it.
    params: [{ blockStateCalls, validation: false }, 'latest'] as never,
  })) as { calls: CallResult[] }[]

  console.log(`\n${sequence.name}`)
  console.log(`  ${sequence.why}`)

  let ok = true
  sequence.blocks.forEach((steps, blockIndex) => {
    steps.forEach((step, callIndex) => {
      const call = result[blockIndex]?.calls[callIndex]
      if (call === undefined) {
        console.log(`  ✗ ${step.label}: the node returned no result for this call`)
        ok = false
        return
      }

      const succeeded = call.status === '0x1'
      const hasOutput = call.returnData !== '0x'
      const reason =
        call.error === undefined
          ? ''
          : call.error.data !== undefined && call.error.data.length > 2
            ? decodeRevert(call.error.data).message
            : call.error.message

      let verdict = true
      if (step.expect === 'ok' && !succeeded) verdict = false
      if (step.expect === 'revert' && succeeded) verdict = false
      if (step.expect === 'ok' && step.expectOutput === true && !hasOutput) verdict = false
      // A control whose last step is meant to fail can also "fail" by reaching
      // no code at all, which is a pass for our purposes but worth showing.
      if (step.expect === 'revert' && succeeded && !hasOutput) verdict = true

      const detail = succeeded
        ? hasOutput
          ? `${String(call.returnData.length / 2 - 1)} bytes`
          : 'no output'
        : reason
      console.log(`  ${verdict ? '✓' : '✗'} ${step.label}: ${succeeded ? 'ok' : 'reverted'}, ${detail}`)
      if (!verdict) ok = false
    })
  })
  return ok
}

/** `_balances[account]` for an OpenZeppelin v5 ERC-20, whose mapping is slot 0. */
function balanceSlot(account: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, 0n]))
}

const funded = { [ACTOR]: { balance: numberToHex(parseEther('1000')) } }

async function v1Sequences(): Promise<Sequence[]> {
  // A live V1 launch with liquidity. V1 is closed to new launches, so this has
  // to be an existing token rather than one the simulation creates.
  const token = (process.env['PONS_SEQ_V1_TOKEN'] ??
    '0x97133372cC4391A4F6889b4d52387649B76BC7EC') as Address
  const launch = await readV1Launch(client, token)
  const amount = 1_000_000_000_000_000_000_000_000n
  const sell = await buildV1SellPlan(client, launch, {
    tokensIn: amount,
    slippageBps: 500n,
    recipient: ACTOR,
  })
  const approve = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [addresses.v3SwapRouter, amount],
  })

  // Holding the tokens is a precondition, not part of the sequence, so it is an
  // override. The allowance deliberately is not: proving it can only come from
  // the approval executing is the whole point.
  const holding = {
    ...funded,
    [token]: { stateDiff: { [balanceSlot(ACTOR)]: numberToHex(amount * 2n, { size: 32 }) } },
  }

  const sellStep = (expect: 'ok' | 'revert'): Step => ({
    label: `sell ${launch.metadata.symbol} on Uniswap V3`,
    to: sell.to,
    data: sell.data,
    expect,
    expectOutput: expect === 'ok',
  })

  return [
    {
      name: 'V1 · approve, then sell in the next block',
      why: 'the router moves the tokens with transferFrom; without the approval it reverts STF',
      overrides: holding,
      blocks: [
        [{ label: 'approve the router', to: token, data: approve, expect: 'ok', expectOutput: true }],
        [sellStep('ok')],
      ],
    },
    {
      name: 'V1 · control: the same sell with no approval',
      why: 'must fail, or the balance override was doing the work above',
      overrides: holding,
      blocks: [[], [sellStep('revert')]],
    },
  ]
}

async function v2Sequences(): Promise<Sequence[]> {
  const store = new IndexStore({ chainId: 4663 })
  const pairs = await readPairTokens(client, { store })
  const context = await readLaunchContext(client, 0n, ACTOR)

  const name = 'Ponscli Sequence Check'
  const intent: LaunchIntent = {
    params: {
      name,
      symbol: 'SEQ',
      logo: '',
      description: '',
      socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
      creatorFeeRecipient: '0x0000000000000000000000000000000000000000',
      creatorTaxBps: 0,
      buybackEnabled: false,
      expectedEconomics: context.economics,
      salt: saltFor({ name, symbol: 'SEQ' }, 'sequence-check'),
    },
    configId: 0n,
    pair: resolvePairToken(pairs, 'ETH'),
    exemptions: [],
    devBuy: 0n,
    slippageBps: 100n,
    recipient: ACTOR,
  }

  const predicted = await predictLaunchAddresses(client, intent, context, ACTOR)
  const launch = buildLaunchPlan(intent, context)
  const buy = (value: bigint): Hex =>
    encodeFunctionData({ abi: v2CurveAbi, functionName: 'buy', args: [value, 0n, ACTOR] })
  const factoryCall = (fn: 'graduate' | 'createGraduatedPool'): Hex =>
    encodeFunctionData({ abi: v2FactoryAbi, functionName: fn, args: [predicted.token] })

  const launchStep: Step = {
    label: `launch SEQ at ${predicted.token}`,
    to: launch.to,
    data: launch.data,
    value: launch.value,
    expect: 'ok',
    expectOutput: true,
  }
  // Encoded against the predicted address, which is the point: a wrong
  // prediction reaches no code and returns nothing.
  const buyStep = (value: bigint, expect: 'ok' | 'revert' = 'ok'): Step => ({
    label: `buy ${value === parseEther('5') ? '5' : '0.05'} ETH of the curve it created`,
    to: predicted.curve,
    data: buy(value),
    value,
    expect,
    expectOutput: expect === 'ok',
  })

  return [
    {
      name: 'V2 · launch, then buy the curve it created',
      why: 'the buy is aimed at the predicted address before that address holds any code',
      overrides: funded,
      blocks: [[launchStep], [buyStep(parseEther('0.05'))]],
    },
    {
      name: 'V2 · control: the same buy with no launch',
      why: 'must reach no code and return nothing; a bare call to an empty address "succeeds"',
      overrides: funded,
      blocks: [[], [{ ...buyStep(parseEther('0.05'), 'revert'), expectOutput: false }]],
    },
    {
      name: 'V2 · the whole life of a launch',
      why: 'launch, trade, cross the graduation threshold, seed the Uniswap V4 pool',
      overrides: funded,
      blocks: [
        [launchStep],
        [buyStep(parseEther('0.05'))],
        [buyStep(parseEther('5'))],
        // Not `graduate()`: the buy that crosses the threshold sweeps the curve
        // on its way through, so by this block the launch is already Swept and
        // `graduate()` reverts WrongGraduationPhase. Only the pool is left.
        [
          {
            label: 'createGraduatedPool()',
            to: addresses.v2Factory,
            data: factoryCall('createGraduatedPool'),
            expect: 'ok',
            expectOutput: true,
          },
        ],
      ],
    },
    {
      name: 'V2 · control: graduate() after the threshold buy',
      why: 'must revert, because the last buy already swept the curve, which is why the CLI skips this phase',
      overrides: funded,
      blocks: [
        [launchStep],
        [buyStep(parseEther('5'))],
        [
          {
            label: 'graduate()',
            to: addresses.v2Factory,
            data: factoryCall('graduate'),
            expect: 'revert',
          },
        ],
      ],
    },
  ]
}

const sequences = [...(await v2Sequences()), ...(await v1Sequences())]

let failures = 0
for (const sequence of sequences) {
  try {
    if (!(await simulate(sequence))) failures += 1
  } catch (error) {
    console.log(`\n${sequence.name}`)
    console.log(`  ✗ ${(error as Error).message.split('\n')[0]}`)
    failures += 1
  }
}

console.log('')
if (failures > 0) {
  console.error(`${String(failures)} of ${String(sequences.length)} sequences did not behave as expected`)
  process.exitCode = 1
} else {
  console.log(`${String(sequences.length)} sequences behaved as expected, against live mainnet state`)
}
