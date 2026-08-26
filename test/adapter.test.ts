import { describe, expect, it } from 'vitest'

import {
  GRADUATION_PHASES,
  marketCap,
  snipeTaxBpsAt,
  spotPrice,
  type V2Launch,
} from '../src/core/adapters/v2.js'

/** The live shape of a fresh native launch, trimmed to what the maths uses. */
function launch(overrides: Partial<V2Launch> = {}): V2Launch {
  return {
    token: '0x44D6736eB4Bc60c17Fe8220062d8fdE3C28920f4',
    curve: '0x60CeF8379Aa278F087074bC60595778985c1bD8E',
    creatorFeeRecipient: '0xCAefbb5e99d0c48a7Aa49936662b174a3c2eaD61',
    deployer: '0xCAefbb5e99d0c48a7Aa49936662b174a3c2eaD61',
    phase: 'NotGraduated',
    quote: {
      address: '0x0000000000000000000000000000000000000000',
      native: true,
      symbol: 'ETH',
      decimals: 18,
    },
    metadata: { name: '蛋猫', symbol: 'Danmao', decimals: 18, totalSupply: 10n ** 27n },
    reserves: {
      quote: 1_680_000_000_000_000_001n,
      realQuote: 1n,
      phantomQuote: 1_680_000_000_000_000_000n,
      token: 10n ** 27n,
      sellable: 714_285_714_285_714_285_714_285_715n,
      reserved: 285_714_285_714_285_714_285_714_285n,
    },
    graduation: { threshold: 4_200_000_000_000_000_000n, ready: false, graduated: false },
    snipeTax: { startBps: 9900n, windowSeconds: 3n, currentBps: 0n },
    fees: {
      curveFeeBps: 100n,
      creatorTaxBps: 0n,
      protocolFeeShareBps: 3000,
      buybackBurnBps: 5000,
      hookFeeBps: 100,
      maxInternalPriceImpactBps: 300,
    },
    buyback: { enabled: false, quoteBalance: 0n },
    pending: { quoteFees: 99_499_999_999_999n, creatorTax: 0n },
    launchedAt: 1_787_654_670n,
    swept: { quote: 0n, tokens: 0n, at: 0n },
    ...overrides,
  }
}

describe('snipeTaxBpsAt', () => {
  // Mirrors `PonsV2BondingCurve.currentSnipeTaxBps`: fourteen halvings spread
  // evenly across the window, in integer arithmetic.
  it('starts at the launch rate', () => {
    expect(snipeTaxBpsAt(9900n, 3n, 0n)).toBe(9900n)
  })

  it('halves once per fourteenth of the window', () => {
    // With a 3-second window each elapsed second is four halvings.
    expect(snipeTaxBpsAt(9900n, 3n, 1n)).toBe(9900n >> 4n)
    expect(snipeTaxBpsAt(9900n, 3n, 2n)).toBe(9900n >> 9n)
  })

  it('is zero once the window has passed', () => {
    expect(snipeTaxBpsAt(9900n, 3n, 3n)).toBe(0n)
    expect(snipeTaxBpsAt(9900n, 3n, 4_000n)).toBe(0n)
  })

  it('decays to a rounding error by the end of the window', () => {
    // Fourteen halvings because 2^14 exceeds the 9,900 maximum start: by the
    // last step the tax is one basis point, not a rate anybody would notice.
    // It only becomes exactly zero when the window closes.
    expect(snipeTaxBpsAt(9900n, 14n, 13n)).toBe(1n)
    expect(snipeTaxBpsAt(9900n, 14n, 14n)).toBe(0n)
  })

  it('is zero when the launch disabled it', () => {
    expect(snipeTaxBpsAt(0n, 3n, 0n)).toBe(0n)
    expect(snipeTaxBpsAt(9900n, 0n, 0n)).toBe(0n)
  })
})

describe('spotPrice', () => {
  it('prices one whole token off the reserves', () => {
    // 1.68 ETH of reserve against 1e9 tokens is 1.68e-9 ETH each.
    expect(spotPrice(launch())).toBe(1_680_000_000n)
  })

  it('is zero rather than a division by zero on a drained curve', () => {
    const drained = launch()
    drained.reserves.token = 0n
    expect(spotPrice(drained)).toBe(0n)
  })

  it('prices in the quote asset, whatever its decimals', () => {
    // USDG is 6-decimal; the price comes back in its base units, not in wei.
    const usdg = launch()
    usdg.quote = {
      address: '0x5fC5360D0400a0FD4f2Af552AdD042d716f1D168',
      native: false,
      symbol: 'USDG',
      decimals: 6,
    }
    usdg.reserves.quote = 3_236_000_000n
    expect(spotPrice(usdg)).toBe(3n)
  })
})

describe('marketCap', () => {
  it('is the spot price across the whole supply', () => {
    expect(marketCap(launch())).toBe(1_680_000_000_000_000_000n)
  })
})

describe('GRADUATION_PHASES', () => {
  it('matches the contract enum, in order', () => {
    expect(GRADUATION_PHASES).toEqual(['NotGraduated', 'Swept', 'PoolCreated', 'Rescued'])
  })
})
