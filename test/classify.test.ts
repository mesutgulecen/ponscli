import { describe, expect, it } from 'vitest'

import { PARK_MS, classify, describeError } from '../src/chain/classify.js'

/**
 * One test per policy branch, named after the measurement that justifies it.
 *
 * A branch without a test here is a branch nobody proved is needed — which is
 * the same discipline the activation counters enforce at runtime.
 */

/** Shape of a viem `HttpRequestError`: status on the outside, no RPC code. */
function httpError(status: number, body = ''): Error {
  return Object.assign(new Error('HTTP request failed.'), {
    name: 'HttpRequestError',
    status,
    details: body,
  })
}

/** Shape of a viem RPC error: HTTP 200, an error object in the body. */
function rpcError(code: number, message: string): Error {
  return Object.assign(new Error('RPC Request failed.'), {
    name: 'RpcRequestError',
    cause: Object.assign(new Error(message), { code, details: message }),
  })
}

describe('deterministic replies are returned, not escalated', () => {
  it('returns a revert without walking', () => {
    // 12 providers, 11,280 observations, zero cases of one node reverting where
    // another succeeded. Walking cost ~13 s of sleeping to reach the same reply.
    expect(classify(rpcError(3, 'execution reverted: InsufficientOutput()'))).toEqual({
      action: 'return',
      reason: 'revert',
    })
  })

  it('returns invalid params without walking', () => {
    expect(classify(rpcError(-32602, 'invalid argument 0'))).toEqual({
      action: 'return',
      reason: 'invalid-params',
    })
  })

  it('returns an invalid request without walking', () => {
    expect(classify(rpcError(-32600, 'invalid request'))).toEqual({
      action: 'return',
      reason: 'invalid-request',
    })
  })

  it('returns a sender that cannot pay, rather than blaming the endpoint', () => {
    // Measured on 2026-08-26, verbatim from the official endpoint for a buy
    // from an account holding nothing. Every node computes this from the same
    // state, so walking is two wasted round trips and, with a paid tier
    // configured, a billed one — for an answer that cannot differ.
    const message =
      'err: insufficient funds for gas * price + value: address ' +
      '0xDF88B005b92001fD2Eb318e9D259183D2A82E1e4 have 0 want 1000000000000000 ' +
      '(supplied gas 50000000)'
    expect(classify(rpcError(-32000, message))).toEqual({ action: 'return', reason: 'sender' })
  })

  it('returns the other sender-side rejections too', () => {
    for (const message of [
      'intrinsic gas too low',
      'max fee per gas less than block base fee',
      'gas required exceeds allowance (0)',
    ]) {
      expect(classify(rpcError(-32000, message))).toEqual({ action: 'return', reason: 'sender' })
    }
  })

  it('still walks a bare -32000 it has no rule for', () => {
    // The rule above must not swallow the generic bucket: an unrecognised
    // -32000 may well be this endpoint's problem and the next one may serve it.
    expect(classify(rpcError(-32000, 'something went wrong')).action).toBe('walk')
  })
})

describe('three-axis failure classification', () => {
  it('parks a rejected credential for an hour', () => {
    const verdict = classify(httpError(401))
    expect(verdict).toMatchObject({ action: 'walk', reason: 'durable' })
    expect(PARK_MS.durable).toBe(3_600_000)
  })

  it('parks an exhausted quota for an hour', () => {
    expect(classify(rpcError(-32000, 'monthly limit reached'))).toMatchObject({
      reason: 'quota',
      parkMs: 3_600_000,
    })
  })

  it('parks a bare 429 for thirty seconds, not an hour', () => {
    // Free endpoints are token buckets. Parking one for an hour after a single
    // 429 cost roughly half of total pool availability under live load.
    expect(classify(httpError(429))).toEqual({ action: 'walk', reason: 'throttle', parkMs: 30_000 })
  })

  it('recognises a rate limit stated in the body rather than the status', () => {
    // nodeflare answers HTTP 429 with {"error":"rate_limited"}; some endpoints
    // say it at HTTP 200.
    expect(classify(rpcError(-32000, '"rate_limited"'))).toMatchObject({ reason: 'throttle' })
  })
})

describe('an error reply is not a health signal', () => {
  it('does not park an unrecognised JSON-RPC error', () => {
    // HTTP 200 with an error body means the server answered. Treating that as
    // ill health cascades a whole tier out on benign tip skew.
    expect(classify(rpcError(-32099, 'something we have no rule for'))).toEqual({
      action: 'walk',
      reason: 'unknown',
      parkMs: 0,
    })
  })

  it('parks a transport failure, which is a real absence of an answer', () => {
    expect(classify(new Error('fetch failed'))).toMatchObject({ reason: 'transport', parkMs: 5_000 })
  })

  it('classifies a timeout separately from a refusal', () => {
    expect(classify(Object.assign(new Error('The request took too long.'), { name: 'TimeoutError' })))
      .toMatchObject({ reason: 'timeout' })
  })
})

describe('chain-specific replies', () => {
  it('treats pruned state as walkable, never as deterministic', () => {
    // The official endpoint answers this beyond ~6-10k blocks. Calling it
    // deterministic would strand every historical query on the first endpoint
    // that happens not to retain the state.
    const verdict = classify(rpcError(-32000, 'metadata is not found, 45531004'))
    expect(verdict).toMatchObject({ action: 'walk', reason: 'pruned', parkMs: 0 })
  })

  it('does not park an endpoint for being behind the head', () => {
    // 1,073 of these in three hours. The provider is not faulty, it is late.
    const verdict = classify(rpcError(-32602, 'requested block is beyond current head block'))
    expect(verdict).toMatchObject({ action: 'walk', reason: 'head-skew', parkMs: 0 })
  })

  it('extracts the requested and head blocks when the message discloses them', () => {
    const verdict = classify(
      rpcError(-32602, 'block 45580000 is beyond current head block 45579990'),
    )
    expect(verdict).toMatchObject({
      reason: 'head-skew',
      detail: { requested: 45_580_000n, head: 45_579_990n },
    })
  })

  it('treats an unknown method as a per-method fact, not a sick endpoint', () => {
    // drpc without a key answers eth_chainId and rejects eth_call with -32601.
    // Parking the endpoint outright would throw away a node that may serve
    // other methods perfectly well.
    expect(classify(rpcError(-32601, 'the method eth_call does not exist'))).toEqual({
      action: 'walk',
      reason: 'unsupported-method',
      parkMs: 0,
    })
  })

  it('recognises a refused log range', () => {
    expect(classify(httpError(400, 'block range is too large'))).toMatchObject({
      reason: 'log-range',
      parkMs: 0,
    })
  })
})

describe('describeError', () => {
  it('prefers the node’s own words over the wrapper’s', () => {
    // viem wraps this as "Missing or invalid parameters." — which says nothing.
    // The node said "metadata is not found", which says pruning.
    expect(describeError(rpcError(-32602, 'metadata is not found, 45531004'))).toBe(
      'metadata is not found, 45531004',
    )
  })

  it('collapses whitespace so a message fits one table cell', () => {
    expect(describeError(new Error('line one\n\nline  two'))).toBe('line one line two')
  })
})
