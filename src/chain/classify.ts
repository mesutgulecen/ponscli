/**
 * Error classification for the RPC waterfall.
 *
 * Every decision here comes from measured endpoint behaviour or from probing
 * Robinhood Chain directly; the rationale for each is in
 * `docs/architecture/ponscli.md`. The single most important
 * distinction is between *the endpoint failed* and *the endpoint answered, and
 * the answer was no*. Conflating them cascades a whole tier out of service on a
 * benign revert.
 */

/** What the pool should do with a failed attempt. */
export type Verdict =
  /**
   * Any node would give this answer. Hand it to the caller immediately.
   *
   * Measured across 12 providers and 11,280 observations: zero cases of one
   * node reverting where another succeeded. Walking anyway cost ~13 seconds of
   * sleeping across ~26 providers to arrive at the same reply.
   */
  | { action: 'return'; reason: ReturnReason }
  /**
   * This endpoint cannot serve the request. Try the next one, and hold this
   * one out of rotation for `parkMs` (zero when it is not at fault).
   */
  | { action: 'walk'; reason: WalkReason; parkMs: number; detail?: HeadSkew }

export type ReturnReason = 'revert' | 'invalid-params' | 'invalid-request' | 'sender'

export type WalkReason =
  /** Connection refused, DNS failure, socket reset — no answer at all. */
  | 'transport'
  | 'timeout'
  /** HTTP 429, or a body that says rate limited. */
  | 'throttle'
  /** Plan or credit allowance used up. Time does not fix this quickly. */
  | 'quota'
  /** Rejected credential. Will not fix itself. */
  | 'durable'
  /** The node is behind the block we asked for. It is healthy, just late. */
  | 'head-skew'
  /** `-32601` — this node does not serve this method. */
  | 'unsupported-method'
  /** State older than this node retains. Only an archive node can answer. */
  | 'pruned'
  /** The log range exceeded what this endpoint accepts. */
  | 'log-range'
  /** An error reply we have no rule for. Walk, but do not blame the endpoint. */
  | 'unknown'

export interface HeadSkew {
  requested?: bigint
  head?: bigint
}

/**
 * How long a failing endpoint stays out of rotation, per reason.
 *
 * The 30-second figure for throttling is the load-bearing one. Free endpoints
 * are token buckets; parking one for an hour after a single 429 cost roughly
 * half of total pool availability under live load. Durable and quota failures do
 * not recover on a 30-second timescale, so they get the long park.
 */
export const PARK_MS: Record<WalkReason, number> = {
  durable: 60 * 60_000,
  quota: 60 * 60_000,
  throttle: 30_000,
  transport: 5_000,
  timeout: 5_000,
  // Not faults. The endpoint is healthy; it simply cannot serve this one
  // request, and parking it would remove a working node from the pool.
  'head-skew': 0,
  'unsupported-method': 0,
  pruned: 0,
  'log-range': 0,
  // A JSON-RPC error reply means the server answered. HTTP 200 with an error
  // body is not evidence of ill health, so an unrecognised one parks nothing.
  unknown: 0,
}

interface ErrorFacts {
  httpStatus: number | undefined
  rpcCode: number | undefined
  message: string
  timedOut: boolean
  networkFailure: boolean
}

const NETWORK_HINTS =
  /fetch failed|network ?error|socket hang up|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|other side closed|terminated/i

const TIMEOUT_HINTS = /timed? ?out|timeout|aborted|AbortError/i

/**
 * Pull the facts we classify on out of whatever was thrown.
 *
 * Duck-typed rather than matched against viem's error classes: the same fields
 * arrive from `fetch`, from viem, and from a hand-rolled test double, and the
 * classifier should not care which produced them.
 */
export function extractFacts(error: unknown): ErrorFacts {
  const facts: ErrorFacts = {
    httpStatus: undefined,
    rpcCode: undefined,
    message: '',
    timedOut: false,
    networkFailure: false,
  }

  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error

  for (let depth = 0; depth < 12 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)

    if (typeof current === 'string') {
      messages.push(current)
      break
    }
    if (typeof current !== 'object') break

    const node = current as Record<string, unknown>
    if (typeof node['message'] === 'string') messages.push(node['message'])
    if (typeof node['details'] === 'string') messages.push(node['details'])
    if (typeof node['shortMessage'] === 'string') messages.push(node['shortMessage'])
    if (typeof node['name'] === 'string' && /timeout/i.test(node['name'])) facts.timedOut = true

    const status = node['status']
    if (facts.httpStatus === undefined && typeof status === 'number') facts.httpStatus = status

    const code = node['code']
    if (typeof code === 'number' && facts.rpcCode === undefined) {
      facts.rpcCode = code
    } else if (typeof code === 'string' && NETWORK_HINTS.test(code)) {
      facts.networkFailure = true
    }

    current = node['cause']
  }

  facts.message = messages.join(' | ')
  if (TIMEOUT_HINTS.test(facts.message)) facts.timedOut = true
  if (NETWORK_HINTS.test(facts.message)) facts.networkFailure = true
  return facts
}

/** Pull "requested N, head M" out of a head-skew message, when it says so. */
function readHeadSkew(message: string): HeadSkew {
  const numbers = message.match(/\b\d{5,}\b/g)
  if (numbers === null || numbers.length < 2) return {}
  return { requested: BigInt(numbers[0]), head: BigInt(numbers[1] as string) }
}

const RATE_LIMIT = /rate.?limit|too many requests|rate_limited|throttl/i
const QUOTA = /quota|monthly limit|capacity exceeded|out of credits|compute units|daily limit|plan limit/i
const AUTH = /unauthorized|forbidden|invalid api key|invalid key|authentication|must be authenticated|api key is required|access denied/i
const REVERT = /execution reverted|revert(ed)?\b/i
/**
 * The node refusing a call on the sender's own account, not on the contract.
 *
 * Every node computes these from the same chain state, so they are as
 * deterministic as a revert and walking past one buys nothing: measured on
 * 2026-08-26, a buy from an account holding zero walked both free endpoints and
 * ended as `NO_PAID_FALLBACK` — and with a paid tier configured it would have
 * billed for the identical answer. That is the "outage into an invoice" case
 * this layer exists to avoid, arriving through the front door.
 */
const SENDER = /insufficient funds|intrinsic gas too low|max fee per gas less than block base fee|gas required exceeds allowance/i
/** State the node no longer retains. Robinhood Chain answers `metadata is not found`. */
const PRUNED = /metadata is not found|missing trie node|header not found|state (is )?not available|pruned|no historical/i
const HEAD_SKEW = /beyond current head|greater than (the )?(current |latest )?head|block (number )?is (in the )?future|not yet (been )?(mined|available)|unknown block/i
const LOG_RANGE = /(block|log|query) range|range is too (large|wide)|too many (logs|results)|exceeds? (the )?maximum|limit exceeded/i

function walk(reason: WalkReason, detail?: HeadSkew): Verdict {
  const verdict: Verdict = { action: 'walk', reason, parkMs: PARK_MS[reason] }
  return detail === undefined ? verdict : { ...verdict, detail }
}

/**
 * Decide what a failed attempt means.
 *
 * Order matters. Transport-level facts are checked before reply-level ones
 * because an HTTP 429 carries no JSON-RPC body to inspect, and a revert must be
 * recognised before the generic `-32000` bucket swallows it.
 */
export function classify(error: unknown): Verdict {
  const facts = extractFacts(error)
  const { httpStatus, rpcCode, message } = facts

  if (facts.timedOut) return walk('timeout')

  if (httpStatus !== undefined) {
    if (httpStatus === 401 || httpStatus === 403) return walk('durable')
    if (httpStatus === 402) return walk('quota')
    if (httpStatus === 429) return walk('throttle')
    if (httpStatus >= 500) return walk('transport')
    if (httpStatus === 400 && LOG_RANGE.test(message)) return walk('log-range')
    if (httpStatus >= 400) {
      // A 4xx we have no rule for still means this endpoint refused. Walking
      // without parking keeps it available for requests it can serve.
      return walk('unknown')
    }
  }

  // From here the server replied. Anything below is a JSON-RPC error body,
  // which is an answer, not a health signal.
  if (REVERT.test(message)) return { action: 'return', reason: 'revert' }
  if (SENDER.test(message)) return { action: 'return', reason: 'sender' }

  if (rpcCode === -32601) return walk('unsupported-method')

  if (PRUNED.test(message)) {
    // Not deterministic: Tier 1 is pruned but an archive node answers this.
    // Classifying it as a revert would strand every historical query.
    return walk('pruned')
  }

  if (HEAD_SKEW.test(message)) return walk('head-skew', readHeadSkew(message))

  if (RATE_LIMIT.test(message)) return walk('throttle')
  if (QUOTA.test(message)) return walk('quota')
  if (AUTH.test(message)) return walk('durable')
  if (LOG_RANGE.test(message)) return walk('log-range')

  if (rpcCode === -32602) return { action: 'return', reason: 'invalid-params' }
  if (rpcCode === -32600) return { action: 'return', reason: 'invalid-request' }
  if (rpcCode === 3) return { action: 'return', reason: 'revert' }
  if (rpcCode === -32005) return walk('throttle')

  if (facts.networkFailure) return walk('transport')
  if (rpcCode !== undefined) return walk('unknown')
  return walk('transport')
}

/**
 * The most specific human-readable text available for an error.
 *
 * viem wraps an RPC error in a generic shortMessage ("Missing or invalid
 * parameters.") and keeps the node's own words in `details`. The node's words
 * are what a user needs — "metadata is not found" says pruning, the wrapper
 * says nothing. Innermost wins, and whitespace is collapsed so the result fits
 * one table cell.
 */
export function describeError(error: unknown): string {
  const seen = new Set<unknown>()
  let current: unknown = error
  let best: string | undefined
  let fallback: string | undefined

  for (let depth = 0; depth < 12 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== 'object' || seen.has(current)) break
    seen.add(current)
    const node = current as Record<string, unknown>
    if (typeof node['details'] === 'string' && node['details'] !== '') best = node['details']
    if (fallback === undefined && typeof node['shortMessage'] === 'string') {
      fallback = node['shortMessage']
    }
    if (fallback === undefined && typeof node['message'] === 'string') fallback = node['message']
    current = node['cause']
  }

  const text = best ?? fallback ?? String(error)
  return text.replace(/\s+/g, ' ').trim()
}
