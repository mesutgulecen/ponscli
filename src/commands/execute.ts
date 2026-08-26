import type { Command } from 'commander'
import type { Address, Hex, TransactionReceipt } from 'viem'

import { robinhoodChain } from '../chain/definition.js'
import { setConfigValue } from '../config/index.js'
import type { CommandContext } from '../context.js'
import { needsConfirmation, shortPlanId, type Plan } from '../core/plan.js'
import { simulatePlan, simulationError, type Simulation } from '../core/simulate.js'
import { ExitCode, PonsError } from '../errors.js'
import { renderTable, type Painter } from '../output/index.js'
import { formatAmount, formatToken } from '../output/format.js'
import { loadSigner, sendPlan, type Signer } from '../wallet/signer.js'

/**
 * The one path every write in this CLI takes.
 *
 * Four modes share it, print, `--unsigned`, `--dry-run` and `--confirm`, and
 * they share it precisely so they cannot diverge. The plan a user reads is the
 * plan that gets simulated, and the plan that gets simulated is the one that
 * gets signed.
 *
 * Simulation is not one of the modes: **every** mode but `--unsigned` runs it,
 * the default included. `--dry-run` therefore does the same work as no flag at
 * all; what it adds is the caller saying so, which shows up as `mode` in the
 * JSON payload and drops the reminder that nothing was sent.
 */

export interface WriteFlags {
  confirm?: boolean
  dryRun?: boolean
  unsigned?: boolean
}

/** Flags every write command accepts. Registered in one place so they match. */
export function addWriteFlags(command: Command): Command {
  return command
    .option('--dry-run', 'Say explicitly what the default already does: build, simulate, stop')
    .option('--unsigned', 'Print the calldata and value instead of signing')
    .option('--confirm', 'Sign and broadcast. Without it nothing leaves this machine')
}

export type ExecutionMode = 'plan' | 'unsigned' | 'dry-run' | 'sent'

interface PlanPayload {
  id: Hex
  kind: Plan['kind']
  route: Plan['route']
  to: string
  data: Hex
  value: string
  summary: string
  warnings: Plan['warnings']
  economics: Record<string, string>
}

interface ExecutePayload {
  mode: ExecutionMode
  plan: PlanPayload
  /** Steps that had to land first, such as an approval. */
  prerequisites: PlanPayload[]
  simulation?: {
    ok: boolean
    gasEstimate: string | null
    gasLimit: string | null
    funded: boolean
    /**
     * True when the failure is the pending prerequisite rather than the plan.
     *
     * A sell simulated before its approval has landed reverts on the
     * allowance. Reporting that as the plan's own problem would send the user
     * looking for a fault that is about to fix itself.
     */
    blockedByPrerequisite: boolean
    revert?: { name: string | null; selector: string | null; message: string }
    /** The node's words, when the call failed without reaching the contract. */
    failure?: string
  }
  transaction?: {
    hash: Hex
    status: 'success' | 'reverted' | 'unconfirmed'
    blockNumber: string | null
    gasUsed: string | null
    feeWei: string | null
    endpoint: string
    explorer: string
  }
  /** Set when a prerequisite was broadcast before the main plan. */
  prerequisiteTransactions?: ExecutePayload['transaction'][]
}

function toPayload(plan: Plan): PlanPayload {
  return {
    id: plan.id,
    kind: plan.kind,
    route: plan.route,
    to: plan.to,
    data: plan.data,
    value: plan.value.toString(),
    summary: plan.summary,
    warnings: plan.warnings,
    economics: plan.economics,
  }
}

const SEVERITY_COLOR = { info: 'grey', warn: 'yellow', danger: 'red' } as const

function renderPlan(payload: PlanPayload, paint: Painter, indent = ''): string[] {
  const lines = [`${indent}${paint('bold', payload.summary)}`]
  lines.push(
    `${indent}${paint('grey', `${payload.kind} via ${payload.route}  ·  to ${payload.to}  ·  plan ${shortPlanId(payload.id)}`)}`,
  )
  if (payload.value !== '0') {
    lines.push(`${indent}${paint('grey', `value ${formatToken(BigInt(payload.value), 18, 'ETH')}`)}`)
  }
  for (const warning of payload.warnings) {
    lines.push(`${indent}${paint(SEVERITY_COLOR[warning.severity], warning.severity)} ${warning.message}`)
  }
  return lines
}

function render(payload: ExecutePayload, paint: Painter): string {
  const lines: string[] = []

  for (const prerequisite of payload.prerequisites) {
    lines.push(...renderPlan(prerequisite, paint, ''), '')
  }
  lines.push(...renderPlan(payload.plan, paint))

  const economics = Object.entries(payload.plan.economics)
  if (economics.length > 0) {
    lines.push(
      '',
      renderTable(
        [{ header: '' }, { header: '', align: 'right' as const }],
        economics.map(([key, value]) => [key, value]),
        '  ',
      ),
    )
  }

  if (payload.simulation !== undefined) {
    const { ok, gasEstimate, funded, revert } = payload.simulation
    lines.push('')
    if (ok) {
      lines.push(
        `${paint('green', 'simulated')} ${paint('grey', gasEstimate === null ? 'gas estimate unavailable' : `gas ${formatAmount(BigInt(gasEstimate), 0)}`)}`,
      )
      if (funded) {
        lines.push(
          paint('grey', '  the sender was given a balance for the simulation; it proves the call, not your funds'),
        )
      }
    } else if (payload.simulation.blockedByPrerequisite) {
      lines.push(
        `${paint('yellow', 'blocked')} ${revert?.message ?? payload.simulation.failure ?? 'unknown reason'}`,
        paint('grey', '  simulated before the step above; it clears once that has landed'),
      )
    } else if (revert !== undefined) {
      lines.push(`${paint('red', 'would revert')} ${revert.message}`)
    } else {
      // Not a revert: the node refused the call before the contract saw it.
      lines.push(`${paint('red', 'would fail')} ${payload.simulation.failure ?? 'unknown reason'}`)
    }
  }

  if (payload.mode === 'unsigned') {
    lines.push(
      '',
      paint('dim', 'unsigned transaction'),
      `  to    ${payload.plan.to}`,
      `  value ${payload.plan.value}`,
      `  data  ${payload.plan.data}`,
    )
  }

  for (const transaction of payload.prerequisiteTransactions ?? []) {
    if (transaction !== undefined) lines.push('', ...renderTransaction(transaction, paint))
  }
  if (payload.transaction !== undefined) {
    lines.push('', ...renderTransaction(payload.transaction, paint))
  }

  if (payload.mode === 'plan') {
    lines.push('', paint('grey', 'simulated, not sent. add --confirm to sign and broadcast it'))
  }

  return lines.join('\n')
}

function renderTransaction(transaction: NonNullable<ExecutePayload['transaction']>, paint: Painter): string[] {
  const status =
    transaction.status === 'success'
      ? paint('green', 'confirmed')
      : transaction.status === 'reverted'
        ? paint('red', 'reverted')
        : paint('yellow', 'unconfirmed')
  const lines = [`${status} ${transaction.hash}`]
  if (transaction.blockNumber !== null) {
    lines.push(
      paint(
        'grey',
        `  block ${transaction.blockNumber}  ·  gas ${transaction.gasUsed ?? '?'}  ·  fee ${transaction.feeWei === null ? '?' : formatToken(BigInt(transaction.feeWei), 18, 'ETH')}`,
      ),
    )
  }
  if (transaction.status === 'unconfirmed') {
    lines.push(
      paint('grey', `  broadcast to ${transaction.endpoint} but no receipt yet, so it may still land`),
      paint('cyan', `  pons tx ${transaction.hash}`),
    )
  }
  lines.push(paint('grey', `  ${transaction.explorer}`))
  return lines
}

export interface RunPlanOptions {
  context: CommandContext
  plan: Plan
  flags: WriteFlags
  /**
   * The account the plan is for, when it is not the signer's.
   *
   * Simulating a sell as a placeholder address reports an allowance failure
   * that says nothing about the real account, which holds the tokens and has
   * already approved the curve. Read-only modes need the real address for the
   * simulation to mean anything.
   */
  account?: Address
  /**
   * A token to add to the tracked list once the plan has actually landed.
   *
   * EVM has no `getTokenAccountsByOwner`, so `wallet balance` can only report
   * what it has been told about. Buying a token and then not seeing it in your
   * own balance is the discovery problem arriving in the one place the CLI
   * already knows the answer.
   */
  track?: Address
  /**
   * Rebuild the plan from live state immediately before broadcasting.
   *
   * Reserves move. Sending a plan built ten seconds ago is silently accepting
   * whatever the price has become since.
   *
   * Receives the plan the user accepted. The rebuild **must** carry that plan's
   * floor forward, because a freshly computed floor falls with the price, so a trade
   * can pass `recheck` and still be signed below the bound its user approved.
   */
  rebuild?: (accepted: Plan) => Promise<Plan>
  /**
   * Reject the rebuilt plan when the trade no longer clears the floor the user
   * approved. Returns the error to raise, or undefined to proceed.
   */
  recheck?: (fresh: Plan, original: Plan) => PonsError | undefined
  /** Transactions that must land before the plan, such as an approval. */
  prerequisites?: Plan[]
  /**
   * An already-unlocked signer.
   *
   * A V4 sell has to sign its Permit2 authorisation before the calldata exists,
   * so the command unlocks the key first. Passing it through means the user is
   * asked for their password once rather than twice.
   */
  signer?: Signer
}

function receiptFields(
  hash: Hex,
  receipt: TransactionReceipt | undefined,
  endpoint: string,
): NonNullable<ExecutePayload['transaction']> {
  return {
    hash,
    status: receipt === undefined ? 'unconfirmed' : receipt.status === 'success' ? 'success' : 'reverted',
    blockNumber: receipt === undefined ? null : receipt.blockNumber.toString(),
    gasUsed: receipt === undefined ? null : receipt.gasUsed.toString(),
    feeWei: receipt === undefined ? null : (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    endpoint,
    explorer: `${robinhoodChain.blockExplorers.default.url}/tx/${hash}`,
  }
}

/** Unlock the keystore. Exposed for a command that must sign before it builds. */
export async function unlockSigner(context: CommandContext): Promise<Signer> {
  return loadSigner({
    keystorePath: context.config.values['wallet.keystore'],
    env: context.resolveContext.env,
    isTTY: context.resolveContext.isTTY,
  })
}

export async function runPlan(options: RunPlanOptions): Promise<void> {
  const { context, plan, flags } = options
  const { client, pool } = context.rpc()
  const prerequisites = options.prerequisites ?? []

  const payload: ExecutePayload = {
    mode: flags.confirm === true ? 'sent' : flags.dryRun === true ? 'dry-run' : flags.unsigned === true ? 'unsigned' : 'plan',
    plan: toPayload(plan),
    prerequisites: prerequisites.map(toPayload),
  }

  // `--unsigned` hands the calldata to whoever will sign it elsewhere. It does
  // not simulate: the signer's address is not ours, and simulating as somebody
  // else would report a result that does not apply to them.
  if (payload.mode === 'unsigned') {
    context.reporter.emit(payload, render)
    return
  }

  let signer: Signer | undefined = options.signer
  if (flags.confirm === true && signer === undefined) {
    signer = await loadSigner({
      keystorePath: context.config.values['wallet.keystore'],
      env: context.resolveContext.env,
      isTTY: context.resolveContext.isTTY,
    })
  }

  // Two ways of naming the account must not disagree. `--from A` with keystore
  // B used to build the plan for A and sign it as B: a sell sized against A's
  // balance, taken out of B's tokens. Silently preferring one is a choice the
  // user did not make.
  if (
    signer !== undefined &&
    options.account !== undefined &&
    signer.address.toLowerCase() !== options.account.toLowerCase()
  ) {
    throw new PonsError('ACCOUNT_MISMATCH', 'the key you unlocked is not the account you named', {
      exitCode: ExitCode.Usage,
      details: { from: options.account, keystore: signer.address },
      hint: 'drop --from to use the keystore, or point --keystore at the key for that address',
    })
  }

  const from = signer?.address ?? options.account
  const simulation: Simulation = await simulatePlan(client, plan, {
    ...(from === undefined ? {} : { from }),
    // Funded whenever nothing is being signed: a dry run is asking whether the
    // call works, and failing it on a balance the user has not been asked for
    // answers a different question.
    fund: signer === undefined,
  })
  payload.simulation = {
    ok: simulation.ok,
    gasEstimate: simulation.gasEstimate?.toString() ?? null,
    gasLimit: simulation.gasLimit?.toString() ?? null,
    funded: simulation.funded,
    blockedByPrerequisite: !simulation.ok && prerequisites.length > 0,
    ...(simulation.revert === undefined
      ? {}
      : {
          revert: {
            name: simulation.revert.name,
            selector: simulation.revert.selector,
            message: simulation.revert.message,
          },
        }),
    ...(simulation.failure === undefined ? {} : { failure: simulation.failure }),
  }

  // A prerequisite that has not landed yet makes the main plan fail for a
  // reason that is not the plan's fault, so the simulation is reported rather
  // than raised when one is pending.
  if (!simulation.ok && prerequisites.length === 0) {
    context.reporter.emit(payload, render)
    throw simulationError(plan, simulation)
  }

  if (flags.confirm !== true || signer === undefined) {
    if (needsConfirmation(plan) && payload.mode === 'plan') {
      context.reporter.warn('this plan carries a danger-level warning; --confirm is required to send it')
    }
    context.reporter.emit(payload, render)
    return
  }

  const priorityFeeGwei = context.config.values['trade.priorityFeeGwei']
  const sent: NonNullable<ExecutePayload['transaction']>[] = []
  for (const prerequisite of prerequisites) {
    const preSimulation = await simulatePlan(client, prerequisite, { from: signer.address })
    if (!preSimulation.ok) {
      context.reporter.emit(payload, render)
      throw simulationError(prerequisite, preSimulation)
    }
    const result = await sendPlan(pool, signer, prerequisite, {
      gasLimit: prerequisite.gasLimit ?? preSimulation.gasLimit ?? 200_000n,
      priorityFeeGwei,
      onSubmitted: (hash) => context.reporter.note(`${prerequisite.kind} submitted: ${hash}`),
    })
    sent.push(receiptFields(result.hash, result.receipt, result.endpoint))
    if (result.receipt !== undefined && result.receipt.status !== 'success') {
      payload.prerequisiteTransactions = sent
      context.reporter.emit(payload, render)
      throw new PonsError('PREREQUISITE_REVERTED', `the ${prerequisite.kind} transaction reverted`, {
        exitCode: ExitCode.Revert,
        details: { hash: result.hash },
        hint: `'pons tx ${result.hash}' decodes the reason`,
      })
    }
  }
  if (sent.length > 0) payload.prerequisiteTransactions = sent

  // Rebuilt here, after any approval has landed and immediately before the
  // broadcast, so the transaction reflects the chain as it is now.
  let final = plan
  if (options.rebuild !== undefined) {
    // Handed the plan the user accepted, so the rebuild can pin its floor
    // rather than recomputing a fresh one from a price that has moved. A
    // rebuild that only re-derives its floor is how a trade ends up signed
    // below the bound its user approved.
    const fresh = await options.rebuild(plan)
    if (fresh.id !== plan.id) {
      const objection = options.recheck?.(fresh, plan)
      if (objection !== undefined) {
        context.reporter.emit(payload, render)
        throw objection
      }
      context.reporter.note(`the chain moved; rebuilt plan ${shortPlanId(fresh.id)}`)
      final = fresh
      payload.plan = toPayload(fresh)
    }
  }

  // The gas limit has to come from simulating the transaction that is about to
  // be sent, which is not the one simulated at the top: that call ran before
  // any approval had landed, so a plan with a prerequisite never produced an
  // estimate at all. Reading the limit from it made `sell --confirm` impossible
  // for anyone whose allowance was still zero, which is everyone the first
  // time. Re-simulated only when something changed, so the ordinary path still
  // costs one call.
  let gasLimit = final.gasLimit
  if (gasLimit === undefined) {
    if (sent.length === 0 && final.id === plan.id) {
      gasLimit = simulation.gasLimit
    } else {
      const ready = await simulatePlan(client, final, { from: signer.address })
      if (!ready.ok) {
        context.reporter.emit(payload, render)
        throw simulationError(final, ready)
      }
      gasLimit = ready.gasLimit
      payload.simulation.gasEstimate = ready.gasEstimate?.toString() ?? null
      payload.simulation.gasLimit = ready.gasLimit?.toString() ?? null
      payload.simulation.ok = true
      payload.simulation.blockedByPrerequisite = false
    }
  }
  if (gasLimit === undefined) {
    throw new PonsError('NO_GAS_LIMIT', 'could not determine a gas limit for this transaction', {
      exitCode: ExitCode.Network,
      details: { plan: final.id },
      hint: 'no endpoint answered eth_estimateGas for this call; try again in a moment',
    })
  }

  const result = await sendPlan(pool, signer, final, {
    gasLimit,
    priorityFeeGwei,
    onSubmitted: (hash) => context.reporter.note(`submitted: ${hash}`),
  })
  payload.transaction = receiptFields(result.hash, result.receipt, result.endpoint)

  // Only once it has landed. Tracking a token whose buy reverted would put a
  // permanent zero in every balance report.
  if (options.track !== undefined && result.receipt?.status === 'success') {
    trackToken(context, options.track)
  }

  context.reporter.emit(payload, render)

  if (result.receipt !== undefined && result.receipt.status !== 'success') {
    throw new PonsError('TRANSACTION_REVERTED', `the ${final.kind} transaction reverted`, {
      exitCode: ExitCode.Revert,
      details: { hash: result.hash },
      hint: `'pons tx ${result.hash}' decodes the reason`,
    })
  }
}

/**
 * Add a token to the tracked list, quietly and idempotently.
 *
 * A failure here must not fail the trade: the transaction has already landed
 * and the tokens are already held. An unwritable config is a nuisance, not a
 * reason to report a successful buy as an error.
 */
function trackToken(context: CommandContext, token: Address): void {
  try {
    const current = context.config.values['wallet.tracked']
    if (current.some((entry) => entry.toLowerCase() === token.toLowerCase())) return
    setConfigValue('wallet.tracked', [...current, token].join(','), context.resolveContext)
    context.reporter.note(`tracking ${token}; it will show in 'pons wallet balance'`)
  } catch {
    context.reporter.warn(`could not add ${token} to the tracked list; 'pons wallet track' still can`)
  }
}
