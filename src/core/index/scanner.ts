import type { AbiEvent, Address, Log, PublicClient } from 'viem'

/**
 * Historical log scanning.
 *
 * The chain produces ten blocks a second, so any question about the past is a
 * question about tens of millions of blocks and no single `eth_getLogs` will
 * answer it. This module walks the range in chunks and sizes those chunks from
 * what the endpoints actually do rather than from a constant.
 *
 * **Two independent limits, and neither is a fixed block range.** Measured
 * against `rpc.mainnet.chain.robinhood.com` on 2026-08-25:
 *
 * | query | result |
 * |---|---|
 * | `PairTokenApprovalUpdated`, block 0 to head | 25 logs in 0.27 s |
 * | `TokenLaunched`, 3,000,000 blocks | 7,154 logs in 3.5 s |
 * | `TokenLaunched`, 5,000,000 blocks | `-32000 log query timed out` |
 * | factory address, no topic, 2,500,000 blocks | 6,984 logs in 2.2 s |
 * | `Transfer` chain-wide, 500 blocks | 11,690 logs in 1.3 s |
 * | `Transfer` chain-wide, 1,000 blocks | `-32000 logs matched by query exceeds limit of 10000` |
 *
 * The first limit is a **query timeout**: how long the node spends scanning,
 * which is why a selective filter answers over the whole history and a loose
 * one dies inside five million blocks. The second is a **ten-thousand-result
 * cap**, and it is enforced by estimate rather than by count: the query that
 * returned 11,690 logs is past the stated limit and was served anyway, while
 * twice the range was refused outright.
 *
 * Both mean the answerable span depends on how selective the filter is, not on
 * a number that can be written down. A fixed chunk size is therefore either
 * needlessly slow or doomed depending on the filter, which is why this one
 * adapts: halve on refusal, grow gently on success.
 */

/** Where a scan starts and stops. Both bounds are inclusive. */
export interface BlockSpan {
  fromBlock: bigint
  toBlock: bigint
}

export interface ScanFilter {
  address?: Address | Address[]
  /**
   * Events to match, as ABI entries rather than raw topics.
   *
   * viem's `getLogs` builds `topics` from these and decodes `args` on the way
   * back; it has no parameter for a raw topic list, and passing one sends
   * `"topics":[]`: an unfiltered query over the whole range. That is the
   * difference between a scan that answers in a quarter of a second and one
   * that times out, so the filter is expressed the only way the client
   * actually honours.
   */
  events?: readonly AbiEvent[]
}

export interface ScanOptions extends ScanFilter, BlockSpan {
  /** First chunk size. Later chunks grow or shrink from the answers. */
  initialSpan?: bigint
  /** Never ask for more than this in one call, however well it is going. */
  maxSpan?: bigint
  /** Give up rather than subdivide below this. */
  minSpan?: bigint
  /** Called after every answered chunk, for a progress line. */
  onProgress?: (progress: ScanProgress) => void
}

export interface ScanProgress {
  /** Last block covered so far. */
  scannedTo: bigint
  toBlock: bigint
  logs: number
  /** Chunk size in force for the next request. */
  span: bigint
}

/**
 * Defaults sized from the measurements above.
 *
 * 500,000 is the doc's figure and holds for a topic-filtered factory scan; the
 * ceiling is four million because a topic-filtered five-million-block query
 * timed out and the floor is a thousand because a range that narrow failing
 * means something other than the range is wrong.
 */
const DEFAULT_INITIAL_SPAN = 500_000n
const DEFAULT_MAX_SPAN = 4_000_000n
const DEFAULT_MIN_SPAN = 1_000n

/**
 * Errors that mean "ask for less", as opposed to "this will never work".
 *
 * Matched on the message because the codes are not agreed on: this chain
 * answers `-32000 log query timed out`, Alchemy answers `-32602` with a range
 * suggestion, and others answer HTTP 413. Anything unrecognised is re-thrown,
 * halving the range in response to an authentication failure would turn one
 * error into sixteen.
 */
const RETRYABLE = [
  'timed out',
  'timeout',
  // This chain's exact wording for the result cap: "logs matched by query
  // exceeds limit of 10000". None of the generic phrases below match it, and
  // an unmatched oversize error is re-thrown rather than subdivided, which
  // would turn the one limit a dense filter actually hits into a hard failure.
  'exceeds limit',
  'matched by query',
  'query returned more than',
  'response size exceed',
  'block range',
  'range is too large',
  'too many results',
  'limit exceeded',
  'exceeds max results',
  'request entity too large',
]

function isOversizeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return RETRYABLE.some((needle) => message.includes(needle))
}

/**
 * Fetch every matching log between two blocks.
 *
 * The upper bound is a number, never `latest`: chunks then carry absolute
 * bounds, which is what lets them be dispatched to any endpoint in the pool.
 * Pinning one endpoint would guard against head skew, but skew is only a
 * hazard for a range that ends at the head, and resolving the head once, up
 * front, removes the hazard while keeping the waterfall's failover.
 */
export async function scanLogs(client: PublicClient, options: ScanOptions): Promise<Log[]> {
  const maxSpan = options.maxSpan ?? DEFAULT_MAX_SPAN
  const minSpan = options.minSpan ?? DEFAULT_MIN_SPAN
  let span = options.initialSpan ?? DEFAULT_INITIAL_SPAN
  if (span > maxSpan) span = maxSpan

  const collected: Log[] = []
  let from = options.fromBlock

  while (from <= options.toBlock) {
    const to = min(from + span - 1n, options.toBlock)
    let logs: Log[]
    try {
      logs = await client.getLogs({
        ...(options.address === undefined ? {} : { address: options.address }),
        ...(options.events === undefined ? {} : { events: [...options.events] }),
        fromBlock: from,
        toBlock: to,
      })
    } catch (error) {
      if (!isOversizeError(error) || span <= minSpan) throw error
      span = max(minSpan, span / 2n)
      continue
    }

    collected.push(...logs)
    from = to + 1n
    options.onProgress?.({ scannedTo: to, toBlock: options.toBlock, logs: collected.length, span })

    // Grow gently. A chunk that answered says nothing about a chunk twice its
    // size over a denser stretch of history, and overshooting costs a whole
    // round trip plus the halving that undoes it.
    if (span < maxSpan) span = min(maxSpan, (span * 3n) / 2n)
  }

  return collected
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}
