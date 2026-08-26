import { describe, expect, it } from 'vitest'

import {
  CurveMathError,
  boundedSnipeTaxBps,
  getAmountIn,
  getAmountOut,
  priceImpactBps,
  quoteBuy,
  quoteSell,
  withSlippage,
  type CurveState,
} from '../src/core/quote.js'

/**
 * The reserves of a live launch, read on 2026-08-25. The expected outputs below
 * were checked against `buy.staticCall` on the deployed curve; local and
 * on-chain agreed to the wei, including the clamped fill.
 */
const STATE: CurveState = {
  quoteReserve: 1_680_000_000_000_000_001n,
  tokenReserve: 10n ** 27n,
  reservedTokens: 285_714_285_714_285_714_285_714_285n,
  curveFeeBps: 100n,
  creatorTaxBps: 0n,
}

describe('getAmountOut', () => {
  it('is the constant-product formula the library uses', () => {
    expect(getAmountOut(1_000n, 10_000n, 10_000n, 0n)).toBe(909n)
  })

  it('charges the fee on the input', () => {
    // 1% off the input before the swap, not off the output.
    expect(getAmountOut(1_000n, 10_000n, 10_000n, 100n)).toBe(900n)
  })

  it('refuses a trade the curve cannot price', () => {
    expect(() => getAmountOut(0n, 10n, 10n, 0n)).toThrow(CurveMathError)
    expect(() => getAmountOut(10n, 0n, 10n, 0n)).toThrow(CurveMathError)
    // Too small to move the output by a single unit.
    expect(() => getAmountOut(1n, 10n ** 18n, 10n, 0n)).toThrow(CurveMathError)
  })
})

describe('getAmountIn', () => {
  it('rounds up, so the output is always reachable', () => {
    const needed = getAmountIn(909n, 10_000n, 10_000n, 0n)
    expect(getAmountOut(needed, 10_000n, 10_000n, 0n)).toBeGreaterThanOrEqual(909n)
  })

  it('refuses to price more output than the reserve holds', () => {
    expect(() => getAmountIn(10_000n, 10_000n, 10_000n, 0n)).toThrow(CurveMathError)
  })
})

describe('quoteBuy', () => {
  it('matches the deployed curve for a plain buy', () => {
    // `buy.staticCall(0.05 ETH)` on curve 0x60Ce…bD8E returned exactly this.
    const quote = quoteBuy(STATE, 50_000_000_000_000_000n)
    expect(quote.tokensOut).toBe(28_620_988_725_065_047_685_099_168n)
    expect(quote.spent).toBe(50_000_000_000_000_000n)
    expect(quote.refund).toBe(0n)
    expect(quote.clamped).toBe(false)
    expect(quote.curveFee).toBe(500_000_000_000_000n)
  })

  it('clamps a buy that would cross the reserved allocation and refunds the rest', () => {
    // `buy.staticCall(10 ETH)` returned the whole sellable supply and charged
    // 4.2424… ETH for it; the difference comes back in the same transaction.
    const quote = quoteBuy(STATE, 10n ** 19n)
    expect(quote.tokensOut).toBe(714_285_714_285_714_285_714_285_715n)
    expect(quote.spent).toBe(4_242_424_242_424_242_428n)
    expect(quote.refund).toBe(10n ** 19n - 4_242_424_242_424_242_428n)
    expect(quote.clamped).toBe(true)
  })

  it('takes the snipe tax off the input alongside the fee', () => {
    const taxed = quoteBuy(STATE, 10n ** 16n, 9900n)
    const untaxed = quoteBuy(STATE, 10n ** 16n, 0n)
    expect(taxed.snipeTax).toBeGreaterThan(0n)
    expect(taxed.tokensOut).toBeLessThan(untaxed.tokensOut / 50n)
  })

  it('bounds the snipe tax so a buyer always keeps something', () => {
    // The contract caps the combined take at 99% minus the other legs.
    expect(boundedSnipeTaxBps(STATE, 9900n)).toBe(9800n)
    expect(boundedSnipeTaxBps({ ...STATE, creatorTaxBps: 1000n }, 9900n)).toBe(8800n)
    expect(boundedSnipeTaxBps(STATE, 0n)).toBe(0n)
  })

  it('refuses to price a buy against a sold-out curve', () => {
    expect(() => quoteBuy({ ...STATE, tokenReserve: STATE.reservedTokens }, 10n ** 16n)).toThrow(
      CurveMathError,
    )
  })
})

describe('quoteSell', () => {
  it('takes the fee off the output, not the input', () => {
    // The opposite order from a buy. Getting it backwards overstates the
    // proceeds by roughly the fee.
    const quote = quoteSell(STATE, 10n ** 24n)
    expect(quote.gross).toBe(1_678_321_678_321_678n)
    expect(quote.curveFee).toBe(quote.gross / 100n)
    expect(quote.quoteOut).toBe(quote.gross - quote.curveFee)
  })

  it('splits the fee and the creator tax off the same gross', () => {
    const quote = quoteSell({ ...STATE, creatorTaxBps: 500n }, 10n ** 24n)
    expect(quote.creatorTax).toBe((quote.gross * 500n) / 10_000n)
    expect(quote.quoteOut).toBe(quote.gross - quote.curveFee - quote.creatorTax)
  })
})

describe('withSlippage', () => {
  it('rounds the floor down', () => {
    expect(withSlippage(1_000n, 100n)).toBe(990n)
    expect(withSlippage(999n, 100n)).toBe(989n)
  })

  it('leaves the exact quote as the floor when the tolerance is zero', () => {
    expect(withSlippage(1_000n, 0n)).toBe(1_000n)
  })
})

describe('priceImpactBps', () => {
  it('measures the cost of size against the mid price', () => {
    // A trade of a tenth of the reserve costs roughly 9% against mid.
    const impact = priceImpactBps(1_000n, 10_000n, getAmountOut(1_000n, 10_000n, 10_000n, 0n), 10_000n)
    expect(impact).toBeGreaterThan(800n)
    expect(impact).toBeLessThan(1_000n)
  })

  it('is zero for a trade too small to move the price', () => {
    expect(priceImpactBps(0n, 10_000n, 0n, 10_000n)).toBe(0n)
  })
})
