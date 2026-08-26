import { encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex, type PublicClient } from 'viem'

import { permit2Abi } from '../../abi/index.js'
import { NATIVE_PAIR_TOKEN, addresses } from '../../chain/addresses.js'
import { robinhoodChain } from '../../chain/definition.js'
import { ExitCode, PonsError } from '../../errors.js'
import { formatBps, formatToken } from '../../output/format.js'
import type { V2Launch } from '../adapters/v2.js'
import { createPlan, warn, type Plan, type PlanWarning } from '../plan.js'
import { floorAtLeast, withSlippage } from '../quote.js'
import {
  encodeV4Buy,
  encodeV4Sell,
  quoteV4ExactIn,
  readPoolState,
  sortedPoolKey,
  type PermitSingle,
  type V4PoolKey,
} from './v4.js'

/**
 * Trading a graduated launch on its Uniswap V4 pool.
 *
 * About 1.2% of launches ever get here, 18 graduations against 1,472 launches
 * in a 400k-block window, but the path is not optional: without it a holder
 * whose token graduated cannot sell at all.
 */

/** How long a built plan stays valid on chain. */
const DEADLINE_SECONDS = 300n

/** Permit2 authorisations are short-lived here: one trade, not a standing grant. */
const PERMIT_EXPIRY_SECONDS = 1_800n

/**
 * Reconstruct the pool the factory created for a launch.
 *
 * The factory does not store the pool id; it rebuilds the key from the launch
 * record every time it needs one, and so do we. Every field comes from that
 * record except the hook, which is the factory's own immutable `memeHook`.
 */
export function poolKeyForLaunch(launch: V2Launch, poolFee: number, tickSpacing: number): V4PoolKey {
  return sortedPoolKey(
    launch.token,
    launch.quote.address,
    poolFee,
    tickSpacing,
    addresses.memeHook,
  )
}

export interface V4TradeContext {
  key: V4PoolKey
  /** True when the pool is keyed on the native asset rather than an ERC-20. */
  native: boolean
  liquidity: bigint
}

export async function readV4Context(
  client: PublicClient,
  launch: V2Launch,
  poolFee: number,
  tickSpacing: number,
): Promise<V4TradeContext> {
  const key = poolKeyForLaunch(launch, poolFee, tickSpacing)
  const state = await readPoolState(client, key)
  if (state.liquidity === 0n) {
    throw new PonsError('NO_POOL_LIQUIDITY', `the ${launch.metadata.symbol} V4 pool holds no liquidity`, {
      exitCode: ExitCode.Revert,
      details: { token: launch.token },
      hint:
        launch.phase === 'Swept'
          ? `the pool has not been created yet: 'pons graduate ${launch.token} --phase pool'`
          : 'the pool exists but has no position to trade against',
    })
  }
  return { key, native: key.currency0 === NATIVE_PAIR_TOKEN, liquidity: state.liquidity }
}

function assertNative(context: V4TradeContext, launch: V2Launch): void {
  if (!context.native) {
    throw new PonsError('V4_ERC20_QUOTE_UNSUPPORTED', `${launch.metadata.symbol} is quoted in an ERC-20 on V4`, {
      exitCode: ExitCode.Usage,
      details: { quote: launch.quote.address },
      hint: 'this release routes native-quoted V4 pools only; the ERC-20 path needs a WRAP/UNWRAP envelope',
    })
  }
}

function deadlineFrom(now: bigint): bigint {
  return now + DEADLINE_SECONDS
}

export interface V4BuyOptions {
  amountIn: bigint
  slippageBps: bigint
  account: Address
  now: bigint
  /**
   * A floor the trade must clear regardless of what slippage computes.
   *
   * Set when a plan is rebuilt before broadcasting, to the floor the user
   * already accepted.
   */
  minOut?: bigint
}

/**
 * A V4 buy: native in, token out, one `V4_SWAP`.
 *
 * The floor comes from `V4Quoter` rather than from reserve arithmetic of our
 * own, because the pool is hooked and the hook can move the effective fee, so any
 * number we computed locally would be a guess presented as a bound.
 */
export async function buildV4BuyPlan(
  client: PublicClient,
  launch: V2Launch,
  context: V4TradeContext,
  options: V4BuyOptions,
): Promise<Plan> {
  assertNative(context, launch)
  const zeroForOne = context.key.currency0 === NATIVE_PAIR_TOKEN
  const quote = await quoteV4ExactIn(client, context.key, zeroForOne, options.amountIn, options.account)
  const minOut = floorAtLeast(withSlippage(quote.amountOut, options.slippageBps), options.minOut)
  const call = encodeV4Buy({
    key: context.key,
    token: launch.token,
    amountIn: options.amountIn,
    amountOutMinimum: minOut,
    deadline: deadlineFrom(options.now),
  })

  return createPlan({
    kind: 'buy',
    route: 'v4',
    to: call.to,
    data: call.data,
    value: call.value,
    gasLimit: undefined,
    summary: `buy ${formatToken(quote.amountOut, launch.metadata.decimals, launch.metadata.symbol)} for ${formatToken(options.amountIn, launch.quote.decimals, launch.quote.symbol)} on the V4 pool`,
    warnings: [
      warn(
        'hook-fee',
        `the pool's hook takes ${formatBps(launch.fees.hookFeeBps)} on top of the swap; the quote already reflects it`,
        'info',
      ),
    ],
    economics: {
      amountIn: options.amountIn.toString(),
      amountOut: quote.amountOut.toString(),
      minAmountOut: minOut.toString(),
      slippageBps: options.slippageBps.toString(),
      poolLiquidity: context.liquidity.toString(),
    },
  })
}

/** Permit2's record of what a spender may move, and the next nonce to use. */
export interface Permit2Allowance {
  amount: bigint
  expiration: number
  nonce: number
}

export async function readPermit2Allowance(
  client: PublicClient,
  owner: Address,
  token: Address,
  spender: Address,
): Promise<Permit2Allowance> {
  const [amount, expiration, nonce] = await client.readContract({
    address: addresses.permit2,
    abi: permit2Abi,
    functionName: 'allowance',
    args: [owner, token, spender],
  })
  return { amount, expiration, nonce }
}

/**
 * The ERC-20 approval Permit2 itself needs.
 *
 * Two authorisations stand between a holder and a V4 sell: the token must let
 * Permit2 move it, and Permit2 must let the router move it. The first is an
 * ordinary `approve` and is what this builds; the second is the signature.
 */
export function buildPermit2ApprovalPlan(token: Address, symbol: string): Plan {
  return createPlan({
    kind: 'approve',
    route: 'erc20',
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [addresses.permit2 as Address, maxUint256],
    }),
    value: 0n,
    gasLimit: undefined,
    summary: `approve Permit2 to move ${symbol}`,
    warnings: [
      warn(
        'permit2-approval',
        'Permit2 requires an unbounded ERC-20 approval; each trade is then authorised separately by a signature',
        'warn',
      ),
    ],
    economics: { spender: addresses.permit2, amount: 'unlimited' },
  })
}

/**
 * EIP-712 typed data for a Permit2 `PermitSingle`.
 *
 * The domain carries no version field: Permit2's own `EIP712` base hashes
 * `(name, chainId, verifyingContract)` only, and adding one would produce a
 * signature the contract cannot verify.
 */
export function permitTypedData(permit: PermitSingle): {
  domain: { name: string; chainId: number; verifyingContract: Address }
  types: Record<string, { name: string; type: string }[]>
  primaryType: 'PermitSingle'
  message: Record<string, unknown>
} {
  return {
    domain: {
      name: 'Permit2',
      chainId: robinhoodChain.id,
      verifyingContract: addresses.permit2,
    },
    types: {
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
    },
    primaryType: 'PermitSingle',
    message: permit as unknown as Record<string, unknown>,
  }
}

export function permitFor(token: Address, amount: bigint, nonce: number, now: bigint): PermitSingle {
  return {
    details: {
      token,
      amount,
      expiration: Number(now + PERMIT_EXPIRY_SECONDS),
      nonce,
    },
    spender: addresses.universalRouter,
    sigDeadline: now + PERMIT_EXPIRY_SECONDS,
  }
}

export interface V4SellOptions {
  tokensIn: bigint
  slippageBps: bigint
  account: Address
  now: bigint
  permit: PermitSingle
  signature: Hex
  /** A floor the trade must clear. See `V4BuyOptions.minOut`. */
  minOut?: bigint
}

/**
 * A V4 sell: token in through Permit2, native ETH out.
 *
 * This is the one operation in the CLI that cannot be produced unsigned. The
 * router pulls the token through Permit2, Permit2 needs a signature over the
 * authorisation, and only the holder can make it, so `--unsigned` has nothing
 * to hand somebody else.
 */
export async function buildV4SellPlan(
  client: PublicClient,
  launch: V2Launch,
  context: V4TradeContext,
  options: V4SellOptions,
): Promise<Plan> {
  assertNative(context, launch)
  const zeroForOne = context.key.currency0 === launch.token.toLowerCase()
  const quote = await quoteV4ExactIn(client, context.key, zeroForOne, options.tokensIn, options.account)
  const minOut = floorAtLeast(withSlippage(quote.amountOut, options.slippageBps), options.minOut)
  const call = encodeV4Sell({
    key: context.key,
    token: launch.token,
    amountIn: options.tokensIn,
    amountOutMinimum: minOut,
    deadline: deadlineFrom(options.now),
    permit: options.permit,
    signature: options.signature,
  })

  const warnings: PlanWarning[] = [
    warn(
      'permit2-signature',
      'this transaction carries a Permit2 signature valid for 30 minutes and for this amount only',
      'info',
    ),
  ]

  return createPlan({
    kind: 'sell',
    route: 'v4',
    to: call.to,
    data: call.data,
    value: 0n,
    gasLimit: undefined,
    summary: `sell ${formatToken(options.tokensIn, launch.metadata.decimals, launch.metadata.symbol)} for ${formatToken(quote.amountOut, launch.quote.decimals, launch.quote.symbol)} on the V4 pool`,
    warnings,
    economics: {
      tokensIn: options.tokensIn.toString(),
      amountOut: quote.amountOut.toString(),
      minAmountOut: minOut.toString(),
      slippageBps: options.slippageBps.toString(),
      poolLiquidity: context.liquidity.toString(),
    },
  })
}
