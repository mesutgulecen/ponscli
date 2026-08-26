import type { Clock } from './headSkew.js'
import type { WalkReason } from './classify.js'
import { endpointLabel, redactUrl } from './redact.js'

export type Tier = 1 | 2

export interface EndpointCapabilities {
  /**
   * Whether this endpoint serves `eth_getLogs` over meaningful ranges.
   *
   * False does not mean the method is missing — it means sending a real query
   * here is a guaranteed wasted round trip. Free Alchemy caps `getLogs` at ten
   * blocks; nodeflare answers `rate_limited` at ten thousand.
   */
  logs: boolean
  /**
   * Blocks of historical state the node retains, when known.
   *
   * The official Robinhood endpoint prunes: state older than roughly 6,000 to
   * 10,000 blocks answers `-32000 "metadata is not found"`. At ~0.1 s per block
   * that is only ten to seventeen minutes of history. The conservative end of
   * the measured range is used so we skip an endpoint only when it certainly
   * cannot answer.
   */
  stateWindowBlocks?: number
  /**
   * Minimum spacing between requests this endpoint will accept, when metered.
   *
   * nodeflare's free tier states its own limit in the 429 body: one request per
   * ten seconds per IP. Discovering that by getting throttled costs a round trip
   * every time; spacing requests instead costs nothing and keeps the endpoint
   * genuinely usable as relief when the primary is stalled.
   */
  minIntervalMs?: number
}

export interface EndpointSpec {
  url: string
  tier: Tier
  capabilities: EndpointCapabilities
  /** Where the URL came from, shown by `pons doctor`. */
  origin: 'user' | 'default' | 'paid'
}

const FULL: EndpointCapabilities = { logs: true }

/**
 * Capabilities measured per host on 2026-08-25.
 *
 * Keyed by host so that a user overriding `rpc.endpoints` still gets the
 * measured behaviour for endpoints we know, and optimistic defaults with
 * runtime learning for ones we do not.
 */
const KNOWN: Record<string, EndpointCapabilities> = {
  'rpc.mainnet.chain.robinhood.com': { logs: true, stateWindowBlocks: 6_000 },
  // Re-measured 2026-08-25 with a User-Agent set and requests spaced out: this
  // endpoint serves a 1,000,000-block `eth_getLogs` returning 3,599 logs, and
  // answers `eth_getBalance` 50,000 blocks back where the official endpoint
  // prunes. An earlier reading of `rate_limited` on a 10,000-block query was the
  // per-IP rate limit, not a range cap — the capability was fine, the pacing was
  // not. No `stateWindowBlocks`, so historical reads are routed here in
  // preference to the paid tier despite the metering.
  'rpc.nodeflare.app': { logs: true, minIntervalMs: 10_000 },
}

export function capabilitiesFor(url: string): EndpointCapabilities {
  try {
    return KNOWN[new URL(url).host] ?? FULL
  } catch {
    return FULL
  }
}

export interface EndpointStats {
  attempts: number
  successes: number
  /** Deterministic replies returned to the caller without walking. */
  determinate: number
  walks: number
  byReason: Partial<Record<WalkReason, number>>
  totalLatencyMs: number
  lastLatencyMs: number | undefined
}

/**
 * One endpoint's live state: whether it is in rotation, what it has refused,
 * and what it has cost us.
 *
 * Health is tracked here rather than inferred per request because a park has
 * to outlive the request that caused it — that is the entire point of parking.
 */
export class Endpoint {
  readonly url: string
  readonly tier: Tier
  readonly origin: EndpointSpec['origin']
  readonly capabilities: EndpointCapabilities
  /** Host only, safe to print. */
  readonly label: string
  /** Full URL with credentials masked, safe to print. */
  readonly safeUrl: string

  /** Methods this endpoint answered `-32601` for. Never retried this session. */
  readonly unsupported = new Set<string>()

  private parkedUntilMs = 0
  private parkReasonValue: WalkReason | undefined
  /** Highest block this endpoint has been observed to have pruned. */
  private prunedBelowValue: bigint | undefined
  /** Narrowest `eth_getLogs` span this endpoint has rejected, minus one. */
  private logRangeLimitValue: number | undefined
  private lastUsedAtMs = 0

  readonly stats: EndpointStats = {
    attempts: 0,
    successes: 0,
    determinate: 0,
    walks: 0,
    byReason: {},
    totalLatencyMs: 0,
    lastLatencyMs: undefined,
  }

  constructor(
    spec: EndpointSpec,
    private readonly clock: Clock = Date.now,
  ) {
    this.url = spec.url
    this.tier = spec.tier
    this.origin = spec.origin
    this.capabilities = spec.capabilities
    this.label = endpointLabel(spec.url)
    this.safeUrl = redactUrl(spec.url)
  }

  isParked(): boolean {
    if (this.parkedUntilMs === 0) return false
    if (this.parkedUntilMs > this.clock()) return true
    this.parkedUntilMs = 0
    this.parkReasonValue = undefined
    return false
  }

  get parkedUntil(): number {
    return this.parkedUntilMs
  }

  get parkReason(): WalkReason | undefined {
    return this.isParked() ? this.parkReasonValue : undefined
  }

  /**
   * Hold this endpoint out of rotation.
   *
   * A longer park never shortens an existing one: two failures in a row should
   * not let the second, milder verdict release an endpoint the first ruled out.
   */
  park(reason: WalkReason, ms: number): void {
    if (ms <= 0) return
    const until = this.clock() + ms
    if (until <= this.parkedUntilMs) return
    this.parkedUntilMs = until
    this.parkReasonValue = reason
  }

  release(): void {
    this.parkedUntilMs = 0
    this.parkReasonValue = undefined
  }

  recordAttempt(): void {
    this.stats.attempts += 1
    this.lastUsedAtMs = this.clock()
  }

  /**
   * Whether this endpoint's metered interval has elapsed.
   *
   * Unmetered endpoints are always ready. This is a preference, not a bar: the
   * pool falls back to a not-yet-ready endpoint rather than failing a request
   * outright, because a probable 429 still beats a certain failure.
   */
  isReady(): boolean {
    const interval = this.capabilities.minIntervalMs
    if (interval === undefined || this.lastUsedAtMs === 0) return true
    return this.clock() - this.lastUsedAtMs >= interval
  }

  get msUntilReady(): number {
    const interval = this.capabilities.minIntervalMs
    if (interval === undefined || this.lastUsedAtMs === 0) return 0
    return Math.max(0, interval - (this.clock() - this.lastUsedAtMs))
  }

  recordSuccess(latencyMs: number): void {
    this.stats.successes += 1
    this.stats.totalLatencyMs += latencyMs
    this.stats.lastLatencyMs = latencyMs
  }

  recordDeterminate(latencyMs: number): void {
    this.stats.determinate += 1
    this.stats.totalLatencyMs += latencyMs
    this.stats.lastLatencyMs = latencyMs
  }

  recordWalk(reason: WalkReason, latencyMs: number): void {
    this.stats.walks += 1
    this.stats.byReason[reason] = (this.stats.byReason[reason] ?? 0) + 1
    this.stats.totalLatencyMs += latencyMs
    this.stats.lastLatencyMs = latencyMs
  }

  /**
   * Remember that this endpoint no longer holds state at `block`.
   *
   * The boundary only ever moves forward as the node prunes, so the highest
   * observed value is the correct bound. Learned at runtime rather than
   * configured, because a node's retention is an operational choice that can
   * change without notice.
   */
  notePruned(block: bigint | undefined): void {
    if (block === undefined) return
    if (this.prunedBelowValue === undefined || block > this.prunedBelowValue) {
      this.prunedBelowValue = block
    }
  }

  get prunedBelow(): bigint | undefined {
    return this.prunedBelowValue
  }

  /**
   * Whether this endpoint can be expected to hold state at `block`.
   *
   * Answers true when nothing is known: the pool must not exclude an endpoint
   * on a guess. Exclusion happens only against a configured retention window or
   * a boundary this endpoint has already demonstrated.
   */
  servesStateAt(block: bigint | undefined, head: bigint | undefined): boolean {
    if (block === undefined) return true
    if (this.prunedBelowValue !== undefined && block <= this.prunedBelowValue) return false
    const window = this.capabilities.stateWindowBlocks
    if (window === undefined || head === undefined) return true
    return head - block <= BigInt(window)
  }

  /** Remember that a log query spanning `range` blocks was refused here. */
  noteLogRangeRejected(range: number): void {
    if (!Number.isFinite(range) || range <= 0) return
    const limit = range - 1
    if (this.logRangeLimitValue === undefined || limit < this.logRangeLimitValue) {
      this.logRangeLimitValue = limit
    }
  }

  get logRangeLimit(): number | undefined {
    return this.logRangeLimitValue
  }

  acceptsLogRange(range: number | undefined): boolean {
    if (range === undefined || this.logRangeLimitValue === undefined) return true
    return range <= this.logRangeLimitValue
  }

  get averageLatencyMs(): number | undefined {
    const answered = this.stats.successes + this.stats.determinate + this.stats.walks
    return answered === 0 ? undefined : Math.round(this.stats.totalLatencyMs / answered)
  }
}

/**
 * Build the endpoint list in the order the waterfall walks it.
 *
 * The user's own node leads Tier 1 unconditionally: they configured it because
 * they trust it, and it is the one endpoint whose rate limit is theirs to
 * spend. Tier 2 exists only when a credential was supplied.
 */
export function buildEndpoints(options: {
  userUrl?: string | undefined
  freeUrls: readonly string[]
  alchemyKey?: string | undefined
  alchemyUrlTemplate?: string
  clock?: Clock
}): Endpoint[] {
  const clock = options.clock ?? Date.now
  const specs: EndpointSpec[] = []
  const seen = new Set<string>()

  const push = (url: string, tier: Tier, origin: EndpointSpec['origin']): void => {
    if (url === '' || seen.has(url)) return
    seen.add(url)
    specs.push({ url, tier, capabilities: capabilitiesFor(url), origin })
  }

  if (options.userUrl !== undefined) push(options.userUrl, 1, 'user')
  for (const url of options.freeUrls) push(url, 1, 'default')

  if (options.alchemyKey !== undefined && options.alchemyKey !== '') {
    const template = options.alchemyUrlTemplate ?? ALCHEMY_URL_TEMPLATE
    push(template.replace('{key}', options.alchemyKey), 2, 'paid')
  }

  return specs.map((spec) => new Endpoint(spec, clock))
}

export const ALCHEMY_URL_TEMPLATE = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}'
