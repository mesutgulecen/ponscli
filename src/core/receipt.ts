import type { Address, Hex, PublicClient } from 'viem'

import { robinhoodChain } from '../chain/definition.js'
import { ExitCode, PonsError } from '../errors.js'
import { decodeLogs, type DecodedLog } from './events.js'
import { decodeRevert, type DecodedRevert } from './revert.js'

/**
 * What a transaction did, and why it failed if it did.
 *
 * Lives in `core/` rather than in the command because two front ends need it:
 * `pons tx` and the MCP server. Nothing here formats anything or knows what a
 * terminal is: the payload is base units and strings, and both callers render
 * it their own way.
 *
 * The reason this is not a one-line receipt read is that a receipt says
 * `status: 0` and nothing else. The revert reason is not in it on any EVM
 * chain; it has to be recovered by replaying the call and then translated out
 * of a four-byte selector.
 */

export interface TransactionReport {
  hash: Hex
  status: 'success' | 'reverted' | 'pending'
  block: number | null
  from: Address
  to: Address | null
  value: string
  nonce: number
  gas: { limit: string; used: string | null; priceWei: string | null; feeWei: string | null }
  logs: DecodedLog[]
  revert: (DecodedRevert & { replayed: boolean }) | null
  explorer: string
}

/**
 * Recover revert data by replaying the call.
 *
 * Replayed at the block the transaction landed in, so it sees the same state
 * the transaction saw. This is the one step that can fail for a reason that is
 * not the caller's fault: the official endpoint prunes state after roughly
 * 6,000 to 10,000 blocks, which at 0.1 s per block is about a quarter of an
 * hour. Older transactions need an archive endpoint, so a failure here is
 * reported as "could not replay" rather than as "no reason".
 */
async function replayRevert(
  client: PublicClient,
  transaction: { from: Address; to: Address | null; input: Hex; value: bigint; gas: bigint },
  blockNumber: bigint,
): Promise<{ data: Hex | undefined; replayed: boolean }> {
  try {
    await client.call({
      account: transaction.from,
      ...(transaction.to === null ? {} : { to: transaction.to }),
      data: transaction.input,
      value: transaction.value,
      gas: transaction.gas,
      blockNumber,
    })
    // The replay succeeded where the transaction failed. That happens when the
    // failure depended on where in the block it landed, and claiming a reason
    // we did not observe would be worse than saying so.
    return { data: undefined, replayed: false }
  } catch (error) {
    const data = extractRevertData(error)
    return { data, replayed: data !== undefined }
  }
}

/**
 * Dig the raw revert payload out of the error chain.
 *
 * The node returns it as the JSON-RPC error's `data`, and viem wraps that
 * three deep, `CallExecutionError` over `ExecutionRevertedError` over
 * `RpcRequestError`: keeping the payload only on the innermost link. Walking
 * the chain is what viem does internally for the same reason; matching on any
 * one wrapper class would break the next time that nesting changes.
 */
export function extractRevertData(error: unknown): Hex | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== 'object') return undefined
    const data = (current as { data?: unknown }).data
    if (typeof data === 'string' && data.startsWith('0x') && data.length > 2) return data as Hex
    // Some nodes nest it one further, as `{ data: { data: '0x…' } }`.
    if (data !== null && typeof data === 'object') {
      const inner = (data as { data?: unknown }).data
      if (typeof inner === 'string' && inner.startsWith('0x') && inner.length > 2) return inner as Hex
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

export async function readTransaction(client: PublicClient, hash: Hex): Promise<TransactionReport> {
  const transaction = await client.getTransaction({ hash }).catch(() => null)
  if (transaction === null) {
    throw new PonsError('TX_NOT_FOUND', `no transaction with hash ${hash}`, {
      exitCode: ExitCode.Failure,
      details: { hash },
      hint: 'check the hash, or the transaction may not have reached this node yet',
    })
  }

  const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
  const explorer = `${robinhoodChain.blockExplorers.default.url}/tx/${hash}`
  const base = {
    hash,
    from: transaction.from,
    to: transaction.to,
    value: transaction.value.toString(),
    nonce: transaction.nonce,
    explorer,
  }

  if (receipt === null) {
    return {
      ...base,
      status: 'pending',
      block: null,
      gas: { limit: transaction.gas.toString(), used: null, priceWei: null, feeWei: null },
      logs: [],
      revert: null,
    }
  }

  const reverted = receipt.status === 'reverted'
  let revert: TransactionReport['revert'] = null
  if (reverted) {
    const { data, replayed } = await replayRevert(
      client,
      {
        from: transaction.from,
        to: transaction.to,
        input: transaction.input,
        value: transaction.value,
        gas: transaction.gas,
      },
      receipt.blockNumber,
    )
    revert = { ...decodeRevert(data), replayed }
  }

  return {
    ...base,
    status: reverted ? 'reverted' : 'success',
    block: Number(receipt.blockNumber),
    gas: {
      limit: transaction.gas.toString(),
      used: receipt.gasUsed.toString(),
      priceWei: receipt.effectiveGasPrice.toString(),
      feeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    },
    // Every decoded log keeps its emitting address, so a caller that wants to
    // resolve units has what it needs without the raw logs travelling too.
    logs: decodeLogs(receipt.logs),
    revert,
  }
}
