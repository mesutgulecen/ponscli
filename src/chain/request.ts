/**
 * Read routing-relevant facts out of a JSON-RPC request.
 *
 * The waterfall needs three things from a request before it can pick an
 * endpoint: the highest block it references (head skew), the block whose state
 * it reads (pruning), and how many blocks a log query spans (range limits).
 * Everything here is pure inspection of `params` — nothing is rewritten.
 */

export interface BlockRange {
  from: bigint | undefined
  to: bigint | undefined
}

const NAMED_TAGS = new Set(['latest', 'pending', 'earliest', 'safe', 'finalized'])

/** Parse a block tag, returning undefined for named tags and malformed input. */
export function parseBlockTag(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : undefined
  if (typeof value !== 'string') return undefined
  if (NAMED_TAGS.has(value)) return undefined
  if (!/^0x[0-9a-fA-F]+$/.test(value)) return undefined
  return BigInt(value)
}

/**
 * Position of the block-tag argument, per method.
 *
 * Only methods whose answer depends on historical *state* are listed. Reading a
 * block or a receipt by number is served from block data, which nodes retain
 * far longer than the state trie.
 */
const STATE_BLOCK_ARG: Record<string, number> = {
  eth_call: 1,
  eth_estimateGas: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
  eth_getProof: 2,
}

/** The block whose state the request reads, if it pins one. */
export function stateBlock(method: string, params: readonly unknown[]): bigint | undefined {
  const index = STATE_BLOCK_ARG[method]
  if (index === undefined) return undefined
  return parseBlockTag(params[index])
}

export function logRange(method: string, params: readonly unknown[]): BlockRange | undefined {
  if (method !== 'eth_getLogs') return undefined
  const filter = params[0]
  if (filter === null || typeof filter !== 'object') return undefined
  const record = filter as Record<string, unknown>
  return { from: parseBlockTag(record['fromBlock']), to: parseBlockTag(record['toBlock']) }
}

/** Number of blocks a log query spans, when both bounds are numeric. */
export function logSpan(range: BlockRange | undefined): number | undefined {
  if (range?.from === undefined || range.to === undefined) return undefined
  const span = range.to - range.from + 1n
  return span > 0n ? Number(span) : undefined
}

/**
 * The highest block the request refers to.
 *
 * Used against the head-skew memo: if an endpoint is known to be short of this
 * block, the request is guaranteed to fail there and is not worth sending.
 */
export function highestBlock(method: string, params: readonly unknown[]): bigint | undefined {
  const range = logRange(method, params)
  if (range !== undefined) return range.to

  const state = stateBlock(method, params)
  if (state !== undefined) return state

  if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockReceipts') {
    return parseBlockTag(params[0])
  }
  return undefined
}

/**
 * Whether a method mutates chain state or depends on the sender's nonce.
 *
 * These must never be round-robined: taking a nonce from one endpoint and
 * broadcasting to another produces `nonce too low`. The pool refuses to walk
 * them; callers pin an endpoint with `lease()` instead.
 */
export function isWriteMethod(method: string): boolean {
  return (
    method === 'eth_sendRawTransaction' ||
    method === 'eth_sendTransaction' ||
    method.startsWith('eth_signT')
  )
}
