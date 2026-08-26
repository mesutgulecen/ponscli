import { encodeFunctionData, type Address, type PublicClient } from 'viem'

import { v1LockerAbi } from '../../abi/index.js'
import { addresses } from '../../chain/addresses.js'
import { formatBps, formatToken } from '../../output/format.js'
import { createPlan, warn, type Plan, type PlanWarning } from '../plan.js'
import { BASIS_POINTS, floorAtLeast, withSlippage } from '../quote.js'
import { encodeV3Buy, encodeV3Sell, quoteV3ExactIn, type V3Route } from '../routes/v3.js'
import type { V1Launch } from './v1.js'

/**
 * Turning an intent into a Plan, on Uniswap V3.
 *
 * Unlike the V2 curve, the price is not computable locally: a V3 pool's answer
 * depends on which ticks the swap crosses, and reproducing that off chain is a
 * reimplementation of the pool. So every V1 quote is a `QuoterV2` call, and the
 * plan is built around whatever it says.
 */

export function routeOf(launch: V1Launch): V3Route {
  return { token: launch.token, pairToken: launch.pairToken, fee: launch.poolFee }
}

/** How long a V3 swap stays valid, in seconds past the current block. */
const DEADLINE_SECONDS = 600n

async function deadlineFor(client: PublicClient): Promise<bigint> {
  const block = await client.getBlock({ blockTag: 'latest' })
  return block.timestamp + DEADLINE_SECONDS
}

/**
 * Warn about a pool whose price the trade moves a long way.
 *
 * Derived from the quote rather than from reserves: V3 has no single reserve
 * pair to compare against, so the honest measure is how far the quoted average
 * price sits from the pool's own spot price after the swap.
 */
function impactWarnings(label: string, quotedOut: bigint, referenceOut: bigint): PlanWarning[] {
  if (referenceOut === 0n || quotedOut >= referenceOut) return []
  const shortfallBps = ((referenceOut - quotedOut) * BASIS_POINTS) / referenceOut
  if (shortfallBps < 500n) return []
  return [
    warn(
      'price-impact',
      `${label} — this trade prices ${formatBps(shortfallBps)} worse than the pool's current spot`,
      shortfallBps >= 2_000n ? 'danger' : 'warn',
    ),
  ]
}

export interface V1BuyOptions {
  amountIn: bigint
  slippageBps: bigint
  recipient: Address
  /**
   * A floor the trade must clear regardless of what slippage computes.
   *
   * Set when a plan is rebuilt before broadcasting, to the floor the user
   * already accepted.
   */
  minOut?: bigint
}

/**
 * Buy a V1 token with native ETH.
 *
 * The value goes to the router, which wraps it. Nothing needs approving: the
 * seller of ETH is the transaction itself.
 */
export async function buildV1BuyPlan(
  client: PublicClient,
  launch: V1Launch,
  options: V1BuyOptions,
): Promise<Plan> {
  const route = routeOf(launch)
  const quote = await quoteV3ExactIn(client, route, 'buy', options.amountIn)
  const amountOutMinimum = floorAtLeast(
    withSlippage(quote.amountOut, options.slippageBps),
    options.minOut,
  )
  const deadline = await deadlineFor(client)

  // A tiny reference trade prices the pool without moving it, which is what
  // the real trade is compared against.
  const reference = await quoteV3ExactIn(client, route, 'buy', options.amountIn / 1_000n || 1n)
  const referenceOut = (reference.amountOut * options.amountIn) / (options.amountIn / 1_000n || 1n)

  const warnings = impactWarnings('the pool is thin', quote.amountOut, referenceOut)
  if (launch.restrictions.active) {
    warnings.push(
      warn(
        'launch-restrictions',
        `this launch is still inside its restricted window: at most ${formatToken(launch.restrictions.maxTx, launch.metadata.decimals, launch.metadata.symbol)} per buy and ${formatToken(launch.restrictions.maxWallet, launch.metadata.decimals, launch.metadata.symbol)} per wallet until block ${launch.restrictions.endBlock.toString()}`,
        'warn',
      ),
    )
  }

  return createPlan({
    kind: 'buy',
    route: 'v3',
    to: addresses.v3SwapRouter,
    data: encodeV3Buy({
      ...route,
      amountIn: options.amountIn,
      amountOutMinimum,
      recipient: options.recipient,
      deadline,
    }),
    // The router wraps this into WETH on the way through; the pool never sees
    // native ETH.
    value: options.amountIn,
    gasLimit: undefined,
    summary: `buy ${formatToken(quote.amountOut, launch.metadata.decimals, launch.metadata.symbol)} for ${formatToken(options.amountIn, 18, 'ETH')}`,
    warnings,
    economics: {
      amountIn: options.amountIn.toString(),
      amountOut: quote.amountOut.toString(),
      amountOutMinimum: amountOutMinimum.toString(),
      slippageBps: options.slippageBps.toString(),
      poolFee: launch.poolFee.toString(),
      deadline: deadline.toString(),
    },
  })
}

export interface V1SellOptions {
  tokensIn: bigint
  slippageBps: bigint
  recipient: Address
  /** A floor the trade must clear. See `V1BuyOptions.minOut`. */
  minOut?: bigint
}

/**
 * Sell a V1 token for native ETH.
 *
 * Two calls inside one `multicall`: the swap leaves WETH at the router, and
 * `unwrapWETH9` turns it into ETH for the seller. Encoding the swap to pay the
 * seller directly works and hands them WETH instead.
 */
export async function buildV1SellPlan(
  client: PublicClient,
  launch: V1Launch,
  options: V1SellOptions,
): Promise<Plan> {
  const route = routeOf(launch)
  const quote = await quoteV3ExactIn(client, route, 'sell', options.tokensIn)
  const amountOutMinimum = floorAtLeast(
    withSlippage(quote.amountOut, options.slippageBps),
    options.minOut,
  )
  const deadline = await deadlineFor(client)

  const probe = options.tokensIn / 1_000n || 1n
  const reference = await quoteV3ExactIn(client, route, 'sell', probe)
  const referenceOut = (reference.amountOut * options.tokensIn) / probe

  return createPlan({
    kind: 'sell',
    route: 'v3',
    to: addresses.v3SwapRouter,
    data: encodeV3Sell({
      ...route,
      amountIn: options.tokensIn,
      amountOutMinimum,
      recipient: options.recipient,
      deadline,
    }),
    value: 0n,
    gasLimit: undefined,
    summary: `sell ${formatToken(options.tokensIn, launch.metadata.decimals, launch.metadata.symbol)} for ${formatToken(quote.amountOut, 18, 'ETH')}`,
    warnings: impactWarnings('the pool is thin', quote.amountOut, referenceOut),
    economics: {
      tokensIn: options.tokensIn.toString(),
      amountOut: quote.amountOut.toString(),
      amountOutMinimum: amountOutMinimum.toString(),
      slippageBps: options.slippageBps.toString(),
      poolFee: launch.poolFee.toString(),
      deadline: deadline.toString(),
    },
  })
}

/**
 * Collect a V1 launch's accrued Uniswap V3 position fees.
 *
 * The locker holds the position, so nobody can withdraw the liquidity — but
 * the fees it has earned are claimable, and the locker splits them between the
 * launch's fee recipient and the protocol. **Not permissionless**, unlike V2's
 * graduation: only the owner, the deployer, the redirect recipient, or a
 * whitelisted collector may call it.
 */
export function buildV1CollectPlan(launch: V1Launch): Plan {
  return createPlan({
    kind: 'claim',
    route: 'vault',
    to: addresses.v1Locker,
    data: encodeFunctionData({ abi: v1LockerAbi, functionName: 'collectFees', args: [launch.token] }),
    value: 0n,
    gasLimit: undefined,
    summary: `collect the ${launch.metadata.symbol} position's accrued fees`,
    warnings: [
      warn(
        'paid-to-recipient',
        `the fees go to ${launch.feeRecipient}, less ${launch.protocolFeeSharePercent.toString()}% to the protocol — not to whoever calls this`,
        'info',
      ),
    ],
    economics: {
      token: launch.token,
      recipient: launch.feeRecipient,
      protocolFeeSharePercent: launch.protocolFeeSharePercent.toString(),
    },
  })
}
