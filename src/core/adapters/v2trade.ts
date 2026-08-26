import { encodeFunctionData, erc20Abi, maxUint256, type Address, type PublicClient } from 'viem'

import { buybackVaultAbi, feeEscrowAbi, v2CurveAbi, v2FactoryAbi } from '../../abi/index.js'
import { NATIVE_PAIR_TOKEN, addresses } from '../../chain/addresses.js'
import { ExitCode, PonsError } from '../../errors.js'
import { formatBps, formatToken } from '../../output/format.js'
import { createPlan, warn, type Plan, type PlanWarning } from '../plan.js'
import {
  BASIS_POINTS,
  boundedSnipeTaxBps,
  floorAtLeast,
  priceImpactBps,
  quoteBuy,
  quoteSell,
  withSlippage,
  type CurveState,
} from '../quote.js'
import type { V2Launch } from './v2.js'

/**
 * Turning an intent into a Plan, on the V2 bonding curve.
 *
 * Nothing in this module talks to the network except where it must read a
 * balance or an allowance; the pricing is local, so a plan can be built,
 * printed and simulated with no wallet in sight.
 */

/** Reserves and fee legs, in the shape the pricing functions take. */
export function curveStateOf(launch: V2Launch): CurveState {
  return {
    quoteReserve: launch.reserves.quote,
    tokenReserve: launch.reserves.token,
    reservedTokens: launch.reserves.reserved,
    curveFeeBps: launch.fees.curveFeeBps,
    creatorTaxBps: launch.fees.creatorTaxBps,
  }
}

/**
 * The snipe tax to price a buy at.
 *
 * The curve's own `currentSnipeTaxBps` answers for the block it was read in.
 * A transaction signed now lands at least a block later, so the quote uses the
 * tax as it stands and the warning says how fast it is falling — three seconds
 * is the whole window, and waiting it out is free.
 */
function snipeTaxFor(launch: V2Launch): bigint {
  return boundedSnipeTaxBps(curveStateOf(launch), launch.snipeTax.currentBps)
}

/**
 * Refuse to trade on a curve that cannot serve the trade.
 *
 * The redirect matters more than the refusal: `sell()` reverts once
 * `readyToGraduate()` is true, and a raw `CurveGraduated` leaves the user with
 * no idea that the next step is a permissionless call anyone can make.
 */
function assertTradeable(launch: V2Launch, direction: 'buy' | 'sell'): void {
  if (launch.graduation.graduated || launch.phase !== 'NotGraduated') {
    throw new PonsError('CURVE_GRADUATED', `${launch.metadata.symbol} has graduated off the curve`, {
      exitCode: ExitCode.Revert,
      details: { token: launch.token, phase: launch.phase },
      hint: 'trade the Uniswap V4 pool with --route v4',
    })
  }
  if (direction === 'sell' && launch.graduation.ready) {
    throw new PonsError('READY_TO_GRADUATE', `${launch.metadata.symbol} has raised its threshold and the curve has stopped trading`, {
      exitCode: ExitCode.Revert,
      details: { token: launch.token },
      hint: `anyone can finish it: 'pons graduate ${launch.token}', then sell with --route v4`,
    })
  }
}

export interface BuyOptions {
  amountIn: bigint
  slippageBps: bigint
  recipient: Address
  /**
   * A floor the trade must clear regardless of what slippage computes.
   *
   * Set when a plan is rebuilt before broadcasting, to the floor the user
   * already accepted. Without it the rebuild quietly lowers the floor along
   * with the price.
   */
  minOut?: bigint
}

export function buildCurveBuyPlan(launch: V2Launch, options: BuyOptions): Plan {
  assertTradeable(launch, 'buy')
  const state = curveStateOf(launch)
  const snipeTaxBps = snipeTaxFor(launch)
  const quote = quoteBuy(state, options.amountIn, snipeTaxBps)

  // The floor is expressed against the amount offered, not against the amount
  // the curve ends up spending: the contract's slippage check is a price bound
  // (`spent * minOut > received * tokensOut`), so a partially filled buy is
  // held to the same price rather than failing on quantity.
  const minTokensOut = floorAtLeast(withSlippage(quote.tokensOut, options.slippageBps), options.minOut)

  const warnings: PlanWarning[] = []
  if (snipeTaxBps > 0n) {
    warnings.push(
      warn(
        'snipe-tax',
        `the snipe tax is ${formatBps(snipeTaxBps)} of the amount you send; it decays to nothing within ${launch.snipeTax.windowSeconds.toString()}s of launch, so waiting costs nothing`,
        snipeTaxBps >= 1000n ? 'danger' : 'warn',
      ),
    )
  }
  if (quote.clamped) {
    warnings.push(
      warn(
        'partial-fill',
        `only ${formatToken(quote.spent, launch.quote.decimals, launch.quote.symbol)} of it fits before the curve hits its reserved allocation; the rest is refunded in the same transaction`,
        'warn',
      ),
    )
  }
  const impact = priceImpactBps(quote.spent, state.quoteReserve, quote.tokensOut, state.tokenReserve)
  if (impact >= 500n) {
    warnings.push(warn('price-impact', `this trade moves the price by ${formatBps(impact)}`, impact >= 2000n ? 'danger' : 'warn'))
  }

  const native = launch.quote.address === NATIVE_PAIR_TOKEN
  return createPlan({
    kind: 'buy',
    route: 'curve',
    to: launch.curve,
    data: encodeFunctionData({
      abi: v2CurveAbi,
      functionName: 'buy',
      args: [options.amountIn, minTokensOut, options.recipient],
    }),
    // `_receiveQuote` requires msg.value to equal quoteIn for a native launch
    // and to be zero for an ERC-20 one; there is no third case.
    value: native ? options.amountIn : 0n,
    gasLimit: undefined,
    summary: `buy ${formatToken(quote.tokensOut, launch.metadata.decimals, launch.metadata.symbol)} for ${formatToken(quote.spent, launch.quote.decimals, launch.quote.symbol)}`,
    warnings,
    economics: {
      amountIn: options.amountIn.toString(),
      spent: quote.spent.toString(),
      refund: quote.refund.toString(),
      tokensOut: quote.tokensOut.toString(),
      minTokensOut: minTokensOut.toString(),
      curveFee: quote.curveFee.toString(),
      creatorTax: quote.creatorTax.toString(),
      snipeTax: quote.snipeTax.toString(),
      snipeTaxBps: snipeTaxBps.toString(),
      priceImpactBps: impact.toString(),
      slippageBps: options.slippageBps.toString(),
    },
  })
}

export interface SellOptions {
  tokensIn: bigint
  slippageBps: bigint
  recipient: Address
  /** A floor the trade must clear. See `BuyOptions.minOut`. */
  minOut?: bigint
}

export function buildCurveSellPlan(launch: V2Launch, options: SellOptions): Plan {
  assertTradeable(launch, 'sell')
  const state = curveStateOf(launch)
  const quote = quoteSell(state, options.tokensIn)
  const minQuoteOut = floorAtLeast(withSlippage(quote.quoteOut, options.slippageBps), options.minOut)

  const warnings: PlanWarning[] = []
  const impact = priceImpactBps(options.tokensIn, state.tokenReserve, quote.gross, state.quoteReserve)
  if (impact >= 500n) {
    warnings.push(warn('price-impact', `this trade moves the price by ${formatBps(impact)}`, impact >= 2000n ? 'danger' : 'warn'))
  }
  // Selling into the threshold is not blocked, but it is worth saying: the
  // curve stops trading the moment it is crossed, and the next seller is
  // redirected to graduation.
  if (launch.reserves.realQuote > 0n) {
    const remaining = launch.graduation.threshold - launch.reserves.realQuote
    if (remaining > 0n && quote.quoteOut > remaining) {
      warnings.push(warn('near-threshold', 'this sell takes the curve close to its graduation threshold', 'info'))
    }
  }

  return createPlan({
    kind: 'sell',
    route: 'curve',
    to: launch.curve,
    data: encodeFunctionData({
      abi: v2CurveAbi,
      functionName: 'sell',
      args: [options.tokensIn, minQuoteOut, options.recipient],
    }),
    value: 0n,
    gasLimit: undefined,
    summary: `sell ${formatToken(options.tokensIn, launch.metadata.decimals, launch.metadata.symbol)} for ${formatToken(quote.quoteOut, launch.quote.decimals, launch.quote.symbol)}`,
    warnings,
    economics: {
      tokensIn: options.tokensIn.toString(),
      gross: quote.gross.toString(),
      quoteOut: quote.quoteOut.toString(),
      minQuoteOut: minQuoteOut.toString(),
      curveFee: quote.curveFee.toString(),
      creatorTax: quote.creatorTax.toString(),
      priceImpactBps: impact.toString(),
      slippageBps: options.slippageBps.toString(),
    },
  })
}

/**
 * Approve a spender to move an ERC-20.
 *
 * The amount is exact rather than unlimited. An unlimited approval to a curve
 * outlives the trade it was granted for, and this CLI has no reason to leave
 * one behind — the extra transaction on the next sell is a fair price for not
 * carrying a standing authorisation.
 */
export function buildApprovePlan(token: Address, spender: Address, amount: bigint, symbol = 'tokens'): Plan {
  return createPlan({
    kind: 'approve',
    route: 'erc20',
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
    }),
    value: 0n,
    gasLimit: undefined,
    summary: `approve ${spender} to move ${amount === maxUint256 ? 'any amount of' : amount.toString()} ${symbol}`,
    warnings:
      amount === maxUint256
        ? [warn('unlimited-approval', 'this approval has no upper bound and does not expire', 'warn')]
        : [],
    economics: { spender, amount: amount.toString() },
  })
}

/** Current allowance, for deciding whether an approval is needed at all. */
export async function readAllowance(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })
}

export type GraduationPhaseChoice = 'sweep' | 'pool'

/**
 * Graduation is two permissionless calls on the factory.
 *
 * `graduate()` drains the curve into the factory and `createGraduatedPool()`
 * spends what it drained on a V4 position. Either can be made by anyone, which
 * is why they are here at all: a user holding a token that has stopped trading
 * does not have to wait for the creator.
 */
export function buildGraduatePlan(token: Address, phase: GraduationPhaseChoice, symbol: string): Plan {
  const factory = addresses.v2Factory as Address
  const sweep = phase === 'sweep'
  return createPlan({
    kind: sweep ? 'graduate' : 'create-pool',
    route: 'factory',
    to: factory,
    data: encodeFunctionData({
      abi: v2FactoryAbi,
      functionName: sweep ? 'graduate' : 'createGraduatedPool',
      args: [token],
    }),
    value: 0n,
    gasLimit: undefined,
    summary: sweep
      ? `drain the ${symbol} curve into the factory`
      : `create the ${symbol} Uniswap V4 pool from what was drained`,
    warnings: [],
    economics: { token, phase },
  })
}

/** Claim accrued fees from the escrow. Native or a specific quote token. */
export function buildClaimPlan(token: Address | undefined, symbol: string): Plan {
  const escrow = addresses.feeEscrow as Address
  return createPlan({
    kind: 'claim',
    route: 'escrow',
    to: escrow,
    data:
      token === undefined
        ? encodeFunctionData({ abi: feeEscrowAbi, functionName: 'claim' })
        : encodeFunctionData({ abi: feeEscrowAbi, functionName: 'claimToken', args: [token] }),
    value: 0n,
    gasLimit: undefined,
    summary: `claim every ${symbol} fee owed to this address`,
    warnings: [],
    economics: token === undefined ? { asset: 'native' } : { asset: token },
  })
}

/**
 * Release vested buyback supply. Permissionless, and paid to the recorded
 * recipients rather than to whoever calls it.
 */
export function buildVaultReleasePlan(token: Address, symbol: string): Plan {
  return createPlan({
    kind: 'vault-release',
    route: 'vault',
    to: addresses.buybackVault,
    data: encodeFunctionData({ abi: buybackVaultAbi, functionName: 'release', args: [token] }),
    value: 0n,
    gasLimit: undefined,
    summary: `release the vested ${symbol} the vault holds`,
    warnings: [
      warn(
        'not-yours',
        "the release is split between the creator and the protocol on the launch's recorded shares — calling it pays them, not you",
        'info',
      ),
    ],
    economics: { token },
  })
}

/** Basis points from a percentage-or-bps string, for `--slippage`. */
export function parseSlippageBps(raw: string): bigint {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new PonsError('USAGE', `slippage must be a number of basis points, got ${raw}`, {
      exitCode: ExitCode.Usage,
    })
  }
  const bps = BigInt(Math.round(value))
  if (bps >= BASIS_POINTS) {
    throw new PonsError('USAGE', 'a slippage tolerance of 100% accepts any price', {
      exitCode: ExitCode.Usage,
      hint: '100 basis points is 1%',
    })
  }
  return bps
}
