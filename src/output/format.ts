import { formatUnits } from 'viem'

/**
 * Human-readable renderings of chain values.
 *
 * Every function here is for human output only. JSON output carries the raw
 * value — a base-unit string for anything that came off the chain — because a
 * consumer that has to parse `1,234.5678 ETH` back into wei has been handed a
 * worse representation than the one we started with.
 */

/** Significant digits kept for a value of one or more. */
const SIGNIFICANT_LARGE = 6
/** Significant digits kept after the leading zeros of a value below one. */
const SIGNIFICANT_SMALL = 4

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Render a base-unit amount at a fixed scale.
 *
 * Digits are truncated rather than rounded: this prints balances and quotes,
 * and a display that rounds up says the user has more than they do. The
 * significant-digit rule keeps a token supply readable (`1,000,000,000`)
 * without flattening a price to zero (`0.000000001680`).
 */
export function formatAmount(value: bigint, decimals: number): string {
  const exact = formatUnits(value < 0n ? -value : value, decimals)
  const sign = value < 0n ? '-' : ''
  const [whole = '0', fraction = ''] = exact.split('.')

  const keep =
    whole === '0'
      ? // Leading zeros are not significant, so count past them before
        // deciding how much of the fraction to keep.
        (fraction.match(/^0*/)?.[0].length ?? 0) + SIGNIFICANT_SMALL
      : Math.max(0, SIGNIFICANT_LARGE - whole.length)

  const kept = fraction.slice(0, keep).replace(/0+$/, '')
  return `${sign}${group(whole)}${kept === '' ? '' : `.${kept}`}`
}

/** Amount plus its unit, as a single cell. */
export function formatToken(value: bigint, decimals: number, symbol: string): string {
  return `${formatAmount(value, decimals)} ${symbol}`
}

/**
 * Basis points as a percentage.
 *
 * Protocol values are integers in bps, so this never needs more than two
 * decimal places and drops them when they are zero: 100 bps is `1%`, not
 * `1.00%`.
 */
export function formatBps(bps: bigint | number): string {
  const value = BigInt(bps)
  const whole = value / 100n
  const remainder = value % 100n
  if (remainder === 0n) return `${whole.toString()}%`
  return `${whole.toString()}.${remainder.toString().padStart(2, '0').replace(/0$/, '')}%`
}

/** A ratio in [0,1] as a percentage with one decimal place. */
export function formatRatio(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) return '-'
  // Scaled integer arithmetic: these are wei-denominated values well past the
  // range where a float divide keeps every digit.
  const tenths = (numerator * 1000n) / denominator
  return `${(Number(tenths) / 10).toFixed(1)}%`
}

const UNITS: [bigint, string][] = [
  [86_400n, 'd'],
  [3_600n, 'h'],
  [60n, 'm'],
  [1n, 's'],
]

/**
 * A duration in seconds, to two units of precision.
 *
 * Two units because one is too coarse to act on (`2h` when it is 2h59m) and
 * three is noise at every scale this CLI reports.
 */
export function formatDuration(seconds: bigint): string {
  if (seconds <= 0n) return '0s'
  const parts: string[] = []
  let left = seconds
  for (const [size, suffix] of UNITS) {
    const count = left / size
    if (count > 0n) {
      parts.push(`${count.toString()}${suffix}`)
      left %= size
    }
    if (parts.length === 2) break
  }
  return parts.join(' ')
}

/** How long ago a block timestamp was, relative to `now`. */
export function formatAge(timestamp: bigint, now: bigint): string {
  const elapsed = now - timestamp
  if (elapsed < 0n) return 'in the future'
  return `${formatDuration(elapsed)} ago`
}

/** `0x1234…cdef` — enough to recognise an address, short enough for a table. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
