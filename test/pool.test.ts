import { afterEach, describe, expect, it, vi } from 'vitest'

import { Endpoint, type EndpointCapabilities } from '../src/chain/endpoint.js'
import { HeadSkewMemo } from '../src/chain/headSkew.js'
import { describeError } from '../src/chain/classify.js'
import { RpcPool, type Dispatch } from '../src/chain/pool.js'
import { NoPaidFallbackError, PonsError } from '../src/errors.js'

/** A controllable clock, so park windows are tested without waiting them out. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start
  return { now: () => value, advance: (ms) => (value += ms) }
}

function endpoint(
  url: string,
  tier: 1 | 2,
  clock: () => number,
  capabilities: EndpointCapabilities = { logs: true },
  origin: 'user' | 'default' | 'paid' = tier === 2 ? 'paid' : 'default',
): Endpoint {
  return new Endpoint({ url, tier, capabilities, origin }, clock)
}

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error('RPC Request failed.'), {
    cause: Object.assign(new Error(message), { code, details: message }),
  })
}

function httpError(status: number): Error {
  return Object.assign(new Error('HTTP request failed.'), { status })
}

/** Records which endpoints were asked, and answers per a scripted plan. */
function scriptedDispatch(plan: Record<string, unknown>): {
  dispatch: Dispatch
  calls: string[]
} {
  const calls: string[] = []
  const dispatch: Dispatch = (target, method) => {
    calls.push(`${target.label}:${method}`)
    const outcome = plan[target.label]
    if (outcome instanceof Error) return Promise.reject(outcome)
    return Promise.resolve(outcome ?? '0x1')
  }
  return { dispatch, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('walking the waterfall', () => {
  it('falls through to the next endpoint on a transport failure', async () => {
    const clock = fakeClock()
    const a = endpoint('https://a.example', 1, clock.now)
    const b = endpoint('https://b.example', 1, clock.now)
    const { dispatch, calls } = scriptedDispatch({
      'a.example': new Error('fetch failed'),
      'b.example': '0x2a',
    })
    const pool = new RpcPool({ endpoints: [a, b], dispatch, clock: clock.now })

    expect(await pool.send('eth_blockNumber')).toBe('0x2a')
    expect(calls).toEqual(['a.example:eth_blockNumber', 'b.example:eth_blockNumber'])
  })

  it('does not walk past a deterministic reply', async () => {
    const clock = fakeClock()
    const a = endpoint('https://a.example', 1, clock.now)
    const b = endpoint('https://b.example', 1, clock.now)
    const { dispatch, calls } = scriptedDispatch({
      'a.example': rpcError(3, 'execution reverted'),
      'b.example': '0x2a',
    })
    const pool = new RpcPool({ endpoints: [a, b], dispatch, clock: clock.now })

    // The node's own error object is rethrown untouched, so the revert reason
    // survives for the decoding layer rather than being flattened into a
    // wrapper message.
    const thrown = await pool.send('eth_call').catch((error: unknown) => error)
    expect(describeError(thrown)).toMatch(/execution reverted/)
    expect(calls).toEqual(['a.example:eth_call'])
    expect(pool.stats.deterministicNoWalk).toBe(1)
  })

  it('never escalates a revert to the paid tier', async () => {
    const clock = fakeClock()
    const free = endpoint('https://a.example', 1, clock.now)
    const paid = endpoint('https://paid.example', 2, clock.now)
    const { dispatch, calls } = scriptedDispatch({
      'a.example': rpcError(3, 'execution reverted'),
      'paid.example': '0x2a',
    })
    const pool = new RpcPool({ endpoints: [free, paid], dispatch, clock: clock.now })

    await expect(pool.send('eth_call')).rejects.toThrow()
    expect(calls.some((call) => call.startsWith('paid.example'))).toBe(false)
    expect(pool.stats.paidTierEngaged).toBe(0)
  })

  it('rotates the starting endpoint between requests', async () => {
    const clock = fakeClock()
    const endpoints = [
      endpoint('https://a.example', 1, clock.now),
      endpoint('https://b.example', 1, clock.now),
    ]
    const { dispatch, calls } = scriptedDispatch({})
    const pool = new RpcPool({ endpoints, dispatch, clock: clock.now })

    await pool.send('eth_chainId')
    await pool.send('eth_chainId')
    await pool.send('eth_chainId')
    expect(calls).toEqual([
      'a.example:eth_chainId',
      'b.example:eth_chainId',
      'a.example:eth_chainId',
    ])
  })

  it('always tries the user’s own node first', async () => {
    const clock = fakeClock()
    const mine = endpoint('https://mine.example', 1, clock.now, { logs: true }, 'user')
    const shared = endpoint('https://shared.example', 1, clock.now)
    const { dispatch, calls } = scriptedDispatch({})
    const pool = new RpcPool({ endpoints: [shared, mine], dispatch, clock: clock.now })

    await pool.send('eth_chainId')
    await pool.send('eth_chainId')
    expect(calls).toEqual(['mine.example:eth_chainId', 'mine.example:eth_chainId'])
  })
})

describe('parking', () => {
  it('keeps a throttled endpoint out for thirty seconds, then restores it', async () => {
    const clock = fakeClock()
    const a = endpoint('https://a.example', 1, clock.now)
    const b = endpoint('https://b.example', 1, clock.now)
    let aFails = true
    const dispatch: Dispatch = (target) => {
      if (target.label === 'a.example' && aFails) return Promise.reject(httpError(429))
      return Promise.resolve(`0x${target.label[0] ?? ''}`)
    }
    const pool = new RpcPool({ endpoints: [a, b], dispatch, clock: clock.now })

    await pool.send('eth_chainId')
    expect(a.isParked()).toBe(true)
    expect(pool.stats.throttleParks).toBe(1)

    clock.advance(29_000)
    expect(a.isParked()).toBe(true)
    clock.advance(2_000)
    expect(a.isParked()).toBe(false)

    aFails = false
    // Two requests, because the rotation may hand the first one to b.
    await pool.send('eth_chainId')
    await pool.send('eth_chainId')
    expect(a.stats.successes).toBe(1)
  })

  it('does not let a milder verdict shorten an existing park', () => {
    const clock = fakeClock()
    const a = endpoint('https://a.example', 1, clock.now)
    a.park('durable', 3_600_000)
    a.park('throttle', 30_000)
    expect(a.parkedUntil).toBe(clock.now() + 3_600_000)
    expect(a.parkReason).toBe('durable')
  })
})

describe('per-method capability learning', () => {
  it('skips only the unsupported method, keeping the endpoint for others', async () => {
    const clock = fakeClock()
    const a = endpoint('https://a.example', 1, clock.now)
    const b = endpoint('https://b.example', 1, clock.now)
    const calls: string[] = []
    const dispatch: Dispatch = (target, method) => {
      calls.push(`${target.label}:${method}`)
      if (target.label === 'a.example' && method === 'eth_call') {
        return Promise.reject(rpcError(-32601, 'the method eth_call does not exist'))
      }
      return Promise.resolve(target.label)
    }
    const pool = new RpcPool({ endpoints: [a, b], dispatch, clock: clock.now })

    await pool.send('eth_call')
    expect(a.unsupported.has('eth_call')).toBe(true)
    // Not parked: the endpoint is fine, it simply does not serve this method.
    expect(a.isParked()).toBe(false)

    // Skipped without a round trip for the method it refused, whichever way
    // the rotation falls.
    calls.length = 0
    expect(await pool.send('eth_call')).toBe('b.example')
    expect(await pool.send('eth_call')).toBe('b.example')
    expect(calls.every((call) => call.startsWith('b.example'))).toBe(true)
    expect(pool.stats.unsupportedMethodSkips).toBe(2)
  })
})

describe('getLogs routing', () => {
  it('never sends a log query to an endpoint that cannot serve one', async () => {
    const clock = fakeClock()
    const light = endpoint('https://light.example', 1, clock.now, { logs: false })
    const full = endpoint('https://full.example', 1, clock.now, { logs: true })
    const { dispatch, calls } = scriptedDispatch({ 'full.example': [] })
    const pool = new RpcPool({ endpoints: [light, full], dispatch, clock: clock.now })

    await pool.send('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2710' }])
    expect(calls).toEqual(['full.example:eth_getLogs'])
    expect(pool.stats.logsRoutingSkips).toBe(1)
  })

  it('learns a range ceiling from a rejection and respects it afterwards', async () => {
    const clock = fakeClock()
    const a = endpoint('https://a.example', 1, clock.now)
    const b = endpoint('https://b.example', 1, clock.now)
    const { dispatch, calls } = scriptedDispatch({
      'a.example': rpcError(-32000, 'block range is too large'),
      'b.example': [],
    })
    const pool = new RpcPool({ endpoints: [a, b], dispatch, clock: clock.now })

    const wide = [{ fromBlock: '0x0', toBlock: '0x3e7' }]
    await pool.send('eth_getLogs', wide)
    expect(a.logRangeLimit).toBe(999)

    // The next query of the same width skips it without a round trip; a
    // narrower one is still welcome there.
    calls.length = 0
    await pool.send('eth_getLogs', wide)
    expect(calls.some((call) => call.startsWith('a.example'))).toBe(false)
    expect(a.acceptsLogRange(500)).toBe(true)
  })
})

describe('head skew', () => {
  it('holds a two-second note and skips the endpoint without a round trip', async () => {
    const clock = fakeClock()
    const memo = new HeadSkewMemo(2_000, clock.now)
    const late = endpoint('https://late.example', 1, clock.now)
    const current = endpoint('https://current.example', 1, clock.now)
    const { dispatch, calls } = scriptedDispatch({
      'late.example': rpcError(-32602, 'block 500 is beyond current head block 400'),
      'current.example': '0x0',
    })
    const pool = new RpcPool({
      endpoints: [late, current],
      dispatch,
      clock: clock.now,
      memo,
    })

    const request = ['0x1f4', false]
    await pool.send('eth_getBlockByNumber', request)
    expect(pool.stats.headSkewNotes).toBe(1)
    // Behind, but not parked: the node is healthy, just late.
    expect(late.isParked()).toBe(false)

    calls.length = 0
    await pool.send('eth_getBlockByNumber', request)
    expect(calls.some((call) => call.startsWith('late.example'))).toBe(false)
    expect(pool.stats.headSkewSkips).toBe(1)

    // The note is short-lived on purpose: at ~0.1 s per block the endpoint has
    // caught up long before a longer note would expire.
    clock.advance(2_100)
    calls.length = 0
    await pool.send('eth_getBlockByNumber', request)
    expect(calls.some((call) => call.startsWith('late.example'))).toBe(true)
  })
})

describe('pruned state', () => {
  it('walks to an endpoint that retains the block, and remembers', async () => {
    const clock = fakeClock()
    const pruning = endpoint('https://pruning.example', 1, clock.now, { logs: true }, 'user')
    const archive = endpoint('https://archive.example', 1, clock.now)
    const { dispatch, calls } = scriptedDispatch({
      'pruning.example': rpcError(-32000, 'metadata is not found, 45531004'),
      'archive.example': '0xdeadbeef',
    })
    const pool = new RpcPool({ endpoints: [pruning, archive], dispatch, clock: clock.now })

    const params = ['0x0000000000000000000000000000000000000001', '0x2b6a13c']
    expect(await pool.send('eth_getBalance', params)).toBe('0xdeadbeef')
    expect(pool.stats.prunedWalks).toBe(1)
    expect(pruning.prunedBelow).toBe(0x2b6a13cn)

    calls.length = 0
    await pool.send('eth_getBalance', params)
    expect(calls.some((call) => call.startsWith('pruning.example'))).toBe(false)
    expect(pool.stats.prunedSkips).toBe(1)
  })

  it('skips an endpoint whose retention window excludes the block', async () => {
    const clock = fakeClock()
    const shallow = endpoint('https://shallow.example', 1, clock.now, {
      logs: true,
      stateWindowBlocks: 6_000,
    })
    const deep = endpoint('https://deep.example', 1, clock.now)
    const { dispatch, calls } = scriptedDispatch({
      // 45,523,260, a realistic head for this chain, ~0.1 s per block.
      'shallow.example': '0x2b6a13c',
      'deep.example': '0x1',
    })
    const pool = new RpcPool({ endpoints: [shallow, deep], dispatch, clock: clock.now })

    // Teach the pool where the head is, then read state well behind it.
    await pool.send('eth_blockNumber')
    expect(pool.head).toBe(0x2b6a13cn)

    calls.length = 0
    await pool.send('eth_getBalance', ['0x0000000000000000000000000000000000000001', '0x1'])
    expect(calls.some((call) => call.startsWith('shallow.example'))).toBe(false)
    expect(pool.stats.prunedSkips).toBe(1)

    // Inside the window it is a perfectly good endpoint again.
    calls.length = 0
    await pool.send('eth_getBalance', ['0x0000000000000000000000000000000000000001', '0x2b69e5c'])
    expect(calls.some((call) => call.startsWith('shallow.example'))).toBe(true)
  })
})

describe('metered endpoints', () => {
  it('tries a metered endpoint last but does not drop it', async () => {
    const clock = fakeClock()
    const metered = endpoint('https://slow.example', 1, clock.now, {
      logs: true,
      minIntervalMs: 10_000,
    })
    const { dispatch, calls } = scriptedDispatch({ 'slow.example': '0x1' })
    const pool = new RpcPool({ endpoints: [metered], dispatch, clock: clock.now })

    await pool.send('eth_chainId')
    calls.length = 0
    // Inside the interval, and the only endpoint there is: a probable 429 still
    // beats reporting the tier exhausted.
    await pool.send('eth_chainId')
    expect(calls).toEqual(['slow.example:eth_chainId'])
    expect(pool.stats.rateWindowDeferrals).toBe(1)
  })

  it('prefers an unmetered endpoint while the interval has not elapsed', async () => {
    const clock = fakeClock()
    const metered = endpoint('https://slow.example', 1, clock.now, {
      logs: true,
      minIntervalMs: 10_000,
    })
    const fast = endpoint('https://fast.example', 1, clock.now)
    const { dispatch, calls } = scriptedDispatch({})
    const pool = new RpcPool({ endpoints: [metered, fast], dispatch, clock: clock.now })

    await pool.send('eth_chainId')
    await pool.send('eth_chainId')
    await pool.send('eth_chainId')
    expect(calls.filter((call) => call.startsWith('slow.example')).length).toBeLessThanOrEqual(1)
  })
})

describe('tiering', () => {
  it('reaches the paid tier only once every free endpoint has been tried', async () => {
    const clock = fakeClock()
    const a = endpoint('https://a.example', 1, clock.now)
    const b = endpoint('https://b.example', 1, clock.now)
    const paid = endpoint('https://paid.example', 2, clock.now)
    const warnings: string[] = []
    const { dispatch, calls } = scriptedDispatch({
      'a.example': httpError(500),
      'b.example': httpError(500),
      'paid.example': '0x2a',
    })
    const pool = new RpcPool({
      endpoints: [a, b, paid],
      dispatch,
      clock: clock.now,
      onWarn: (message) => warnings.push(message),
    })

    expect(await pool.send('eth_chainId')).toBe('0x2a')
    expect(calls).toHaveLength(3)
    expect(calls[2]).toBe('paid.example:eth_chainId')
    expect(pool.stats.paidTierEngaged).toBe(1)
    expect(warnings[0]).toMatch(/paid tier/)
  })

  it('raises NoPaidFallbackError rather than failing silently', async () => {
    const clock = fakeClock()
    const a = endpoint('https://a.example', 1, clock.now)
    const { dispatch } = scriptedDispatch({ 'a.example': httpError(500) })
    const pool = new RpcPool({ endpoints: [a], dispatch, clock: clock.now })

    // Not a misconfiguration: it means bulk work degrades instead of turning an
    // outage into an invoice.
    await expect(pool.send('eth_chainId')).rejects.toBeInstanceOf(NoPaidFallbackError)
    expect(pool.stats.noPaidFallback).toBe(1)
  })

  it('honours a tier pin of 1 by never touching the paid endpoint', async () => {
    const clock = fakeClock()
    const a = endpoint('https://a.example', 1, clock.now)
    const paid = endpoint('https://paid.example', 2, clock.now)
    const { dispatch, calls } = scriptedDispatch({ 'a.example': httpError(500) })
    const pool = new RpcPool({ endpoints: [a, paid], dispatch, tier: '1', clock: clock.now })

    await expect(pool.send('eth_chainId')).rejects.toThrow(/no endpoint could serve/)
    expect(calls.some((call) => call.startsWith('paid.example'))).toBe(false)
  })
})

describe('writes and pinned sessions', () => {
  it('refuses to route a transaction through the waterfall', async () => {
    const clock = fakeClock()
    const { dispatch } = scriptedDispatch({})
    const pool = new RpcPool({
      endpoints: [endpoint('https://a.example', 1, clock.now)],
      dispatch,
      clock: clock.now,
    })

    // Taking a nonce from one node and broadcasting to another is `nonce too
    // low`, so this must fail loudly rather than round-robin.
    await expect(pool.send('eth_sendRawTransaction', ['0x02f8'])).rejects.toBeInstanceOf(PonsError)
  })

  it('pins one endpoint for a session and does not walk away from it', async () => {
    const clock = fakeClock()
    const a = endpoint('https://a.example', 1, clock.now)
    const b = endpoint('https://b.example', 1, clock.now)
    const { dispatch, calls } = scriptedDispatch({ 'a.example': httpError(500) })
    const pool = new RpcPool({ endpoints: [a, b], dispatch, clock: clock.now })

    const lease = pool.lease()
    await expect(lease.send('eth_blockNumber')).rejects.toThrow()
    // A scan that silently switched nodes would move its cursor across a
    // 24-block head gap and duplicate or skip logs.
    expect(calls.every((call) => call.startsWith('a.example'))).toBe(true)
  })

  it('prefers an unmetered endpoint when pinning', () => {
    const clock = fakeClock()
    const metered = endpoint('https://slow.example', 1, clock.now, {
      logs: true,
      minIntervalMs: 10_000,
    })
    const fast = endpoint('https://fast.example', 1, clock.now)
    const { dispatch } = scriptedDispatch({})
    const pool = new RpcPool({ endpoints: [metered, fast], dispatch, clock: clock.now })

    expect(pool.lease().endpoint.label).toBe('fast.example')
  })
})
