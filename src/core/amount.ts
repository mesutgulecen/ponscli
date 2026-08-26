import { parseUnits } from 'viem'

import { UsageError } from '../errors.js'

/**
 * Amounts as a person types them.
 *
 * `0.05`, `all`, `50%`. Everything is converted to base units immediately and
 * stays there — a float that has been through `Number` has already lost digits
 * a token balance needs.
 */

const DECIMAL = /^\d+(\.\d+)?$/
const PERCENT = /^(\d+(\.\d+)?)%$/

export interface AmountSpec {
  kind: 'absolute' | 'percent' | 'all'
  /** Base units, for `absolute`. */
  value: bigint
  /** Basis points of the balance, for `percent`. */
  bps: bigint
}

/**
 * Parse an amount that may be relative to a balance.
 *
 * Resolving the percentage is deliberately not done here: it needs the balance,
 * which needs the network, and a parse error should be reported before a
 * request goes out.
 */
export function parseAmountSpec(raw: string, decimals: number, label = 'amount'): AmountSpec {
  const text = raw.trim().toLowerCase()
  if (text === 'all' || text === 'max' || text === '100%') {
    return { kind: 'all', value: 0n, bps: 10_000n }
  }

  const percent = PERCENT.exec(text)
  if (percent !== null) {
    const value = Number(percent[1])
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      throw new UsageError(`${label} percentage must be between 0 and 100, got ${raw}`)
    }
    return { kind: 'percent', value: 0n, bps: BigInt(Math.round(value * 100)) }
  }

  if (!DECIMAL.test(text)) {
    throw new UsageError(`${label} must be a number, a percentage, or 'all' — got ${raw}`, {
      hint: "for example 0.05, 50%, or all",
    })
  }
  const value = parseUnits(text, decimals)
  if (value <= 0n) throw new UsageError(`${label} must be greater than zero`)
  return { kind: 'absolute', value, bps: 0n }
}

/** Resolve a spec against a balance. */
export function resolveAmount(spec: AmountSpec, balance: bigint): bigint {
  if (spec.kind === 'absolute') return spec.value
  if (spec.kind === 'all') return balance
  return (balance * spec.bps) / 10_000n
}

/** Parse a plain amount that cannot be relative, such as an ETH transfer. */
export function parseAmount(raw: string, decimals: number, label = 'amount'): bigint {
  const spec = parseAmountSpec(raw, decimals, label)
  if (spec.kind !== 'absolute') {
    throw new UsageError(`${label} must be an absolute amount here, not ${raw}`)
  }
  return spec.value
}
