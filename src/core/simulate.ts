import type { Address, Hex, PublicClient } from 'viem'

import { NATIVE_TRANSFER_GAS_LIMIT } from '../chain/definition.js'
import { ExitCode, PonsError } from '../errors.js'
import type { Plan } from './plan.js'
import { decodeRevert, type DecodedRevert } from './revert.js'

/**
 * Run a plan without sending it.
 *
 * Two things happen here that a bare `eth_estimateGas` does not do. The call is
 * replayed first so a revert comes back as a named error rather than as
 * "execution reverted", and the gas figure is padded, because on this chain the
 * estimate is not the whole cost.
 */

/**
 * Headroom added to an estimated gas limit.
 *
 * Nitro charges the L1 posting cost out of the transaction's own gas limit and
 * `eth_estimateGas` does not include all of it, measured on plain transfers,
 * where the node answers 21,000 for a transfer that burns up to 21,145. The
 * same shortfall applies to calldata-heavy contract calls, and unspent gas is
 * refunded, so the padding costs nothing but protects against the intermittent
 * `intrinsic gas too low` that only appears when L1 is expensive.
 */
const GAS_HEADROOM_BPS = 2500n

export interface Simulation {
  ok: boolean
  /** Gas limit to sign with: the padded estimate, or the plan's fixed limit. */
  gasLimit: bigint | undefined
  /** Raw estimate before padding, for reporting. */
  gasEstimate: bigint | undefined
  revert: DecodedRevert | undefined
  /**
   * The node's own words, when the call failed without a revert payload.
   *
   * Not every failed `eth_call` is a revert, and the difference matters to
   * whoever reads it: a revert is the contract saying no, while this is the
   * node saying the call never got that far. Throwing the message away and
   * reporting "reverted without returning a reason" sends a user looking for a
   * contract bug that is not there.
   */
  failure: string | undefined
  /** Set when the failure was the sender being unable to pay. */
  funds: { have: bigint; want: bigint } | undefined
  /** Value the call returned, when it returned one. */
  returnData: Hex | undefined
  /**
   * True when the simulation was given a synthetic balance.
   *
   * A plan can be simulated with no wallet at all, which is what `--dry-run`
   * does. That has to be visible: "it would succeed" means something different
   * when the account was handed the funds for the duration of the call.
   */
  funded: boolean
}

export interface SimulateOptions {
  /** The address that would send it. Defaults to a placeholder. */
  from?: Address
  /**
   * Give the sender enough balance to cover the call.
   *
   * On by default when no `from` is given: without it every dry run of a buy
   * fails on funds before it reaches the contract, which tells the user
   * nothing about whether the trade itself works.
   */
  fund?: boolean
}

/**
 * How this chain reports a sender that cannot pay.
 *
 * Measured against the official endpoint on 2026-08-26, from an account with a
 * zero balance: `-32000 err: insufficient funds for gas * price + value:
 * address 0x… have 0 want 1000000000000000 (supplied gas 50000000)`. Both
 * figures are worth keeping: "you are short" is more useful with the amount.
 */
const FUNDS_PATTERN = /insufficient funds[^]*?have (\d+) want (\d+)/i

/** Stands in for a wallet when there is none. Holds nothing, signs nothing. */
const PLACEHOLDER: Address = '0x000000000000000000000000000000000000dEaD'

function padGas(estimate: bigint): bigint {
  return estimate + (estimate * GAS_HEADROOM_BPS) / 10_000n
}

/**
 * The innermost thing the node said, out of viem's nested error chain.
 *
 * `details` carries the JSON-RPC error body where viem has one; `message` is
 * the fallback. The deepest is the most specific, so the walk keeps going.
 */
function failureMessageOf(error: unknown): string | undefined {
  let current: unknown = error
  let best: string | undefined
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== 'object') break
    const details = (current as { details?: unknown }).details
    if (typeof details === 'string' && details.length > 0) best = details
    else if (best === undefined) {
      const message = (current as { message?: unknown }).message
      if (typeof message === 'string' && message.length > 0) best = message
    }
    current = (current as { cause?: unknown }).cause
  }
  return best?.replace(/^err:\s*/, '')
}

/** Pull the revert payload out of viem's nested error chain. */
function revertDataOf(error: unknown): Hex | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== 'object') return undefined
    const data = (current as { data?: unknown }).data
    if (typeof data === 'string' && data.startsWith('0x') && data.length > 2) return data as Hex
    if (data !== null && typeof data === 'object') {
      const inner = (data as { data?: unknown }).data
      if (typeof inner === 'string' && inner.startsWith('0x') && inner.length > 2) return inner as Hex
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

export async function simulatePlan(
  client: PublicClient,
  plan: Plan,
  options: SimulateOptions = {},
): Promise<Simulation> {
  const from = options.from ?? PLACEHOLDER
  const fund = options.fund ?? options.from === undefined
  // Enough to cover any plan's value plus its gas, without pretending to a
  // balance so large it would change how the contract behaves.
  const override = fund
    ? [{ address: from, balance: plan.value + 10n ** 18n }]
    : undefined

  const request = {
    account: from,
    to: plan.to,
    data: plan.data,
    value: plan.value,
    ...(override === undefined ? {} : { stateOverride: override }),
  } as const

  let returnData: Hex | undefined
  try {
    const result = await client.call(request)
    returnData = result.data
  } catch (error) {
    const data = revertDataOf(error)
    // A failure with no revert payload is not necessarily a revert; it can be
    // insufficient funds or a malformed call. When there is no payload the
    // node's own message is the only honest thing to report.
    const failure = data === undefined ? failureMessageOf(error) : undefined
    const short = failure === undefined ? null : FUNDS_PATTERN.exec(failure)
    return {
      ok: false,
      gasLimit: undefined,
      gasEstimate: undefined,
      revert: data === undefined ? undefined : decodeRevert(data),
      ...(failure === undefined ? { failure: undefined } : { failure }),
      funds:
        short === null
          ? undefined
          : { have: BigInt(short[1] ?? '0'), want: BigInt(short[2] ?? '0') },
      returnData: undefined,
      funded: fund,
    }
  }

  let gasEstimate: bigint | undefined
  try {
    gasEstimate = await client.estimateGas(request)
  } catch {
    // The call succeeded, so this is not a contract failure; some endpoints
    // simply refuse `eth_estimateGas` with a state override attached. The plan
    // falls back to its own limit, or to the node's default at send time.
    gasEstimate = undefined
  }

  return {
    ok: true,
    gasLimit: plan.gasLimit ?? (gasEstimate === undefined ? undefined : padGas(gasEstimate)),
    gasEstimate,
    revert: undefined,
    failure: undefined,
    funds: undefined,
    returnData,
    funded: fund,
  }
}

/**
 * Turn a failed simulation into the error the command reports.
 *
 * The exit code separates "the chain answered and the answer was a revert"
 * from every other kind of failure, because a script retrying a revert is
 * retrying something that will fail again.
 */
export function simulationError(plan: Plan, simulation: Simulation): PonsError {
  // Being unable to pay is not the contract's answer, and a caller that treats
  // it as one goes looking in the wrong place. It gets its own code.
  if (simulation.funds !== undefined) {
    const { have, want } = simulation.funds
    return new PonsError('INSUFFICIENT_FUNDS', `the account cannot pay for this ${plan.kind}`, {
      exitCode: ExitCode.Funds,
      details: { plan: plan.id, have: have.toString(), want: want.toString() },
      hint: 'fund the account, or ask for less; the figures are in wei, gas included',
    })
  }
  const revert = simulation.revert
  const reason = revert?.message ?? simulation.failure ?? 'unknown reason'
  return new PonsError('SIMULATION_FAILED', `${plan.kind} would fail: ${reason}`, {
    exitCode: ExitCode.Revert,
    details: {
      plan: plan.id,
      ...(revert?.name === undefined || revert.name === null ? {} : { error: revert.name }),
      ...(revert?.selector === undefined || revert.selector === null ? {} : { selector: revert.selector }),
      ...(revert === undefined || revert.args.length === 0 ? {} : { args: revert.args }),
    },
    ...(revert?.hint === undefined ? {} : { hint: revert.hint }),
  })
}

/** The gas limit a native transfer must be signed with. Never an estimate. */
export const NATIVE_TRANSFER_GAS = NATIVE_TRANSFER_GAS_LIMIT
