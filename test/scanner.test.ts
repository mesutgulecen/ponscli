import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Log, PublicClient } from 'viem'

import { scanLogs } from '../src/core/index/scanner.js'
import { IndexStore } from '../src/core/index/store.js'

/**
 * The scanner's job is to find the largest chunk an endpoint will answer, and
 * these tests are about that search rather than about the logs themselves.
 * Every limit below was measured against Robinhood Chain, which refuses a
 * query two different ways: one for running too long, one for matching more
 * than ten thousand logs. The two have nothing in common but the code.
 */

interface FakeCall {
  from: bigint
  to: bigint
}

/**
 * A client that answers `getLogs` up to a span and fails beyond it, recording
 * every request so a test can assert on how the range was walked.
 */
function fakeClient(limit: bigint, logsAt: bigint[] = []): { client: PublicClient; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const client = {
    getLogs: ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > limit) {
        return Promise.reject(Object.assign(new Error('log query timed out'), { code: -32000 }))
      }
      calls.push({ from: fromBlock, to: toBlock })
      return Promise.resolve(
        logsAt
          .filter((block) => block >= fromBlock && block <= toBlock)
          .map((block) => ({ blockNumber: block }) as unknown as Log),
      )
    },
  } as unknown as PublicClient
  return { client, calls }
}

describe('scanLogs', () => {
  it('covers the whole range exactly once, with no gap and no overlap', async () => {
    const { client, calls } = fakeClient(1_000_000n)
    await scanLogs(client, { fromBlock: 100n, toBlock: 10_000n, initialSpan: 1_000n })

    expect(calls[0]?.from).toBe(100n)
    expect(calls[calls.length - 1]?.to).toBe(10_000n)
    for (const [index, call] of calls.entries()) {
      if (index === 0) continue
      expect(call.from).toBe((calls[index - 1] as FakeCall).to + 1n)
    }
  })

  it('never asks past the upper bound, even when the span would overshoot', async () => {
    const { client, calls } = fakeClient(1_000_000n)
    await scanLogs(client, { fromBlock: 0n, toBlock: 999n, initialSpan: 500_000n })
    expect(calls).toEqual([{ from: 0n, to: 999n }])
  })

  it('halves the span on a timeout and retries the same starting block', async () => {
    // 10,000 fails, 5,000 fails, 2,500 answers, with the same `from` throughout.
    const { client, calls } = fakeClient(2_500n)
    await scanLogs(client, { fromBlock: 0n, toBlock: 2_499n, initialSpan: 10_000n })
    expect(calls).toEqual([{ from: 0n, to: 2_499n }])
  })

  it('grows the span again after a chunk answers', async () => {
    const { client, calls } = fakeClient(1_000_000n)
    await scanLogs(client, { fromBlock: 0n, toBlock: 9_999n, initialSpan: 1_000n })
    const first = (calls[0] as FakeCall).to - (calls[0] as FakeCall).from + 1n
    const second = (calls[1] as FakeCall).to - (calls[1] as FakeCall).from + 1n
    expect(first).toBe(1_000n)
    expect(second).toBe(1_500n)
  })

  it('subdivides on the result cap, whose wording is not the timeout wording', async () => {
    // This chain refuses a dense query with `logs matched by query exceeds
    // limit of 10000`, which matches none of the usual "too many results"
    // phrases. Left unrecognised it would be re-thrown as a hard failure.
    let asked = 0
    const client = {
      getLogs: ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        asked += 1
        if (toBlock - fromBlock + 1n > 500n) {
          return Promise.reject(
            Object.assign(new Error('logs matched by query exceeds limit of 10000'), { code: -32000 }),
          )
        }
        return Promise.resolve([])
      },
    } as unknown as PublicClient

    await expect(
      scanLogs(client, { fromBlock: 0n, toBlock: 1_499n, initialSpan: 4_000n, minSpan: 100n }),
    ).resolves.toEqual([])
    // Three refusals as 4,000 halves to 500, then the chunks that answer.
    expect(asked).toBeGreaterThan(3)
  })

  it('re-throws an error that is not about the range', async () => {
    const client = {
      getLogs: () => Promise.reject(Object.assign(new Error('unauthorized'), { code: 401 })),
    } as unknown as PublicClient

    await expect(scanLogs(client, { fromBlock: 0n, toBlock: 10n })).rejects.toThrow('unauthorized')
  })

  it('gives up rather than subdividing below the floor', async () => {
    // Nothing this endpoint will answer, so halving must terminate.
    const { client } = fakeClient(1n)
    await expect(
      scanLogs(client, { fromBlock: 0n, toBlock: 10_000n, initialSpan: 1_000n, minSpan: 100n }),
    ).rejects.toThrow('log query timed out')
  })

  it('returns the logs from every chunk in order', async () => {
    const { client } = fakeClient(1_000n, [5n, 1_500n, 2_900n])
    const logs = await scanLogs(client, { fromBlock: 0n, toBlock: 2_999n, initialSpan: 1_000n })
    expect(logs.map((log) => log.blockNumber)).toEqual([5n, 1_500n, 2_900n])
  })
})

describe('IndexStore', () => {
  // Reset as well as removed. Leaving the name behind hands the next test a
  // path that no longer exists, which the store papers over by recreating it
  // and a test writing there directly does not.
  let dir: string | undefined

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  function cacheDir(): string {
    dir ??= mkdtempSync(join(tmpdir(), 'ponscli-cache-'))
    return dir
  }

  function store(chainId = 4663): IndexStore {
    return new IndexStore({ dir: cacheDir(), chainId, now: () => 1_700_000_000 })
  }

  it('round-trips a value', () => {
    const cache = store()
    cache.write('pairs', { scannedTo: '42' })
    expect(cache.read<{ scannedTo: string }>('pairs')?.value).toEqual({ scannedTo: '42' })
  })

  it('returns undefined for an entry that was never written', () => {
    expect(store().read('nothing')).toBeUndefined()
  })

  it('refuses an entry written for another chain', () => {
    const cache = store(4663)
    cache.write('pairs', { scannedTo: '42' })
    expect(store(1).read('pairs')).toBeUndefined()
  })

  it('discards a corrupt file rather than raising', () => {
    const cache = store()
    cache.write('pairs', { scannedTo: '42' })
    writeFileSync(cache.path('pairs'), 'not json at all')
    // A cache is an optimisation: a broken one must cost a rescan, not the run.
    expect(cache.read('pairs')).toBeUndefined()
  })

  it('survives a directory it cannot write to', () => {
    // A path *under a regular file*, which every OS refuses with ENOTDIR. The
    // earlier version pointed at `/proc/nonexistent`, which only fails the way
    // this test wants on a system with no procfs — that is, on the machine it
    // was written on and not on the one CI runs.
    const blocker = join(cacheDir(), 'not-a-directory')
    writeFileSync(blocker, '')
    const cache = new IndexStore({ dir: join(blocker, 'ponscli'), chainId: 4663 })
    expect(() => cache.write('pairs', { scannedTo: '1' })).not.toThrow()
    expect(cache.read('pairs')).toBeUndefined()
  })
})
