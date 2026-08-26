import { describe, expect, it } from 'vitest'

import { HeadSkewMemo } from '../src/chain/headSkew.js'

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start
  return { now: () => value, advance: (ms) => (value += ms) }
}

describe('HeadSkewMemo', () => {
  it('generalises from a disclosed head to every block above it', () => {
    // The measured pattern was ~8 repeats per (requested, head) pair. Storing
    // the head rather than the one failed block covers all eight, and every
    // other block above it too.
    const time = clock()
    const memo = new HeadSkewMemo(2_000, time.now)
    memo.note('https://a.example', 500n, 400n)

    expect(memo.isBehind('https://a.example', 401n)).toBe(true)
    expect(memo.isBehind('https://a.example', 500n)).toBe(true)
    expect(memo.isBehind('https://a.example', 400n)).toBe(false)
    expect(memo.preventedRequests).toBe(2)
  })

  it('falls back to one below the requested block when no head is disclosed', () => {
    const time = clock()
    const memo = new HeadSkewMemo(2_000, time.now)
    memo.note('https://a.example', 500n, undefined)
    expect(memo.isBehind('https://a.example', 500n)).toBe(true)
    expect(memo.isBehind('https://a.example', 499n)).toBe(false)
  })

  it('expires after the window so a caught-up endpoint returns', () => {
    // Deliberately brief: at ~0.1 s per block a longer note would exclude an
    // endpoint that advanced tens of blocks ago.
    const time = clock()
    const memo = new HeadSkewMemo(2_000, time.now)
    memo.note('https://a.example', 500n, 400n)

    time.advance(1_999)
    expect(memo.isBehind('https://a.example', 500n)).toBe(true)
    time.advance(2)
    expect(memo.isBehind('https://a.example', 500n)).toBe(false)
  })

  it('keeps the most optimistic bound seen inside the window', () => {
    const time = clock()
    const memo = new HeadSkewMemo(2_000, time.now)
    memo.note('https://a.example', 500n, 400n)
    memo.note('https://a.example', 500n, 450n)
    // The endpoint advanced; an older, lower note must not undo that.
    expect(memo.isBehind('https://a.example', 430n)).toBe(false)
  })

  it('never blocks a request with no numeric block', () => {
    const time = clock()
    const memo = new HeadSkewMemo(2_000, time.now)
    memo.note('https://a.example', 500n, 400n)
    expect(memo.isBehind('https://a.example', undefined)).toBe(false)
  })

  it('notes are per endpoint', () => {
    const time = clock()
    const memo = new HeadSkewMemo(2_000, time.now)
    memo.note('https://a.example', 500n, 400n)
    expect(memo.isBehind('https://b.example', 500n)).toBe(false)
  })

  it('drops expired entries when listing', () => {
    const time = clock()
    const memo = new HeadSkewMemo(2_000, time.now)
    memo.note('https://a.example', 500n, 400n)
    expect(memo.entries()).toHaveLength(1)
    time.advance(2_001)
    expect(memo.entries()).toHaveLength(0)
  })
})
