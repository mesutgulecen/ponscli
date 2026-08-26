import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem'

import { v3PoolAbi, v3QuoterAbi, v3SwapRouterAbi } from '../../abi/index.js'
import { addresses } from '../../chain/addresses.js'

/**
 * Uniswap V3, the venue every Pons V1 launch trades on.
 *
 * There is nothing to route here either: the launch record names the pool's
 * two tokens and its fee tier, so the swap is a single `exactInputSingle`
 * against one known pool. What this module owns is the encoding — and V3's
 * encoding has one trap, the native asset.
 *
 * **A V1 launch is paired against WETH, not native ETH.** `getLaunchConfig(0)`
 * gives `pairToken = 0x0Bd7…AD73`, which is WETH, and the pool holds WETH on
 * one side. A buyer holding ETH and a seller wanting ETH both need a wrap or
 * an unwrap, and SwapRouter02 does each of them differently:
 *
 * - **Buying**, the router wraps for you. `pay()` deposits into WETH9 when the
 *   token being paid is WETH9 and the call carries enough value, so a buy is
 *   `exactInputSingle` with `tokenIn = WETH` and `msg.value = amountIn`. This
 *   is exactly what the V1 factory's own atomic opening buy does.
 * - **Selling**, it does not. The swap's output has to be left *at the router*
 *   and then unwrapped in a second call, which is why a sell is two calls
 *   inside one `multicall`.
 *
 * A sell encoded the obvious way — output straight to the seller — succeeds
 * and hands them WETH.
 */

/**
 * SwapRouter02's recipient sentinels, from its own `Constants` library.
 *
 * `address(1)` resolves to `msg.sender` and `address(2)` to the router itself.
 * The second is what makes the unwrap possible: the swap has to deposit its
 * output where the router can still reach it.
 */
export const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001'
export const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002'

/** Everything a V3 swap needs that is not the amount. */
export interface V3Route {
  /** The launch token. */
  token: Address
  /** The other side of the pool. WETH for every V1 launch config today. */
  pairToken: Address
  fee: number
}

export interface SwapParams extends V3Route {
  amountIn: bigint
  amountOutMinimum: bigint
  recipient: Address
  /** Unix seconds. The router reverts past it. */
  deadline: bigint
}

function exactInputSingle(
  tokenIn: Address,
  tokenOut: Address,
  fee: number,
  recipient: Address,
  amountIn: bigint,
  amountOutMinimum: bigint,
): Hex {
  return encodeFunctionData({
    abi: v3SwapRouterAbi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn,
        tokenOut,
        fee,
        recipient,
        amountIn,
        amountOutMinimum,
        // No price bound. The slippage floor is the bound that matters, and a
        // sqrt-price limit expressed alongside it is a second, redundant one
        // that silently converts a bad price into a partial fill.
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
}

/**
 * Buy a V1 token with native ETH.
 *
 * Wrapped in `multicall(deadline, calls)` purely for the deadline: the
 * original SwapRouter carried one inside its parameters and SwapRouter02 moved
 * it out to the multicall wrapper, so this is where a V3 swap's expiry lives
 * now. `multicall` is payable and delegatecalls, so `msg.value` reaches the
 * swap unchanged.
 */
export function encodeV3Buy(params: SwapParams): Hex {
  return encodeFunctionData({
    abi: v3SwapRouterAbi,
    functionName: 'multicall',
    args: [
      params.deadline,
      [
        exactInputSingle(
          params.pairToken,
          params.token,
          params.fee,
          params.recipient,
          params.amountIn,
          params.amountOutMinimum,
        ),
      ],
    ],
  })
}

/**
 * Sell a V1 token for native ETH.
 *
 * Two calls: swap the token for WETH into the router's own balance, then
 * unwrap that balance to the seller. `unwrapWETH9` carries the same floor as
 * the swap, so a router drained by anything unexpected fails the second leg
 * rather than paying out less than was quoted.
 */
export function encodeV3Sell(params: SwapParams): Hex {
  return encodeFunctionData({
    abi: v3SwapRouterAbi,
    functionName: 'multicall',
    args: [
      params.deadline,
      [
        exactInputSingle(
          params.token,
          params.pairToken,
          params.fee,
          ADDRESS_THIS,
          params.amountIn,
          params.amountOutMinimum,
        ),
        encodeFunctionData({
          abi: v3SwapRouterAbi,
          functionName: 'unwrapWETH9',
          args: [params.amountOutMinimum, params.recipient],
        }),
      ],
    ],
  })
}

export interface V3Quote {
  amountOut: bigint
  sqrtPriceX96After: bigint
  gasEstimate: bigint
}

/**
 * Price a swap through QuoterV2.
 *
 * `quoteExactInputSingle` is `nonpayable` in the ABI because it runs the swap
 * and reverts to return the answer, so it has to be simulated rather than
 * read. That is also why it is not worth batching: each quote is its own call.
 */
export async function quoteV3ExactIn(
  client: PublicClient,
  route: V3Route,
  direction: 'buy' | 'sell',
  amountIn: bigint,
): Promise<V3Quote> {
  const [tokenIn, tokenOut] =
    direction === 'buy' ? [route.pairToken, route.token] : [route.token, route.pairToken]
  const { result } = await client.simulateContract({
    address: addresses.v3Quoter,
    abi: v3QuoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee: route.fee, sqrtPriceLimitX96: 0n }],
  })
  return { amountOut: result[0], sqrtPriceX96After: result[1], gasEstimate: result[3] }
}

export interface V3PoolState {
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  token0: Address
  token1: Address
  fee: number
}

export async function readV3Pool(client: PublicClient, pool: Address): Promise<V3PoolState> {
  const [slot0, liquidity, token0, token1, fee] = await client.multicall({
    contracts: [
      { address: pool, abi: v3PoolAbi, functionName: 'slot0' },
      { address: pool, abi: v3PoolAbi, functionName: 'liquidity' },
      { address: pool, abi: v3PoolAbi, functionName: 'token0' },
      { address: pool, abi: v3PoolAbi, functionName: 'token1' },
      { address: pool, abi: v3PoolAbi, functionName: 'fee' },
    ],
    allowFailure: false,
  })
  return { sqrtPriceX96: slot0[0], tick: slot0[1], liquidity, token0, token1, fee }
}

const Q96 = 2n ** 96n

/**
 * The pool's spot price of one whole token, in the pair asset's base units.
 *
 * `sqrtPriceX96` prices token1 in token0, so which way round it has to be read
 * depends on where the launch token sorted. Squaring before dividing keeps the
 * whole thing in integers; `10n ** decimals` is what turns "per base unit" into
 * "per whole token", which is the only form worth showing anybody.
 */
export function spotPriceFrom(
  sqrtPriceX96: bigint,
  isToken0: boolean,
  tokenDecimals: number,
): bigint {
  if (sqrtPriceX96 === 0n) return 0n
  const one = 10n ** BigInt(tokenDecimals)
  return isToken0
    ? (sqrtPriceX96 * sqrtPriceX96 * one) / (Q96 * Q96)
    : (Q96 * Q96 * one) / (sqrtPriceX96 * sqrtPriceX96)
}
