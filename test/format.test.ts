import { describe, expect, it } from 'vitest'

import { visibleWidth } from '../src/output/color.js'
import {
  formatAge,
  formatAmount,
  formatBps,
  formatDuration,
  formatRatio,
  formatToken,
  shortAddress,
} from '../src/output/format.js'
import { renderTable } from '../src/output/table.js'

describe('formatAmount', () => {
  it('groups a token supply', () => {
    expect(formatAmount(10n ** 27n, 18)).toBe('1,000,000,000')
  })

  it('keeps a price that would round to zero', () => {
    // The spot price of a fresh launch is ~1.68e-9 ETH per token. Four
    // significant digits past the leading zeros is the difference between a
    // usable number and `0.000000`.
    expect(formatAmount(1_680_000_000n, 18)).toBe('0.00000000168')
  })

  it('truncates rather than rounding up', () => {
    // A display that rounds up says the user holds more than they do.
    expect(formatAmount(1_999_999_999_999_999_999n, 18)).toBe('1.99999')
  })

  it('renders whole base units when there are no decimals', () => {
    expect(formatAmount(3_753_250n, 0)).toBe('3,753,250')
  })

  it('handles the 6-decimal quote asset', () => {
    // USDG is the live reason decimals are read rather than assumed.
    expect(formatAmount(3_236_000_000n, 6)).toBe('3,236')
  })

  it('keeps the sign', () => {
    expect(formatAmount(-1_500_000_000_000_000_000n, 18)).toBe('-1.5')
  })

  it('appends the symbol', () => {
    expect(formatToken(5_000_000_000_000_000n, 18, 'ETH')).toBe('0.005 ETH')
  })
})

describe('formatBps', () => {
  it('renders whole percentages without decimals', () => {
    expect(formatBps(100)).toBe('1%')
    expect(formatBps(3000)).toBe('30%')
    expect(formatBps(9900)).toBe('99%')
  })

  it('keeps a fractional percentage', () => {
    expect(formatBps(1)).toBe('0.01%')
    expect(formatBps(150)).toBe('1.5%')
  })
})

describe('formatRatio', () => {
  it('reports progress towards a threshold', () => {
    expect(formatRatio(2_100_000_000_000_000_000n, 4_200_000_000_000_000_000n)).toBe('50.0%')
  })

  it('does not divide by zero', () => {
    expect(formatRatio(1n, 0n)).toBe('-')
  })
})

describe('formatDuration', () => {
  it('stops at two units', () => {
    expect(formatDuration(3n)).toBe('3s')
    expect(formatDuration(125n)).toBe('2m 5s')
    expect(formatDuration(90_061n)).toBe('1d 1h')
  })

  it('reads a launch age', () => {
    expect(formatAge(1_000n, 1_125n)).toBe('2m 5s ago')
    expect(formatAge(2_000n, 1_000n)).toBe('in the future')
  })
})

describe('shortAddress', () => {
  it('keeps both ends', () => {
    expect(shortAddress('0x44D6736eB4Bc60c17Fe8220062d8fdE3C28920f4')).toBe('0x44D6…20f4')
  })
})

describe('visibleWidth', () => {
  it('discounts ANSI escapes', () => {
    expect(visibleWidth('[32mok[0m')).toBe(2)
  })

  it('counts a CJK ideograph as two columns', () => {
    // A live launch is named 蛋猫. Measuring it in code units puts every
    // column after it two cells out.
    expect(visibleWidth('蛋猫')).toBe(4)
  })

  it('counts an emoji as two columns, not two characters', () => {
    expect(visibleWidth('🚀')).toBe(2)
  })

  it('gives combining marks no width of their own', () => {
    expect(visibleWidth('é')).toBe(1)
  })
})

describe('renderTable', () => {
  it('aligns columns around a wide glyph', () => {
    const table = renderTable(
      [{ header: '' }, { header: '' }],
      [
        ['蛋猫', 'x'],
        ['ab', 'y'],
      ],
    )
    const [first = '', second = ''] = table.split('\n')
    // Compared in columns, not code units: `indexOf` would measure the very
    // thing the padding is correcting for.
    expect(visibleWidth(first.slice(0, first.indexOf('x')))).toBe(
      visibleWidth(second.slice(0, second.indexOf('y'))),
    )
  })

  it('drops the header rule when no column is named', () => {
    const table = renderTable([{ header: '' }, { header: '' }], [['a', 'b']])
    expect(table).toBe('a  b')
  })

  it('keeps the header rule when a column is named', () => {
    const table = renderTable([{ header: 'K' }, { header: 'V' }], [['a', 'b']])
    expect(table.split('\n')).toHaveLength(3)
  })
})
