import { erc20Abi, type Address } from 'viem'

import { addresses } from '../chain/addresses.js'
import type { CommandContext } from '../context.js'
import { parseAmountSpec, resolveAmount } from '../core/amount.js'
import { readV1Launch, type V1Launch } from '../core/adapters/v1.js'
import { buildV1BuyPlan, buildV1SellPlan } from '../core/adapters/v1trade.js'
import { buildApprovePlan, readAllowance } from '../core/adapters/v2trade.js'
import type { Plan } from '../core/plan.js'
import { ExitCode, PonsError, UsageError } from '../errors.js'
import { runPlan, type WriteFlags } from './execute.js'

/**
 * `pons buy` and `pons sell` for a V1 launch.
 *
 * The same shape as the V2 path — quote, build a Plan, hand it to the shared
 * runner — with two differences that come from the venue rather than from the
 * generation. The price has to be asked of `QuoterV2` rather than computed, and
 * a sell needs an approval to the router, which a native V2 buy never does.
 */

export interface V1TradeRequest {
  context: CommandContext
  token: Address
  account: Address
  recipient: Address
  rawAmount: string
  slippageBps: bigint
  flags: WriteFlags
}

/**
 * Refuse a venue this token does not trade on.
 *
 * `--route` exists to override an answer, and for V1 there is only one answer:
 * a single Uniswap V3 pool named by the launch record. Silently ignoring
 * `--route v4` on a V1 token would send a trade somewhere the user did not ask
 * for.
 */
export function assertV1Route(route: string | undefined, symbol: string): void {
  if (route === undefined || route === 'auto' || route === 'v3') return
  throw new UsageError(`${symbol} is a V1 launch; it trades on Uniswap V3, not ${route}`, {
    hint: 'drop --route, or pass --route v3',
  })
}

export async function buyV1(request: V1TradeRequest): Promise<void> {
  const { context, token, account, recipient, flags } = request
  const { client } = context.rpc()
  const launch = await readV1Launch(client, token)

  assertLiquid(launch)
  // Priced in the pair asset, which is WETH — and WETH is 18 decimals like
  // ETH, so the amount a user types is the amount that leaves their wallet.
  const amountIn = parseAmountSpec(request.rawAmount, 18, 'amount').value
  if (amountIn <= 0n) throw new UsageError('a buy needs an absolute amount, not a percentage')

  const build = async (minOut?: bigint): Promise<Plan> =>
    buildV1BuyPlan(client, launch, {
      amountIn,
      slippageBps: request.slippageBps,
      recipient,
      ...(minOut === undefined ? {} : { minOut }),
    })

  await runPlan({
    context,
    plan: await build(),
    flags,
    account,
    track: token,
    rebuild: async (accepted) => build(floorOf(accepted)),
    recheck: (fresh, original) => floorCheck(fresh, original),
  })
}

export async function sellV1(request: V1TradeRequest): Promise<void> {
  const { context, token, account, recipient, flags } = request
  const { client } = context.rpc()
  const launch = await readV1Launch(client, token)

  assertLiquid(launch)
  const spec = parseAmountSpec(request.rawAmount, launch.metadata.decimals, 'amount')
  const balance =
    spec.kind === 'absolute'
      ? 0n
      : await client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account],
        })
  const tokensIn = resolveAmount(spec, balance)
  if (tokensIn <= 0n) {
    throw new PonsError('NOTHING_TO_SELL', `${account} holds no ${launch.metadata.symbol}`, {
      exitCode: ExitCode.Usage,
      details: { token, account },
    })
  }

  // The router moves the tokens with `transferFrom`. Without the approval the
  // swap reverts with Uniswap's `STF`, which says nothing about what to do.
  const prerequisites: Plan[] = []
  const allowance = await readAllowance(client, token, account, addresses.v3SwapRouter)
  if (allowance < tokensIn) {
    prerequisites.push(
      buildApprovePlan(token, addresses.v3SwapRouter, tokensIn, launch.metadata.symbol),
    )
  }

  const build = async (minOut?: bigint): Promise<Plan> =>
    buildV1SellPlan(client, launch, {
      tokensIn,
      slippageBps: request.slippageBps,
      recipient,
      ...(minOut === undefined ? {} : { minOut }),
    })

  await runPlan({
    context,
    plan: await build(),
    flags,
    account,
    prerequisites,
    rebuild: async (accepted) => build(floorOf(accepted)),
    recheck: (fresh, original) => floorCheck(fresh, original),
  })
}

/**
 * Refuse to trade a pool with nothing in it.
 *
 * Two of forty sampled V1 pools had been drained to zero liquidity. A swap
 * against one of those reverts inside the pool with no useful reason, and the
 * quote beforehand fails too — so the check belongs here, where it can name
 * what is wrong.
 */
function assertLiquid(launch: V1Launch): void {
  if (launch.poolState.liquidity > 0n) return
  throw new PonsError('NO_LIQUIDITY', `the ${launch.metadata.symbol} pool holds no liquidity`, {
    exitCode: ExitCode.Revert,
    details: { token: launch.token, pool: launch.pool },
    hint: 'nothing can be bought or sold here until somebody adds liquidity',
  })
}

/**
 * The floor the user accepted, carried into the rebuild so the trade cannot be
 * signed under it. Both V1 plans name it `amountOutMinimum`.
 */
function floorOf(accepted: Plan): bigint | undefined {
  const value = accepted.economics['amountOutMinimum']
  return value === undefined ? undefined : BigInt(value)
}

/**
 * Hold a rebuilt plan to the floor the user accepted.
 *
 * Same rule as the V2 path: the plan is rebuilt from live state immediately
 * before broadcasting, but the floor is not recomputed. The rebuild only
 * decides whether the trade still clears the price already agreed to.
 */
function floorCheck(fresh: Plan, original: Plan): PonsError | undefined {
  const quoted = BigInt(fresh.economics['amountOut'] ?? '0')
  const floor = BigInt(original.economics['amountOutMinimum'] ?? '0')
  if (quoted >= floor) return undefined
  return new PonsError('PRICE_MOVED', 'the pool moved below the price you accepted', {
    exitCode: ExitCode.Revert,
    details: { quoted: quoted.toString(), floor: floor.toString() },
    hint: 'run it again to price it afresh, or raise --slippage',
  })
}
