import { afterEach, describe, expect, it } from 'vitest'

import { Endpoint } from '../src/chain/endpoint.js'
import type { Dispatch } from '../src/chain/pool.js'
import { probeEndpoint } from '../src/chain/probe.js'
import { ExitCode } from '../src/errors.js'
import { run } from '../src/program.js'
import { BufferSink, createTempHome, type TempHome } from './helpers.js'

const CHAIN_ID_HEX = '0x1237'
const HEAD_HEX = '0x2b6a13c'

function endpoint(url: string, minIntervalMs?: number): Endpoint {
  return new Endpoint({
    url,
    tier: 1,
    origin: 'default',
    capabilities: minIntervalMs === undefined ? { logs: true } : { logs: true, minIntervalMs },
  })
}

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error('RPC Request failed.'), {
    cause: Object.assign(new Error(message), { code, details: message }),
  })
}

/** Answers each method from a table; anything absent throws. */
function fakeNode(answers: Record<string, unknown>): Dispatch {
  return (_endpoint, method) => {
    const answer = answers[method]
    if (answer instanceof Error) return Promise.reject(answer)
    if (answer === undefined) return Promise.reject(rpcError(-32601, `no ${method}`))
    return Promise.resolve(answer)
  }
}

const HEALTHY: Record<string, unknown> = {
  eth_chainId: CHAIN_ID_HEX,
  eth_blockNumber: HEAD_HEX,
  eth_call: '0x0000000000000000000000000000000000000000000000000038d7ea4c68000',
  eth_getLogs: [],
  eth_getBalance: '0x0',
}

describe('probeEndpoint', () => {
  it('marks a fully working endpoint usable', async () => {
    const report = await probeEndpoint(fakeNode(HEALTHY), endpoint('https://a.example'))
    expect(report.usable).toBe(true)
    expect(report.probes.every((probe) => probe.ok)).toBe(true)
  })

  it('catches the endpoint that answers chainId and nothing else', async () => {
    // The measured drpc trap: fastest `eth_chainId` of any endpoint, then
    // `-32601` for `eth_call` and `eth_blockNumber`. A liveness ping calls this
    // healthy; the whole reason `doctor` uses real calls is to catch it.
    const report = await probeEndpoint(
      fakeNode({ eth_chainId: CHAIN_ID_HEX }),
      endpoint('https://drpc.example'),
    )
    expect(report.usable).toBe(false)
    const byName = new Map(report.probes.map((probe) => [probe.name, probe]))
    expect(byName.get('chainId')?.ok).toBe(true)
    expect(byName.get('call')?.ok).toBe(false)
    expect(byName.get('call')?.reason).toBe('unsupported-method')
  })

  it('reports a wrong chain rather than treating any answer as success', async () => {
    const report = await probeEndpoint(
      fakeNode({ ...HEALTHY, eth_chainId: '0x1' }),
      endpoint('https://mainnet.example'),
    )
    expect(report.usable).toBe(false)
    expect(report.probes[0]?.detail).toMatch(/expected 4663/)
  })

  it('names pruning as pruning, not as a fault', async () => {
    const report = await probeEndpoint(
      fakeNode({
        ...HEALTHY,
        eth_getBalance: rpcError(-32000, 'metadata is not found, 45531004'),
      }),
      endpoint('https://official.example'),
    )
    // Pruning is normal retention. The endpoint is still usable for reads.
    expect(report.usable).toBe(true)
    const archive = report.probes.find((probe) => probe.name === 'archive')
    expect(archive?.reason).toBe('pruned')
  })

  it('stops probing a metered endpoint at its limit instead of failing it', async () => {
    let served = 0
    const dispatch: Dispatch = (_endpoint, method) => {
      served += 1
      if (served > 1) return Promise.reject(rpcError(-32000, '"rate_limited"'))
      return Promise.resolve(HEALTHY[method])
    }
    const report = await probeEndpoint(dispatch, endpoint('https://slow.example', 10_000))

    // Judged on what it was allowed to answer: one good reply proves it is
    // alive, and the remaining probes are marked metered rather than failed.
    expect(report.usable).toBe(true)
    expect(report.meteredIntervalMs).toBe(10_000)
    expect(report.probes.filter((probe) => probe.detail?.includes('metered')).length).toBeGreaterThan(0)
  })

  it('paces a metered endpoint when told to wait', async () => {
    const slept: number[] = []
    const report = await probeEndpoint(fakeNode(HEALTHY), endpoint('https://slow.example', 10_000), {
      wait: true,
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      },
    })
    expect(report.probes.every((probe) => probe.ok)).toBe(true)
    expect(slept).toEqual([10_000, 10_000, 10_000, 10_000])
  })
})

let temp: TempHome | undefined

afterEach(() => {
  temp?.cleanup()
  temp = undefined
})

describe('pons doctor', () => {
  it('reports every endpoint with its probe results', async () => {
    temp = createTempHome()
    const stdout = new BufferSink()
    const stderr = new BufferSink()
    const code = await run({
      argv: ['doctor', '--json'],
      env: temp.env,
      home: temp.home,
      isTTY: false,
      stdout,
      stderr,
      dispatch: fakeNode(HEALTHY),
    })

    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<{
      chainId: number
      head: string
      endpoints: { label: string; usable: boolean }[]
      summary: { usable: number; total: number; paidTierConfigured: boolean }
    }>()
    expect(payload.chainId).toBe(4663)
    expect(payload.head).toBe(String(BigInt(HEAD_HEX)))
    expect(payload.summary.total).toBe(2)
    expect(payload.summary.usable).toBe(2)
    expect(payload.summary.paidTierConfigured).toBe(false)
  })

  it('includes the paid tier once a key is configured', async () => {
    temp = createTempHome({ PONS_ALCHEMY_KEY: 'test-key-value-1234' })
    const stdout = new BufferSink()
    const code = await run({
      argv: ['doctor', '--json'],
      env: temp.env,
      home: temp.home,
      isTTY: false,
      stdout,
      stderr: new BufferSink(),
      dispatch: fakeNode(HEALTHY),
    })

    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<{
      endpoints: { url: string; tier: number }[]
      summary: { paidTierConfigured: boolean }
    }>()
    expect(payload.summary.paidTierConfigured).toBe(true)
    const paid = payload.endpoints.find((entry) => entry.tier === 2)
    // The key travels in the URL path, so the report must never carry it.
    expect(paid?.url).not.toContain('test-key-value-1234')
    expect(paid?.url).toContain('***')
  })

  it('prints activation counters only when asked', async () => {
    temp = createTempHome()
    const plain = new BufferSink()
    await run({
      argv: ['doctor', '--json'],
      env: temp.env,
      home: temp.home,
      isTTY: false,
      stdout: plain,
      stderr: new BufferSink(),
      dispatch: fakeNode(HEALTHY),
    })
    expect(plain.json<{ stats?: unknown }>().stats).toBeUndefined()

    const withStats = new BufferSink()
    await run({
      argv: ['doctor', '--stats', '--json'],
      env: temp.env,
      home: temp.home,
      isTTY: false,
      stdout: withStats,
      stderr: new BufferSink(),
      dispatch: fakeNode(HEALTHY),
    })
    const stats = withStats.json<{ stats: Record<string, number> }>().stats
    // The head lookup goes through the pool, so this is proof of live traffic.
    expect(stats.requests).toBeGreaterThan(0)
    expect(stats.deterministicNoWalk).toBe(0)
  })
})
