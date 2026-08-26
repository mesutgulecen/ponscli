/**
 * A short-lived note that an endpoint is behind the chain head.
 *
 * Measured against live endpoints: 1,073 `-32602 "beyond current head block"` replies in
 * three hours, and each distinct (requested, head) pair repeated about eight
 * times. The provider is not faulty; it is late, by a second or two. Holding a
 * two-second note removes seven of every eight of those round trips.
 *
 * The note is deliberately brief. At ~0.1 s per block on this chain a stale
 * note would exclude an endpoint that has long since caught up.
 */

export type Clock = () => number

interface Note {
  /** The highest block this endpoint is known to have. */
  head: bigint
  expiresAt: number
}

export const DEFAULT_HEAD_SKEW_TTL_MS = 2_000

export class HeadSkewMemo {
  private readonly notes = new Map<string, Note>()
  private prevented = 0

  constructor(
    private readonly ttlMs: number = DEFAULT_HEAD_SKEW_TTL_MS,
    private readonly clock: Clock = Date.now,
  ) {}

  /**
   * Record that `endpoint` could not serve `requested`.
   *
   * When the error message disclosed the endpoint's actual head we store that,
   * which generalises: every block above it is known unservable, not just the
   * one that failed. Otherwise the requested block minus one is the best bound
   * available, so we know the endpoint has less than that.
   */
  note(endpoint: string, requested: bigint | undefined, head: bigint | undefined): void {
    const bound = head ?? (requested === undefined ? undefined : requested - 1n)
    if (bound === undefined) return
    const existing = this.notes.get(endpoint)
    const expiresAt = this.clock() + this.ttlMs
    // Keep the most optimistic bound seen inside the window: a later note
    // saying the endpoint is further along must not be undone by an older one.
    const merged = existing !== undefined && existing.expiresAt > this.clock() && existing.head > bound
      ? existing.head
      : bound
    this.notes.set(endpoint, { head: merged, expiresAt })
  }

  /**
   * True when a live note says this endpoint cannot yet serve `block`.
   *
   * Counts as a prevented round trip, which is what `pons doctor --stats`
   * reports: a zero here with traffic flowing proves the branch is inert.
   */
  isBehind(endpoint: string, block: bigint | undefined): boolean {
    if (block === undefined) return false
    const note = this.notes.get(endpoint)
    if (note === undefined) return false
    if (note.expiresAt <= this.clock()) {
      this.notes.delete(endpoint)
      return false
    }
    if (block <= note.head) return false
    this.prevented += 1
    return true
  }

  /** Requests never sent because a note already said they would fail. */
  get preventedRequests(): number {
    return this.prevented
  }

  /** Live notes, for `pons doctor`. Expired entries are dropped on the way. */
  entries(): { endpoint: string; head: bigint }[] {
    const now = this.clock()
    const live: { endpoint: string; head: bigint }[] = []
    for (const [endpoint, note] of this.notes) {
      if (note.expiresAt <= now) this.notes.delete(endpoint)
      else live.push({ endpoint, head: note.head })
    }
    return live
  }

  clear(): void {
    this.notes.clear()
    this.prevented = 0
  }
}
