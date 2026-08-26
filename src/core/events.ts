import {
  erc20Abi,
  parseEventLogs,
  toEventSelector,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
} from 'viem'

import { formatToken } from '../output/format.js'
import {
  buybackVaultAbi,
  feeEscrowAbi,
  launchAndBuyAbi,
  memeHookAbi,
  v1LockerAbi,
  v1TokenAbi,
  v3PoolAbi,
  v1FactoryAbi,
  v2CurveAbi,
  v2FactoryAbi,
  v2TokenAbi,
} from '../abi/index.js'
import { unitOf, type Unit, type Units } from './units.js'

/**
 * Naming the logs a transaction emitted.
 *
 * Same principle as the revert decoder: the topic-to-name mapping comes out of
 * the committed ABIs, never a hand-written list, so it cannot fall behind a
 * redeployment. A log nothing matches is reported as unmatched rather than
 * dropped — a receipt that quietly hides half its events is worse than one that
 * admits it does not recognise them.
 */

const KNOWN_ABIS: { source: string; abi: Abi }[] = [
  { source: 'curve', abi: v2CurveAbi },
  { source: 'factory', abi: v2FactoryAbi },
  { source: 'token', abi: v2TokenAbi },
  { source: 'hook', abi: memeHookAbi },
  { source: 'escrow', abi: feeEscrowAbi },
  { source: 'vault', abi: buybackVaultAbi },
  { source: 'launch router', abi: launchAndBuyAbi },
  { source: 'v1 factory', abi: v1FactoryAbi },
  { source: 'v1 token', abi: v1TokenAbi },
  { source: 'v1 locker', abi: v1LockerAbi },
  { source: 'v3 pool', abi: v3PoolAbi },
  { source: 'erc20', abi: erc20Abi },
]

/** topic0 → which contract declares it. Duplicates keep the first source. */
const SOURCE_BY_TOPIC = new Map<Hex, string>()

/** Every event the CLI can name, flattened for `parseEventLogs`. */
const EVENT_ABI: AbiEvent[] = (() => {
  const events: AbiEvent[] = []
  const seen = new Set<Hex>()
  for (const { source, abi } of KNOWN_ABIS) {
    for (const item of abi) {
      if (item.type !== 'event') continue
      const topic = toEventSelector(item)
      if (!SOURCE_BY_TOPIC.has(topic)) SOURCE_BY_TOPIC.set(topic, source)
      // One entry per topic: a second copy of the same event would make
      // `parseEventLogs` return the log twice.
      if (seen.has(topic)) continue
      seen.add(topic)
      events.push(item)
    }
  }
  return events
})()

export interface DecodedLog {
  index: number
  address: Address
  /** Event name, or null when no known ABI declares this topic. */
  name: string | null
  /** Which contract the name came from. */
  source: string | null
  topic0: Hex | null
  /** Arguments as strings, in ABI order, so they survive JSON unchanged. */
  args: Record<string, string>
}

function stringify(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(stringify).join(',')
  return JSON.stringify(value) ?? String(value)
}

/**
 * Decode a receipt's logs, keeping the ones that did not match.
 *
 * `strict: false` so an event whose non-indexed data does not decode still
 * comes back named. The alternative is silently discarding it, which reads to
 * the user as "the transaction did not emit that".
 */
export function decodeLogs(logs: readonly Log[]): DecodedLog[] {
  const parsed = parseEventLogs({ abi: EVENT_ABI, logs: [...logs], strict: false })
  // Keyed by block as well as position. Within one receipt `logIndex` is
  // unique and the block adds nothing, but a historical scan hands this logs
  // from thousands of blocks and every one of them has a `logIndex` of zero
  // somewhere — keyed on the index alone, most of them would take the wrong
  // decode.
  const key = (log: { blockHash?: Hex | null; logIndex?: number | null }): string =>
    `${log.blockHash ?? ''}:${String(log.logIndex ?? '')}`
  const byIndex = new Map(parsed.map((log) => [key(log), log]))

  return logs.map((log, position) => {
    const index = Number(log.logIndex ?? position)
    const match = byIndex.get(key(log))
    const topic0 = (log.topics[0] ?? null)
    if (match === undefined) {
      return { index, address: log.address, name: null, source: null, topic0, args: {} }
    }
    const args = match.args as Record<string, unknown> | readonly unknown[] | undefined
    return {
      index,
      address: log.address,
      name: match.eventName,
      source: topic0 === null ? null : (SOURCE_BY_TOPIC.get(topic0) ?? null),
      topic0,
      args:
        args === undefined || Array.isArray(args)
          ? {}
          : Object.fromEntries(
              Object.entries(args as Record<string, unknown>).map(([key, value]) => [
                key,
                stringify(value),
              ]),
            ),
    }
  })
}

/**
 * Which log arguments are amounts, and what they are denominated in.
 *
 * Written by hand because no ABI records it: `uint256` is the type of a token
 * amount, a fee and a timestamp alike. `self` means the emitting contract is
 * the asset, which is the ERC-20 case; `token` and `quote` are the two sides of
 * the curve that emitted the log. Anything absent from this table prints raw —
 * an unscaled number is a nuisance, a wrongly scaled one is a lie.
 */
const AMOUNT_ARGS: Record<string, Record<string, 'self' | 'token' | 'quote'>> = {
  Transfer: { value: 'self' },
  Approval: { value: 'self' },
  CurveBuy: { quoteIn: 'quote', tokensOut: 'token', fee: 'quote', tax: 'quote' },
  CurveSell: { tokensIn: 'token', quoteOut: 'quote', fee: 'quote', tax: 'quote' },
  CurveBuyRefunded: { refund: 'quote' },
  CurveCompleted: { quoteOut: 'quote', tokenOut: 'token' },
  SnipeTaxCharged: { amount: 'quote' },
  BuybackLocked: { quoteSpent: 'quote', tokensLocked: 'token' },
  FeesSwept: { protocolAmount: 'quote', buybackAmount: 'quote', creatorAmount: 'quote' },
  FeesRescued: { protocolAmount: 'quote', creatorAmount: 'quote' },
  // A V3 pool's amounts are signed and ordered by the pool's own sorting, so
  // `amount0` is whichever token sorted first — which is what `token` means
  // for a pool in `Units`. Negative is the pool paying out.
  Swap: { amount0: 'token', amount1: 'quote' },
  Mint: { amount0: 'token', amount1: 'quote' },
  Burn: { amount0: 'token', amount1: 'quote' },
  Collect: { amount0: 'token', amount1: 'quote' },
}

/**
 * The log's arguments with amounts scaled and named.
 *
 * For human output only. The JSON payload keeps the base-unit strings, because
 * that is the form a caller can do arithmetic on.
 */
export function displayArgs(log: DecodedLog, units: Units): Record<string, string> {
  const denominations = log.name === null ? undefined : AMOUNT_ARGS[log.name]
  if (denominations === undefined) return log.args

  const curve = units.curves.get(log.address.toLowerCase())
  const resolve = (side: 'self' | 'token' | 'quote'): Unit | undefined => {
    if (side === 'self') return unitOf(units, log.address)
    if (curve === undefined) return undefined
    return unitOf(units, side === 'token' ? curve.token : curve.quote)
  }

  return Object.fromEntries(
    Object.entries(log.args).map(([key, value]) => {
      const side = denominations[key]
      if (side === undefined) return [key, value]
      const unit = resolve(side)
      if (unit === undefined) return [key, value]
      return [key, formatToken(BigInt(value), unit.decimals, unit.symbol)]
    }),
  )
}

/** Number of distinct events the CLI can name. Exposed for a test. */
export function knownEventCount(): number {
  return EVENT_ABI.length
}
