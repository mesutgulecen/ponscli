import { erc20Abi, isAddress, isHash, type Address } from 'viem'
import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { addresses } from '../chain/addresses.js'
import { probeAll } from '../chain/probe.js'
import { detectGeneration } from '../core/adapters/detect.js'
import { marketCap as v1MarketCap, readV1Launch, spotPrice as v1SpotPrice } from '../core/adapters/v1.js'
import { buildV1BuyPlan, buildV1SellPlan } from '../core/adapters/v1trade.js'
import {
  graduationProgress,
  marketCap,
  readV2Launch,
  spotPrice,
  type V2Launch,
} from '../core/adapters/v2.js'
import { buildCurveBuyPlan, buildCurveSellPlan, readAllowance } from '../core/adapters/v2trade.js'
import { parseAmountSpec, resolveAmount } from '../core/amount.js'
import { readPairTokens } from '../core/pairs.js'
import type { Plan } from '../core/plan.js'
import { readTransaction } from '../core/receipt.js'
import { simulatePlan } from '../core/simulate.js'
import { UsageError } from '../errors.js'
import type { McpContext } from './context.js'

/**
 * The tools an agent gets.
 *
 * **Nothing here signs anything.** The server never loads a keystore, never
 * asks for a password and never broadcasts. It reads the chain and it builds
 * unsigned plans. That is not a limitation worked around; it is the boundary
 * that makes the server safe to leave running next to a model. An agent that
 * wants a transaction sent produces the plan here and a person sends it.
 *
 * Every tool answers with JSON in base units. There is no human rendering on
 * this side, because the consumer is a model that can do exact arithmetic on
 * integers and cannot on `1,234.56`.
 */

/** One tool result, as MCP wants it. */
function json(value: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          value,
          (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item),
          2,
        ),
      },
    ],
  }
}

function assertToken(raw: string): Address {
  if (!isAddress(raw, { strict: false })) throw new UsageError(`${raw} is not an address`)
  return raw
}

/**
 * An approval a plan depends on, described rather than encoded.
 *
 * Deliberately carries no calldata. The server reports that an approval is
 * needed and leaves building it to the CLI, which already owns exact-amount
 * approvals and the ordering around them, because handing an agent a second piece of
 * signable calldata for a step it did not ask about is how an approval ends up
 * sent on its own, to a spender nobody re-read.
 */
interface Prerequisite {
  kind: 'approve'
  token: Address
  spender: Address
  amount: string
  note: string
}

function approvalNeeded(token: Address, spender: Address, amount: bigint): Prerequisite {
  return {
    kind: 'approve',
    token,
    spender,
    amount: amount.toString(),
    note: `${spender} must be approved to move this amount first; 'pons sell' does both in order`,
  }
}

/** A plan, plus what simulating it against live state says. */
async function planResult(
  context: McpContext,
  plan: Plan,
  account: Address,
  prerequisites: Prerequisite[] = [],
): Promise<ReturnType<typeof json>> {
  const { client } = context.rpc()
  // Funded, because the question an agent is asking is whether the call works,
  // not whether this particular address happens to hold enough today.
  const simulation = await simulatePlan(client, plan, { from: account, fund: true })
  return json({
    plan: {
      id: plan.id,
      kind: plan.kind,
      route: plan.route,
      to: plan.to,
      data: plan.data,
      value: plan.value.toString(),
      summary: plan.summary,
      warnings: plan.warnings,
      economics: plan.economics,
    },
    prerequisites,
    simulation: {
      ok: simulation.ok,
      gasEstimate: simulation.gasEstimate?.toString() ?? null,
      gasLimit: simulation.gasLimit?.toString() ?? null,
      // A sell simulated before its approval has landed reverts on the
      // allowance. Reporting that as the plan's own fault sends the reader
      // looking for a fault that is about to fix itself.
      blockedByPrerequisite: !simulation.ok && prerequisites.length > 0,
      revert: simulation.revert ?? null,
      failure: simulation.failure ?? null,
    },
    signing: 'this server never signs; send it with `pons buy/sell --confirm`, or sign this calldata elsewhere',
  })
}

function v2Summary(launch: V2Launch): Record<string, unknown> {
  const onCurve = launch.phase === 'NotGraduated' && !launch.graduation.graduated
  const progress = graduationProgress(launch)
  return {
    generation: 'v2',
    token: launch.token,
    curve: launch.curve,
    name: launch.metadata.name,
    symbol: launch.metadata.symbol,
    decimals: launch.metadata.decimals,
    totalSupply: launch.metadata.totalSupply.toString(),
    phase: launch.phase,
    venue: onCurve ? 'bonding curve' : 'uniswap v4 pool',
    quote: launch.quote,
    // Null once the curve is drained: it holds nothing but its phantom reserve
    // afterwards, and would price the token at zero.
    price: onCurve ? spotPrice(launch).toString() : null,
    marketCap: onCurve ? marketCap(launch).toString() : null,
    graduation: {
      raised: progress.raised.toString(),
      threshold: progress.threshold.toString(),
      ready: launch.graduation.ready,
      graduated: launch.graduation.graduated,
    },
    snipeTaxBps: Number(launch.snipeTax.currentBps),
    fees: {
      curveFeeBps: Number(launch.fees.curveFeeBps),
      creatorTaxBps: Number(launch.fees.creatorTaxBps),
    },
    deployer: launch.deployer,
  }
}

export function registerTools(server: McpServer, context: McpContext): void {
  server.registerTool(
    'pons_info',
    {
      title: 'Read a Pons launch',
      description:
        'Price, reserves or pool state, graduation progress and fees for one token. Works out which factory launched it; V1 and V2 answer with different shapes, distinguished by the `generation` field.',
      inputSchema: { token: z.string().describe('Token contract address') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ token }) => {
      const address = assertToken(token)
      const { client } = context.rpc()
      const { generation } = await detectGeneration(client, address)
      if (generation === 'v1') {
        const launch = await readV1Launch(client, address)
        return json({
          generation: 'v1',
          token: launch.token,
          pool: launch.pool,
          name: launch.metadata.name,
          symbol: launch.metadata.symbol,
          decimals: launch.metadata.decimals,
          totalSupply: launch.metadata.totalSupply.toString(),
          venue: 'uniswap v3 pool',
          pair: launch.pair,
          price: v1SpotPrice(launch).toString(),
          marketCap: v1MarketCap(launch).toString(),
          poolFee: launch.poolFee,
          liquidity: launch.poolState.liquidity.toString(),
          graduation: {
            raised: launch.graduation.raised.toString(),
            threshold: launch.graduation.threshold.toString(),
            graduated: launch.graduation.graduated,
          },
          restrictionsActive: launch.restrictions.active,
          feeRecipient: launch.feeRecipient,
          deployer: launch.deployer,
          note: 'V1 is closed to new launches; existing tokens trade normally',
        })
      }
      return json(v2Summary(await readV2Launch(client, address)))
    },
  )

  server.registerTool(
    'pons_pairs',
    {
      title: 'Approved quote assets',
      description:
        'The assets a V2 launch may be priced against: native ETH plus the approved tokenised equities and one stablecoin. Read live from the factory, in approval order.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { client } = context.rpc()
      const pairs = await readPairTokens(client, { store: context.store })
      return json({
        count: pairs.length,
        pairs: pairs.map((pair) => ({
          symbol: pair.symbol,
          name: pair.name,
          address: pair.address,
          decimals: pair.decimals,
          native: pair.native,
          phantomQuote: pair.phantomQuote.toString(),
          graduationThreshold: pair.graduationThreshold.toString(),
        })),
      })
    },
  )

  server.registerTool(
    'pons_plan_buy',
    {
      title: 'Build an unsigned buy',
      description:
        'Price a buy on whichever venue the token trades and return unsigned calldata plus a simulation against live state. Signs nothing and sends nothing.',
      inputSchema: {
        token: z.string().describe('Token contract address'),
        amount: z.string().describe('Amount of the quote asset to spend, for example "0.05"'),
        account: z.string().describe('Address the buy is for'),
        slippageBps: z
          .number()
          .int()
          .min(0)
          .max(9_999)
          .optional()
          .describe('Slippage tolerance in basis points; 100 is 1%'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ token, amount, account, slippageBps }) => {
      const address = assertToken(token)
      const buyer = assertToken(account)
      const slippage = BigInt(slippageBps ?? context.config.values['trade.slippageBps'])
      const { client } = context.rpc()
      const { generation } = await detectGeneration(client, address)

      if (generation === 'v1') {
        const launch = await readV1Launch(client, address)
        // V1 pools hold WETH, which is 18 decimals like the ETH the buyer sends.
        const amountIn = parseAmountSpec(amount, 18, 'amount').value
        const plan = await buildV1BuyPlan(client, launch, {
          amountIn,
          slippageBps: slippage,
          recipient: buyer,
        })
        return planResult(context, plan, buyer)
      }

      const launch = await readV2Launch(client, address)
      const amountIn = parseAmountSpec(amount, launch.quote.decimals, 'amount').value
      const plan = buildCurveBuyPlan(launch, { amountIn, slippageBps: slippage, recipient: buyer })
      // A native buy sends value and needs no approval; an ERC-20-quoted one is
      // pulled with `transferFrom` and does.
      const prerequisites: Prerequisite[] = []
      if (!launch.quote.native) {
        const allowance = await readAllowance(client, launch.quote.address, buyer, launch.curve)
        if (allowance < amountIn) {
          prerequisites.push(approvalNeeded(launch.quote.address, launch.curve, amountIn))
        }
      }
      return planResult(context, plan, buyer, prerequisites)
    },
  )

  server.registerTool(
    'pons_plan_sell',
    {
      title: 'Build an unsigned sell',
      description:
        'Price a sell on whichever venue the token trades and return unsigned calldata plus a simulation, naming any approval that has to land first. Signs nothing and sends nothing.',
      inputSchema: {
        token: z.string().describe('Token contract address'),
        amount: z.string().describe('Token amount, a percentage such as "50%", or "all"'),
        account: z.string().describe('Address holding the tokens'),
        slippageBps: z
          .number()
          .int()
          .min(0)
          .max(9_999)
          .optional()
          .describe('Slippage tolerance in basis points; 100 is 1%'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ token, amount, account, slippageBps }) => {
      const address = assertToken(token)
      const seller = assertToken(account)
      const slippage = BigInt(slippageBps ?? context.config.values['trade.slippageBps'])
      const { client } = context.rpc()
      const { generation } = await detectGeneration(client, address)

      if (generation === 'v1') {
        const launch = await readV1Launch(client, address)
        const tokensIn = await resolveSellAmount(
          context,
          amount,
          launch.metadata.decimals,
          address,
          seller,
        )
        const plan = await buildV1SellPlan(client, launch, {
          tokensIn,
          slippageBps: slippage,
          recipient: seller,
        })
        const allowance = await readAllowance(client, address, seller, addresses.v3SwapRouter)
        return planResult(
          context,
          plan,
          seller,
          allowance < tokensIn ? [approvalNeeded(address, addresses.v3SwapRouter, tokensIn)] : [],
        )
      }

      const launch = await readV2Launch(client, address)
      const tokensIn = await resolveSellAmount(
        context,
        amount,
        launch.metadata.decimals,
        address,
        seller,
      )
      const plan = buildCurveSellPlan(launch, { tokensIn, slippageBps: slippage, recipient: seller })
      const allowance = await readAllowance(client, address, seller, launch.curve)
      return planResult(
        context,
        plan,
        seller,
        allowance < tokensIn ? [approvalNeeded(address, launch.curve, tokensIn)] : [],
      )
    },
  )

  server.registerTool(
    'pons_transaction',
    {
      title: 'Read a transaction',
      description:
        'Receipt, decoded logs, and the revert reason behind a failure, recovered by replaying the call, since a receipt carries no reason on any EVM chain.',
      inputSchema: { hash: z.string().describe('Transaction hash') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ hash }) => {
      if (!isHash(hash)) throw new UsageError(`${hash} is not a transaction hash`)
      const { client } = context.rpc()
      return json(await readTransaction(client, hash))
    },
  )

  server.registerTool(
    'pons_endpoints',
    {
      title: 'RPC endpoint health',
      description:
        'Probe every configured endpoint with the calls the CLI actually makes, meaning a contract read, a log query and a historical state read, rather than a liveness ping.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { pool, dispatch } = context.rpc()
      const reports = await probeAll(dispatch, pool.endpoints, { wait: false })
      return json({
        endpoints: reports.map((report) => ({
          label: report.label,
          url: report.url,
          tier: report.tier,
          // The one field worth branching on: an endpoint can answer every
          // probe and still be unusable for the reads this CLI depends on.
          usable: report.usable,
          parked: report.parked,
          meteredIntervalMs: report.meteredIntervalMs ?? null,
          probes: report.probes.map((probe) => ({
            name: probe.name,
            ok: probe.ok,
            detail: probe.detail ?? null,
            latencyMs: probe.latencyMs,
          })),
        })),
      })
    },
  )
}

/** `all`, `50%` or an absolute amount, resolved against the holder's balance. */
async function resolveSellAmount(
  context: McpContext,
  amount: string,
  decimals: number,
  token: Address,
  seller: Address,
): Promise<bigint> {
  const { client } = context.rpc()
  const spec = parseAmountSpec(amount, decimals, 'amount')
  // The balance is only fetched when the amount is relative to it.
  const balance =
    spec.kind === 'absolute'
      ? 0n
      : await client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [seller],
        })
  const tokensIn = resolveAmount(spec, balance)
  if (tokensIn <= 0n) throw new UsageError(`${seller} holds none of ${token}`)
  return tokensIn
}
