import { describe, expect, it } from 'vitest'

import { PonsError } from '../src/errors.js'
import { Reporter, renderTable, stringify } from '../src/output/index.js'
import { createPainter, shouldColorize, visibleWidth } from '../src/output/color.js'
import { BufferSink } from './helpers.js'

function reporter(json: boolean) {
  const stdout = new BufferSink()
  const stderr = new BufferSink()
  return {
    stdout,
    stderr,
    reporter: new Reporter({ json, color: 'never', pretty: false, stdout, stderr, env: {}, isTTY: false }),
  }
}

describe('json serialization', () => {
  it('renders bigint as a decimal string', () => {
    // Wei amounts exceed Number.MAX_SAFE_INTEGER, so a JSON number would
    // silently round somebody's balance.
    const wei = 12_345_678_901_234_567_890n
    expect(stringify({ wei }, false)).toBe('{"wei":"12345678901234567890"}')
  })

  it('keeps precision that a JSON number would lose', () => {
    const parsed = JSON.parse(stringify({ wei: 9_007_199_254_740_993n }, false)) as { wei: string }
    expect(parsed.wei).toBe('9007199254740993')
  })

  it('renders Map and Set as plain JSON', () => {
    expect(stringify({ m: new Map([['a', 1]]), s: new Set([1, 2]) }, false)).toBe(
      '{"m":{"a":1},"s":[1,2]}',
    )
  })
})

describe('colour', () => {
  it('honours NO_COLOR under auto', () => {
    expect(shouldColorize('auto', { NO_COLOR: '1' }, true)).toBe(false)
  })

  it('lets an explicit always override NO_COLOR', () => {
    expect(shouldColorize('always', { NO_COLOR: '1' }, false)).toBe(true)
  })

  it('is off when not a TTY', () => {
    expect(shouldColorize('auto', {}, false)).toBe(false)
  })

  it('discounts escape codes when measuring width', () => {
    const painted = createPainter(true)('red', 'abc')
    expect(painted.length).toBeGreaterThan(3)
    expect(visibleWidth(painted)).toBe(3)
  })
})

describe('renderTable', () => {
  it('aligns columns by visible width, not byte length', () => {
    const paint = createPainter(true)
    const table = renderTable(
      [{ header: 'KEY' }, { header: 'VALUE' }],
      [
        [paint('red', 'a'), 'one'],
        ['bbbb', 'two'],
      ],
    )
    // Rows are trimmed of trailing space, so compare where the second column
    // starts rather than total line length. A painted cell padded by the length
    // of its escape codes would push its row out of the grid.
    // eslint-disable-next-line no-control-regex
    const stripped = table.split('\n').map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''))
    expect(stripped[0]?.indexOf('VALUE')).toBe(6)
    expect(stripped[2]?.indexOf('one')).toBe(6)
    expect(stripped[3]?.indexOf('two')).toBe(6)
  })

  it('right-aligns a numeric column', () => {
    const table = renderTable(
      [{ header: 'N', align: 'right' }],
      [['1'], ['1000']],
    )
    expect(table.split('\n').at(-2)).toBe('   1')
  })
})

describe('Reporter channel discipline', () => {
  it('sends results to stdout and warnings to stderr', () => {
    const { reporter: report, stdout, stderr } = reporter(false)
    report.warn('thin liquidity')
    report.emit({ ok: true }, () => 'done')
    expect(stdout.text).toBe('done\n')
    expect(stderr.text).toContain('thin liquidity')
  })

  it('emits one JSON object per result in json mode', () => {
    const { reporter: report, stdout } = reporter(true)
    report.emit({ price: 1n }, () => 'unused')
    expect(stdout.json()).toEqual({ price: '1' })
  })

  it('suppresses human-only notes in json mode', () => {
    const { reporter: report, stderr } = reporter(true)
    report.note('scanning 500k blocks')
    expect(stderr.text).toBe('')
  })

  it('serializes a PonsError with its code and hint', () => {
    const { reporter: report, stderr } = reporter(true)
    report.fail(new PonsError('NO_PAIR', 'no such pair', { hint: 'run pons pairs' }))
    expect(stderr.json()).toEqual({
      ok: false,
      error: { code: 'NO_PAIR', message: 'no such pair', hint: 'run pons pairs' },
    })
  })

  it('reports an unexpected throw as INTERNAL rather than dressing it up', () => {
    const { reporter: report, stderr } = reporter(true)
    report.fail(new TypeError('x is not a function'))
    expect(stderr.json<{ error: { code: string } }>().error.code).toBe('INTERNAL')
  })
})
