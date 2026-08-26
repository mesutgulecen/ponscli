/**
 * Bonding curve pricing, computed locally.
 *
 * Every formula here is a transcription of `PonsV2BondingCurveMath` and the
 * fee ordering inside `PonsV2BondingCurve.buy` / `.sell`, taken from the
 * factory's verified source. It is done locally rather than through
 * `buy.staticCall` for three reasons: a quote must work with no funded wallet
 * behind it, `--dry-run` must not need one either, and a static call in the
 * snipe-tax window prices the trade at that instant rather than at the second
 * the transaction will actually land.
 *
 * The arithmetic is integer throughout and matches the contract exactly,
 * including its truncation. A quote that is off by one wei in the wrong
 * direction is a revert the user cannot explain.
 */

export const BASIS_POINTS = 10_000n

/** Minimum the contract guarantees a taxed buyer keeps, in basis points. */
const MIN_BUYER_SHARE_BPS = 100n

export class CurveMathError extends Error {
  constructor(readonly reason: 'input' | 'output' | 'liquidity') {
    super(`curve cannot price this trade: ${reason}`)
    this.name = 'CurveMathError'
  }
}

/**
 * Constant-product output for an exact input, net of `feeBps` on the input.
 *
 * The curve always passes `feeBps = 0` here — it deducts its fees from the
 * input before calling — but the parameter is kept because the same formula
 * prices the internal buyback swap, which does charge one.
 */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): bigint {
  if (amountIn <= 0n) throw new CurveMathError('input')
  if (reserveIn <= 0n || reserveOut <= 0n) throw new CurveMathError('liquidity')
  const amountInWithFee = amountIn * (BASIS_POINTS - feeBps)
  const out = (amountInWithFee * reserveOut) / (reserveIn * BASIS_POINTS + amountInWithFee)
  if (out === 0n) throw new CurveMathError('output')
  return out
}

/** Input required for an exact output. Rounds up, exactly as the library does. */
export function getAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): bigint {
  if (amountOut <= 0n) throw new CurveMathError('output')
  if (reserveIn <= 0n || reserveOut <= amountOut) throw new CurveMathError('liquidity')
  if (feeBps >= BASIS_POINTS) throw new CurveMathError('liquidity')
  const numerator = amountOut * reserveIn * BASIS_POINTS
  const denominator = (reserveOut - amountOut) * (BASIS_POINTS - feeBps)
  return numerator / denominator + 1n
}

/** `Math.mulDiv(x, y, d, Rounding.Ceil)` — the curve's own gross-up. */
function mulDivCeil(x: bigint, y: bigint, denominator: bigint): bigint {
  const product = x * y
  return product % denominator === 0n ? product / denominator : product / denominator + 1n
}

export interface CurveState {
  /** Tradeable quote reserve, phantom included. */
  quoteReserve: bigint
  tokenReserve: bigint
  /** Tokens held back to seed the graduated pool. */
  reservedTokens: bigint
  curveFeeBps: bigint
  creatorTaxBps: bigint
}

export interface BuyQuote {
  /** Quote the buyer sends. Equals `spent` unless the fill was clamped. */
  offered: bigint
  /** Quote actually consumed by the fill. */
  spent: bigint
  /** Quote returned to the buyer when the fill hit the reserved allocation. */
  refund: bigint
  tokensOut: bigint
  curveFee: bigint
  creatorTax: bigint
  snipeTax: bigint
  /** True when the buy ran into the reserved allocation and was partly filled. */
  clamped: boolean
}

/**
 * Cap the snipe tax the way the curve does.
 *
 * The contract bounds the combined take so a taxed buyer always keeps at least
 * one percent of their spend, which is also what stops the clamped-fill
 * gross-up dividing by zero.
 */
export function boundedSnipeTaxBps(state: CurveState, snipeTaxBps: bigint): bigint {
  if (snipeTaxBps === 0n) return 0n
  const max = BASIS_POINTS - state.curveFeeBps - state.creatorTaxBps - MIN_BUYER_SHARE_BPS
  return snipeTaxBps > max ? max : snipeTaxBps
}

/**
 * Price a buy of `offered` quote units.
 *
 * Mirrors `PonsV2BondingCurve.buy`: the three fee legs come off the input, the
 * remainder swaps against the reserves, and a fill that would cross into the
 * reserved allocation is clamped to it and the input grossed back up — the
 * buyer is charged for what they actually received and refunded the rest.
 */
export function quoteBuy(state: CurveState, offered: bigint, snipeTaxBps = 0n): BuyQuote {
  if (offered <= 0n) throw new CurveMathError('input')
  const sellable =
    state.tokenReserve > state.reservedTokens ? state.tokenReserve - state.reservedTokens : 0n
  if (sellable === 0n) throw new CurveMathError('liquidity')

  const bounded = boundedSnipeTaxBps(state, snipeTaxBps)
  const legs = (amount: bigint): { fee: bigint; tax: bigint; snipe: bigint } => ({
    fee: (amount * state.curveFeeBps) / BASIS_POINTS,
    tax: (amount * state.creatorTaxBps) / BASIS_POINTS,
    snipe: (amount * bounded) / BASIS_POINTS,
  })

  let spent = offered
  let { fee, tax, snipe } = legs(spent)
  let tokensOut = getAmountOut(
    spent - fee - tax - snipe,
    state.quoteReserve,
    state.tokenReserve,
    0n,
  )

  let clamped = false
  if (tokensOut > sellable) {
    clamped = true
    tokensOut = sellable
    const net = getAmountIn(sellable, state.quoteReserve, state.tokenReserve, 0n)
    const grossed = mulDivCeil(
      net,
      BASIS_POINTS,
      BASIS_POINTS - state.curveFeeBps - state.creatorTaxBps - bounded,
    )
    spent = grossed < offered ? grossed : offered
    ;({ fee, tax, snipe } = legs(spent))
  }

  return {
    offered,
    spent,
    refund: offered - spent,
    tokensOut,
    curveFee: fee,
    creatorTax: tax,
    snipeTax: snipe,
    clamped,
  }
}

export interface SellQuote {
  tokensIn: bigint
  /** Output before the fee legs. */
  gross: bigint
  quoteOut: bigint
  curveFee: bigint
  creatorTax: bigint
}

/**
 * Price a sell of `tokensIn`.
 *
 * Mirrors `PonsV2BondingCurve.sell`: the swap happens first and the fees come
 * off the output, which is the opposite order from a buy. Getting it backwards
 * overstates the proceeds by roughly the fee.
 */
export function quoteSell(state: CurveState, tokensIn: bigint): SellQuote {
  if (tokensIn <= 0n) throw new CurveMathError('input')
  const gross = getAmountOut(tokensIn, state.tokenReserve, state.quoteReserve, 0n)
  const curveFee = (gross * state.curveFeeBps) / BASIS_POINTS
  const creatorTax = (gross * state.creatorTaxBps) / BASIS_POINTS
  return { tokensIn, gross, quoteOut: gross - curveFee - creatorTax, curveFee, creatorTax }
}

/**
 * Apply a slippage tolerance to an expected output.
 *
 * Rounds down, so the floor is never above what the tolerance allows. A
 * tolerance of zero still leaves the exact quote as the floor, which is a
 * legitimate "this price or nothing" order.
 */
export function withSlippage(expected: bigint, slippageBps: bigint): bigint {
  if (slippageBps <= 0n) return expected
  if (slippageBps >= BASIS_POINTS) return 0n
  return (expected * (BASIS_POINTS - slippageBps)) / BASIS_POINTS
}

/**
 * The floor a trade is held to, given what slippage computes and what the user
 * already accepted.
 *
 * The higher of the two, always. A plan rebuilt from fresher state carries its
 * own slippage floor, and taking that one on its own is how a rebuild ends up
 * signed **below** the floor its user approved: the price only has to move
 * adversely by less than the tolerance for the gate to pass while the new floor
 * sits under the old one. Measured before this existed, a 1% tolerance could be
 * signed at 0.99% below the accepted floor — an effective tolerance of nearly
 * twice what was asked for.
 */
export function floorAtLeast(computed: bigint, accepted: bigint | undefined): bigint {
  if (accepted === undefined) return computed
  return computed > accepted ? computed : accepted
}

/**
 * Price impact of a trade against the mid price, in basis points.
 *
 * Measured against the reserves before the trade, so it is the cost of size
 * alone — fees and the snipe tax are reported separately rather than folded in
 * here, because a user can act on those two facts differently.
 */
export function priceImpactBps(amountIn: bigint, reserveIn: bigint, amountOut: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || amountOut <= 0n) return 0n
  // Ideal output at the mid price, against what the curve actually returns.
  const ideal = (amountIn * reserveOut) / reserveIn
  if (ideal <= amountOut) return 0n
  return ((ideal - amountOut) * BASIS_POINTS) / ideal
}
