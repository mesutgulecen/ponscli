import { NoPaidFallbackError, PonsError, ExitCode } from '../errors.js'
import { classify, type Verdict, type WalkReason } from './classify.js'
import type { Endpoint, Tier } from './endpoint.js'
import { HeadSkewMemo, type Clock } from './headSkew.js'
import { redactErrorInPlace, redactText } from './redact.js'
import { highestBlock, isWriteMethod, logRange, logSpan, stateBlock } from './request.js'

/** Sends one request to one endpoint. Injected so tests need no network. */
export type Dispatch = (
  endpoint: Endpoint,
  method: string,
  params: readonly unknown[],
) => Promise<unknown>

/**
 * Counters proving each policy branch is doing something.
 *
 * A discipline, not a nicety: a zero with traffic flowing proves the branch is
 * inert. Every optimisation below earns its
 * complexity by showing a non-zero count under real load, and `pons doctor
 * --stats` is where that is checked.
 */
export interface ActivationCounters {
  requests: number
  walks: number
  /** Deterministic replies handed back without escalating. */
  deterministicNoWalk: number
  throttleParks: number
  quotaParks: number
  durableParks: number
  /** Requests never sent because a head-skew note already ruled them out. */
  headSkewSkips: number
  headSkewNotes: number
  /** Endpoints skipped for a method they answered `-32601` for. */
  unsupportedMethodSkips: number
  /** Log queries steered away from an endpoint that cannot serve them. */
  logsRoutingSkips: number
  /** Historical reads steered away from a pruned endpoint. */
  prunedSkips: number
  prunedWalks: number
  /** Times the paid tier actually served a request. */
  paidTierEngaged: number
  /** Times Tier 1 was exhausted with no paid tier configured. */
  noPaidFallback: number
  /** Metered endpoints deprioritised because their interval had not elapsed. */
  rateWindowDeferrals: number
}

function emptyCounters(): ActivationCounters {
  return {
    requests: 0,
    walks: 0,
    deterministicNoWalk: 0,
    throttleParks: 0,
    quotaParks: 0,
    durableParks: 0,
    headSkewSkips: 0,
    headSkewNotes: 0,
    unsupportedMethodSkips: 0,
    logsRoutingSkips: 0,
    prunedSkips: 0,
    prunedWalks: 0,
    paidTierEngaged: 0,
    noPaidFallback: 0,
    rateWindowDeferrals: 0,
  }
}

export interface PoolOptions {
  endpoints: Endpoint[]
  dispatch: Dispatch
  /** `auto` walks Tier 1 then Tier 2; `1` and `2` pin a single tier. */
  tier?: 'auto' | '1' | '2'
  clock?: Clock
  memo?: HeadSkewMemo
  /** Receives one-line warnings; wired to the reporter's stderr channel. */
  onWarn?: (message: string) => void
}

interface Skip {
  endpoint: Endpoint
  reason: string
}

/**
 * A hard skip means this endpoint cannot serve the request at all. A soft skip
 * means it would probably refuse — worth avoiding, but better than nothing when
 * the alternative is failing the request.
 */
interface SkipVerdict {
  kind: 'hard' | 'soft'
  reason: string
}

/**
 * The two-tier RPC waterfall.
 *
 * Tier 1 is a round-robin over free endpoints. Tier 2 is a paid endpoint that
 * is touched only once every Tier 1 candidate has been tried, so an outage
 * degrades into slower answers rather than into an invoice.
 *
 * The pool walks on failure but never on an *answer*. That distinction is the
 * whole design: a revert, a bad parameter, an unknown block are replies, and
 * escalating them burns latency and money to arrive at the same result.
 */
export class RpcPool {
  readonly endpoints: readonly Endpoint[]
  readonly memo: HeadSkewMemo
  private readonly dispatch: Dispatch
  private readonly tierPin: 'auto' | '1' | '2'
  private readonly clock: Clock
  private readonly onWarn: (message: string) => void
  private readonly counters = emptyCounters()
  private cursor = 0
  private lastKnownHead: bigint | undefined
  private paidWarned = false

  constructor(options: PoolOptions) {
    this.endpoints = options.endpoints
    this.dispatch = options.dispatch
    this.tierPin = options.tier ?? 'auto'
    this.clock = options.clock ?? Date.now
    this.memo = options.memo ?? new HeadSkewMemo(undefined, this.clock)
    this.onWarn = options.onWarn ?? (() => {})
  }

  get stats(): Readonly<ActivationCounters> {
    return this.counters
  }

  /** Chain head as last observed. Used to reason about pruning windows. */
  get head(): bigint | undefined {
    return this.lastKnownHead
  }

  private tiers(): Tier[] {
    if (this.tierPin === '1') return [1]
    if (this.tierPin === '2') return [2]
    return [1, 2]
  }

  /**
   * Endpoints of one tier, in the order to try them.
   *
   * The user's own node never rotates: they configured it because they trust
   * it, and its rate limit is theirs to spend. Everything else rotates so that
   * consecutive requests do not all land on whichever endpoint happens to be
   * listed first.
   */
  private order(tier: Tier, rotation: number): Endpoint[] {
    const all = this.endpoints.filter((endpoint) => endpoint.tier === tier)
    const pinned = all.filter((endpoint) => endpoint.origin === 'user')
    const rotating = all.filter((endpoint) => endpoint.origin !== 'user')
    if (rotating.length <= 1) return [...pinned, ...rotating]
    const start = rotation % rotating.length
    return [...pinned, ...rotating.slice(start), ...rotating.slice(0, start)]
  }

  /** Why this endpoint should not serve this request, or null if it can. */
  private skipReason(
    endpoint: Endpoint,
    method: string,
    params: readonly unknown[],
  ): SkipVerdict | null {
    if (endpoint.isParked()) {
      return { kind: 'hard', reason: `parked (${endpoint.parkReason ?? 'unknown'})` }
    }
    if (endpoint.unsupported.has(method)) {
      this.counters.unsupportedMethodSkips += 1
      return { kind: 'hard', reason: 'method unsupported' }
    }

    const range = logRange(method, params)
    if (range !== undefined) {
      if (!endpoint.capabilities.logs) {
        this.counters.logsRoutingSkips += 1
        return { kind: 'hard', reason: 'does not serve getLogs' }
      }
      const span = logSpan(range)
      if (!endpoint.acceptsLogRange(span)) {
        this.counters.logsRoutingSkips += 1
        return {
          kind: 'hard',
          reason: `log range ${String(span)} exceeds learned limit ${String(endpoint.logRangeLimit)}`,
        }
      }
    }

    if (!endpoint.servesStateAt(stateBlock(method, params), this.lastKnownHead)) {
      this.counters.prunedSkips += 1
      return { kind: 'hard', reason: 'state pruned at that block' }
    }

    if (this.memo.isBehind(endpoint.url, highestBlock(method, params))) {
      this.counters.headSkewSkips += 1
      return { kind: 'hard', reason: 'behind the requested block' }
    }

    if (!endpoint.isReady()) {
      this.counters.rateWindowDeferrals += 1
      return { kind: 'soft', reason: `metered: ${String(endpoint.msUntilReady)}ms until ready` }
    }

    return null
  }

  private applyVerdict(
    endpoint: Endpoint,
    verdict: Extract<Verdict, { action: 'walk' }>,
    method: string,
    params: readonly unknown[],
  ): void {
    endpoint.park(verdict.reason, verdict.parkMs)

    switch (verdict.reason) {
      case 'throttle':
        this.counters.throttleParks += 1
        break
      case 'quota':
        this.counters.quotaParks += 1
        break
      case 'durable':
        this.counters.durableParks += 1
        break
      case 'unsupported-method':
        // Per-method rather than a blanket park: an endpoint that refuses
        // `eth_getLogs` may still be the fastest thing available for
        // `eth_call`, and removing it entirely would be a self-inflicted
        // outage.
        endpoint.unsupported.add(method)
        break
      case 'head-skew':
        this.counters.headSkewNotes += 1
        this.memo.note(endpoint.url, verdict.detail?.requested ?? highestBlock(method, params), verdict.detail?.head)
        break
      case 'pruned':
        this.counters.prunedWalks += 1
        endpoint.notePruned(stateBlock(method, params) ?? highestBlock(method, params))
        break
      case 'log-range': {
        const span = logSpan(logRange(method, params))
        if (span !== undefined) endpoint.noteLogRangeRejected(span)
        break
      }
      default:
        break
    }
  }

  /** Learn the chain head from answers that reveal it. */
  private observe(method: string, result: unknown): void {
    if (method === 'eth_blockNumber' && typeof result === 'string') {
      const head = BigInt(result)
      if (this.lastKnownHead === undefined || head > this.lastKnownHead) this.lastKnownHead = head
    }
  }

  /** Strip credentials out of an error before it leaves the pool. */
  private redactError(error: unknown): void {
    redactErrorInPlace(
      error,
      this.endpoints.map((endpoint) => endpoint.url),
    )
  }

  private redact(text: string): string {
    return redactText(
      text,
      this.endpoints.map((endpoint) => endpoint.url),
    )
  }

  /**
   * Send one request, walking the waterfall until something answers.
   *
   * Throws the node's own error when a reply is deterministic, so callers see
   * the revert reason rather than a wrapper that lost it.
   */
  async send(method: string, params: readonly unknown[] = []): Promise<unknown> {
    if (isWriteMethod(method)) {
      throw new PonsError(
        'WRITE_NOT_ROUTABLE',
        `${method} cannot go through the waterfall`,
        {
          exitCode: ExitCode.Network,
          hint: 'pin an endpoint with lease() so the nonce and the broadcast share a node',
        },
      )
    }

    this.counters.requests += 1
    // Snapshot the rotation before walking, and advance it once per request.
    // Incrementing first would make the very first request start at the second
    // endpoint, which is surprising and makes the ordering hard to reason about.
    const rotation = this.cursor
    this.cursor += 1

    const skipped: Skip[] = []
    let lastError: unknown
    let attempted = false
    const paidConfigured = this.endpoints.some((endpoint) => endpoint.tier === 2)

    for (const tier of this.tiers()) {
      const ready: Endpoint[] = []
      const deferred: Endpoint[] = []
      for (const endpoint of this.order(tier, rotation)) {
        const skip = this.skipReason(endpoint, method, params)
        if (skip === null) ready.push(endpoint)
        else {
          skipped.push({ endpoint, reason: skip.reason })
          if (skip.kind === 'soft') deferred.push(endpoint)
        }
      }

      // Metered endpoints go last rather than being dropped: a probable 429 is
      // still a better outcome than reporting the whole tier exhausted.
      for (const endpoint of [...ready, ...deferred]) {
        if (tier === 2 && !this.paidWarned) {
          this.paidWarned = true
          this.onWarn(
            `every free endpoint declined ${method}; falling back to the paid tier (${endpoint.label})`,
          )
        }

        attempted = true
        endpoint.recordAttempt()
        const started = this.clock()
        try {
          const result = await this.dispatch(endpoint, method, params)
          endpoint.recordSuccess(this.clock() - started)
          if (tier === 2) this.counters.paidTierEngaged += 1
          this.observe(method, result)
          return result
        } catch (error) {
          const verdict = classify(error)
          const latency = this.clock() - started

          if (verdict.action === 'return') {
            // The node answered. Every other node would answer the same, so
            // walking spends latency — and, at Tier 2, money — for nothing.
            endpoint.recordDeterminate(latency)
            this.counters.deterministicNoWalk += 1
            this.redactError(error)
            throw error
          }

          endpoint.recordWalk(verdict.reason, latency)
          this.counters.walks += 1
          this.applyVerdict(endpoint, verdict, method, params)
          lastError = error
        }
      }
    }

    if (!paidConfigured && this.tierPin !== '1') {
      this.counters.noPaidFallback += 1
      throw new NoPaidFallbackError({
        method,
        attempted,
        skipped: skipped.map((entry) => ({ endpoint: entry.endpoint.label, reason: entry.reason })),
      })
    }

    throw new PonsError('RPC_EXHAUSTED', `no endpoint could serve ${method}`, {
      exitCode: ExitCode.Network,
      cause: lastError,
      details: {
        method,
        lastError: lastError instanceof Error ? this.redact(lastError.message) : undefined,
        skipped: skipped.map((entry) => ({ endpoint: entry.endpoint.label, reason: entry.reason })),
      },
      hint:
        this.tierPin === '1'
          ? 'the waterfall is pinned to Tier 1; unset rpc.tier to allow the paid fallback'
          : 'run `pons doctor` to see which endpoints are answering',
    })
  }

  /**
   * Pin one endpoint for a sequence of requests that must share a node.
   *
   * Two cases need this, both measured. A transaction takes its nonce from one
   * node and must broadcast to the same one, or it is rejected as `nonce too
   * low`. A log scan must keep one node's view of the head: the official
   * endpoint reported 45,517,504 while another reported 45,517,528 — a 24-block
   * gap that would move a cursor backwards and duplicate or skip logs.
   */
  lease(options: { requireLogs?: boolean } = {}): Lease {
    for (const tier of this.tiers()) {
      const eligible = this.order(tier, this.cursor).filter(
        (endpoint) =>
          !endpoint.isParked() &&
          (options.requireLogs !== true || endpoint.capabilities.logs),
      )
      // An unmetered endpoint is strongly preferred for a pinned session: a
      // scan that has to wait ten seconds between requests is not a scan.
      const chosen = eligible.find((endpoint) => endpoint.capabilities.minIntervalMs === undefined)
      const endpoint = chosen ?? eligible[0]
      if (endpoint !== undefined) return new Lease(endpoint, this.dispatch, this)
    }
    throw new PonsError('RPC_EXHAUSTED', 'no endpoint available to pin', {
      exitCode: ExitCode.Network,
      hint: 'run `pons doctor` to see which endpoints are answering',
    })
  }
}

/**
 * A single endpoint, held for the duration of a session.
 *
 * Deliberately does not walk. A lease exists precisely because switching
 * endpoints mid-sequence is the failure being avoided, so a failure here is
 * surfaced to the caller to decide — retry, re-lease, or abort.
 */
export class Lease {
  constructor(
    readonly endpoint: Endpoint,
    private readonly dispatch: Dispatch,
    private readonly pool: RpcPool,
  ) {}

  async send(method: string, params: readonly unknown[] = []): Promise<unknown> {
    this.endpoint.recordAttempt()
    const started = Date.now()
    try {
      const result = await this.dispatch(this.endpoint, method, params)
      this.endpoint.recordSuccess(Date.now() - started)
      return result
    } catch (error) {
      const verdict = classify(error)
      if (verdict.action === 'return') {
        this.endpoint.recordDeterminate(Date.now() - started)
      } else {
        this.endpoint.recordWalk(verdict.reason, Date.now() - started)
        this.endpoint.park(verdict.reason, verdict.parkMs)
      }
      redactErrorInPlace(error, [this.endpoint.url])
      throw error
    }
  }

  /** The pool this lease came from, for callers that need to re-lease. */
  get owner(): RpcPool {
    return this.pool
  }
}

export type { WalkReason }
