import { concatHex, keccak256, numberToHex, type Address, type Hex } from 'viem'

/**
 * Every write in this CLI produces a Plan before it produces a transaction.
 *
 * The Plan is the single object that read-only mode prints, `--unsigned` emits
 * as calldata, `--dry-run` simulates, and `--confirm` signs. One code path
 * builds it and three consume it, which is what stops the three modes drifting
 * into three different transactions.
 */

export type PlanKind =
  | 'approve'
  | 'launch'
  | 'buy'
  | 'sell'
  | 'graduate'
  | 'create-pool'
  | 'claim'
  | 'transfer'
  | 'sweep'
  | 'vault-release'

/** Where the transaction executes. Reported so a user is never guessing. */
export type PlanRoute = 'curve' | 'v3' | 'v4' | 'erc20' | 'factory' | 'escrow' | 'vault' | 'native'

export type WarningSeverity = 'info' | 'warn' | 'danger'

export interface PlanWarning {
  /** Stable identifier, so an agent can branch on it without parsing prose. */
  code: string
  message: string
  severity: WarningSeverity
}

export interface Plan {
  /**
   * Content hash of everything that determines what the transaction does.
   *
   * Two plans with the same id send the same bytes to the same address. The id
   * changing between building a plan and sending it is the signal that the
   * chain moved underneath it.
   */
  id: Hex
  kind: PlanKind
  route: PlanRoute
  to: Address
  data: Hex
  value: bigint
  /**
   * Fixed gas limit, when the call must not use an estimate.
   *
   * Set for native transfers, where Nitro charges the L1 posting cost out of
   * the transaction's own limit and `eth_estimateGas` does not say so.
   */
  gasLimit: bigint | undefined
  /** One line describing the trade in the units a person thinks in. */
  summary: string
  warnings: PlanWarning[]
  /** Expected outcome, in base units as strings so JSON keeps every digit. */
  economics: Record<string, string>
}

/** A plan before its id is computed. */
export type PlanDraft = Omit<Plan, 'id'>

/**
 * Hash the fields that decide what happens on chain.
 *
 * Deliberately not the summary, the warnings or the economics: those describe
 * the plan, they do not define it. Two plans that differ only in their prose
 * are the same transaction and must carry the same id.
 */
export function planId(draft: Pick<Plan, 'kind' | 'to' | 'data' | 'value' | 'gasLimit'>): Hex {
  return keccak256(
    concatHex([
      `0x${Buffer.from(draft.kind, 'utf8').toString('hex')}`,
      draft.to,
      draft.data,
      numberToHex(draft.value, { size: 32 }),
      numberToHex(draft.gasLimit ?? 0n, { size: 32 }),
    ]),
  )
}

export function createPlan(draft: PlanDraft): Plan {
  return { ...draft, id: planId(draft) }
}

/** Short form for display. The full hash stays in the JSON payload. */
export function shortPlanId(id: Hex): string {
  return id.slice(0, 10)
}

export function warn(code: string, message: string, severity: WarningSeverity = 'warn'): PlanWarning {
  return { code, message, severity }
}

/** True when any warning is severe enough to require an explicit confirmation. */
export function needsConfirmation(plan: Plan): boolean {
  return plan.warnings.some((warning) => warning.severity === 'danger')
}
