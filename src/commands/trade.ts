import { Command } from 'commander'
import { erc20Abi, isAddress, type Address } from 'viem'

import type { CommandContext } from '../context.js'
import { parseAmountSpec, resolveAmount } from '../core/amount.js'
import { readV2Launch, type V2Launch } from '../core/adapters/v2.js'
import {
  buildApprovePlan,
  buildCurveBuyPlan,
  buildCurveSellPlan,
  parseSlippageBps,
  readAllowance,
} from '../core/adapters/v2trade.js'
import { v2FactoryAbi } from '../abi/index.js'
import { addresses } from '../chain/addresses.js'
import type { Plan } from '../core/plan.js'
import {
  buildPermit2ApprovalPlan,
  buildV4BuyPlan,
  buildV4SellPlan,
  permitFor,
  permitTypedData,
  readPermit2Allowance,
  readV4Context,
} from '../core/routes/v4trade.js'
import { detectGeneration } from '../core/adapters/detect.js'
import { ExitCode, PonsError, UsageError } from '../errors.js'
import { assertV1Route, buyV1, sellV1 } from './tradeV1.js'
import { formatToken } from '../output/format.js'
import { readKeystoreFile } from '../wallet/keystore.js'
import { addWriteFlags, runPlan, unlockSigner, type WriteFlags } from './execute.js'

/**
 * `pons buy` and `pons sell`.
 *
 * Both are the same shape: read the launch, price the trade locally, build a
 * Plan, hand it to the shared runner. Neither signs anything on its own.
 */

interface TradeFlags extends WriteFlags {
  slippage?: string
  from?: string
  recipient?: string
  route?: string
}

/**
 * The address the trade is for.
 *
 * A keystore stores its address in cleartext, so read-only modes can name the
 * account without asking for a password, which is what makes `pons sell X all`
 * printable without unlocking anything.
 */
function resolveAccount(context: CommandContext, flags: TradeFlags): Address {
  if (flags.from !== undefined) {
    if (!isAddress(flags.from, { strict: false })) throw new UsageError(`--from ${flags.from} is not an address`)
    return flags.from
  }
  const path = context.config.values['wallet.keystore']
  try {
    return readKeystoreFile(path).address
  } catch (error) {
    throw new PonsError('NO_ACCOUNT', 'no account to trade for', {
      exitCode: ExitCode.Wallet,
      cause: error,
      hint: "pass --from <address>, or create a keystore with 'pons wallet create'",
    })
  }
}

function assertToken(raw: string): Address {
  if (!isAddress(raw, { strict: false })) {
    throw new UsageError(`${raw} is not an address`, { hint: 'pass the token contract address' })
  }
  return raw
}

function slippageOf(context: CommandContext, flags: TradeFlags): bigint {
  return flags.slippage === undefined
    ? BigInt(context.config.values['trade.slippageBps'])
    : parseSlippageBps(flags.slippage)
}

type Venue = 'curve' | 'v4'

/**
 * Which venue a token trades on.
 *
 * There is nothing to choose between: the launch record says whether the curve
 * is still trading, and once it has graduated the V4 pool is the only place
 * left. `--route` exists to override the answer, not to search for one.
 */
function resolveVenue(launch: V2Launch, flags: TradeFlags): Venue {
  const requested = flags.route ?? 'auto'
  if (requested !== 'auto' && requested !== 'curve' && requested !== 'v4') {
    throw new UsageError(`--route must be auto, curve or v4, got ${requested}`)
  }
  const onCurve = launch.phase === 'NotGraduated' && !launch.graduation.graduated
  if (requested === 'auto') return onCurve ? 'curve' : 'v4'
  if (requested === 'curve' && !onCurve) {
    throw new UsageError(`${launch.metadata.symbol} has graduated; its curve no longer trades`, {
      hint: 'drop --route, or pass --route v4',
    })
  }
  if (requested === 'v4' && onCurve) {
    throw new UsageError(`${launch.metadata.symbol} has not graduated; it has no V4 pool yet`, {
      hint: 'drop --route, or pass --route curve',
    })
  }
  return requested
}

export function createBuyCommand(getContext: () => CommandContext): Command {
  return addWriteFlags(
    new Command('buy')
      .description('Buy a token on whichever venue it trades: a V2 curve, a V4 pool, or a V1 V3 pool')
      .argument('<token>', 'Token address')
      .argument('<amount>', 'Amount of the quote asset to spend, for example 0.05')
      .option('--slippage <bps>', 'Slippage tolerance in basis points (100 = 1%)')
      .option('--from <address>', 'Account to trade for, when there is no keystore')
      .option('--recipient <address>', 'Who receives the tokens. Defaults to the buyer')
      .option('--route <venue>', 'auto (default), curve, v4 or v3'),
  ).action(async (rawToken: string, rawAmount: string, flags: TradeFlags) => {
    const context = getContext()
    const token = assertToken(rawToken)
    const account = resolveAccount(context, flags)
    const recipient =
      flags.recipient === undefined ? account : assertToken(flags.recipient)
    const { client } = context.rpc()

    const { generation } = await detectGeneration(client, token)
    if (generation === 'v1') {
      assertV1Route(flags.route, token)
      await buyV1({
        context,
        token,
        account,
        recipient,
        rawAmount,
        slippageBps: slippageOf(context, flags),
        flags,
      })
      return
    }

    const launch = await readV2Launch(client, token)
    const venue = resolveVenue(launch, flags)
    const amountIn = parseAmountSpec(rawAmount, launch.quote.decimals, 'amount').value
    if (amountIn <= 0n) throw new UsageError('a buy needs an absolute amount, not a percentage')
    const slippageBps = slippageOf(context, flags)

    if (venue === 'v4') {
      if (recipient !== account) {
        // The router's TAKE pays msg.sender through a sentinel address; there
        // is no field to redirect it to somebody else.
        throw new UsageError('--recipient is not available on the V4 route')
      }
      const record = await readLaunchRecord(client, token)
      const v4 = await readV4Context(client, launch, record.poolFee, record.tickSpacing)
      const now = (await client.getBlock({ blockTag: 'latest' })).timestamp
      const buildV4 = async (minOut?: bigint): Promise<Plan> =>
        buildV4BuyPlan(client, launch, v4, {
          amountIn,
          slippageBps,
          account,
          now,
          ...(minOut === undefined ? {} : { minOut }),
        })
      await runPlan({
        context,
        plan: await buildV4(),
        flags,
        account,
        track: token,
        rebuild: async (accepted) => buildV4(floorOf(accepted, 'minAmountOut')),
        recheck: (fresh, original) => floorCheck(fresh, original, 'amountOut', 'minAmountOut'),
      })
      return
    }

    const build = (state: V2Launch, minOut?: bigint): Plan =>
      buildCurveBuyPlan(state, {
        amountIn,
        slippageBps,
        recipient,
        ...(minOut === undefined ? {} : { minOut }),
      })
    const plan = build(launch)

    // An ERC-20-quoted launch pulls the quote asset through `transferFrom`, so
    // it needs an allowance first. A native launch sends value and needs none.
    const prerequisites: Plan[] = []
    if (!launch.quote.native) {
      const allowance = await readAllowance(client, launch.quote.address, account, launch.curve)
      if (allowance < amountIn) {
        prerequisites.push(
          buildApprovePlan(launch.quote.address, launch.curve, amountIn, launch.quote.symbol),
        )
      }
    }

    await runPlan({
      context,
      plan,
      flags,
      account,
      prerequisites,
      track: token,
      rebuild: async (accepted) =>
        build(await readV2Launch(client, token), floorOf(accepted, 'minTokensOut')),
      recheck: (fresh, original) => floorCheck(fresh, original, 'tokensOut', 'minTokensOut'),
    })
  })
}

export function createSellCommand(getContext: () => CommandContext): Command {
  return addWriteFlags(
    new Command('sell')
      .description('Sell a token on whichever venue it trades: a V2 curve, a V4 pool, or a V1 V3 pool')
      .argument('<token>', 'Token address')
      .argument('<amount>', "Token amount, a percentage such as 50%, or 'all'")
      .option('--slippage <bps>', 'Slippage tolerance in basis points (100 = 1%)')
      .option('--from <address>', 'Account to trade for, when there is no keystore')
      .option('--recipient <address>', 'Who receives the proceeds. Defaults to the seller')
      .option('--route <venue>', 'auto (default), curve, v4 or v3'),
  ).action(async (rawToken: string, rawAmount: string, flags: TradeFlags) => {
    const context = getContext()
    const token = assertToken(rawToken)
    const account = resolveAccount(context, flags)
    const recipient = flags.recipient === undefined ? account : assertToken(flags.recipient)
    const { client } = context.rpc()

    const { generation } = await detectGeneration(client, token)
    if (generation === 'v1') {
      assertV1Route(flags.route, token)
      await sellV1({
        context,
        token,
        account,
        recipient,
        rawAmount,
        slippageBps: slippageOf(context, flags),
        flags,
      })
      return
    }

    const launch = await readV2Launch(client, token)
    const venue = resolveVenue(launch, flags)
    const spec = parseAmountSpec(rawAmount, launch.metadata.decimals, 'amount')
    // The balance is only fetched when the amount is relative to it, so an
    // absolute sell costs one request less.
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
    const slippageBps = slippageOf(context, flags)

    if (venue === 'v4') {
      await sellOnV4(context, { launch, token, account, tokensIn, slippageBps, flags })
      return
    }

    const build = (state: V2Launch, minOut?: bigint): Plan =>
      buildCurveSellPlan(state, {
        tokensIn,
        slippageBps,
        recipient,
        ...(minOut === undefined ? {} : { minOut }),
      })
    const plan = build(launch)

    const prerequisites: Plan[] = []
    const allowance = await readAllowance(client, token, account, launch.curve)
    if (allowance < tokensIn) {
      prerequisites.push(buildApprovePlan(token, launch.curve, tokensIn, launch.metadata.symbol))
    }

    await runPlan({
      context,
      plan,
      flags,
      account,
      prerequisites,
      rebuild: async (accepted) =>
        build(await readV2Launch(client, token), floorOf(accepted, 'minQuoteOut')),
      recheck: (fresh, original) => floorCheck(fresh, original, 'quoteOut', 'minQuoteOut'),
    })
  })
}

/** The factory's record, for the pool key fields `readV2Launch` does not keep. */
async function readLaunchRecord(
  client: Parameters<typeof readV2Launch>[0],
  token: Address,
): Promise<{ poolFee: number; tickSpacing: number }> {
  const record = await client.readContract({
    address: addresses.v2Factory,
    abi: v2FactoryAbi,
    functionName: 'getLaunchedToken',
    args: [token],
  })
  return { poolFee: record.poolFee, tickSpacing: record.tickSpacing }
}

interface V4SellArgs {
  launch: V2Launch
  token: Address
  account: Address
  tokensIn: bigint
  slippageBps: bigint
  flags: TradeFlags
}

/**
 * Selling on V4, which is the one operation that cannot be produced unsigned.
 *
 * The router pulls the token through Permit2, Permit2 authorises that with an
 * EIP-712 signature, and only the holder can make it, so there is no calldata
 * to hand to somebody else, and no calldata at all until the key is unlocked.
 * Every other mode therefore reports the quote and stops.
 */
async function sellOnV4(context: CommandContext, args: V4SellArgs): Promise<void> {
  const { launch, token, account, tokensIn, slippageBps, flags } = args
  const { client } = context.rpc()

  if (flags.unsigned === true) {
    throw new UsageError('a V4 sell cannot be produced unsigned', {
      hint: 'the router pulls the token through Permit2, which needs a signature only the holder can make',
    })
  }

  const record = await readLaunchRecord(client, token)
  const v4 = await readV4Context(client, launch, record.poolFee, record.tickSpacing)

  // Permit2 moves the token with `transferFrom`, so the token must approve
  // Permit2 before any signature is worth anything.
  const prerequisites: Plan[] = []
  const erc20Allowance = await readAllowance(client, token, account, addresses.permit2)
  if (erc20Allowance < tokensIn) {
    prerequisites.push(buildPermit2ApprovalPlan(token, launch.metadata.symbol))
  }

  const signer = flags.confirm === true ? await unlockSigner(context) : undefined
  if (signer !== undefined && signer.address.toLowerCase() !== account.toLowerCase()) {
    throw new PonsError('WRONG_ACCOUNT', 'the keystore does not hold the account this sell is for', {
      exitCode: ExitCode.Wallet,
      details: { keystore: signer.address, requested: account },
    })
  }

  const now = (await client.getBlock({ blockTag: 'latest' })).timestamp
  const build = async (minOut?: bigint): Promise<Plan> => {
    const allowance = await readPermit2Allowance(
      client,
      account,
      token,
      addresses.universalRouter,
    )
    const permit = permitFor(token, tokensIn, allowance.nonce, now)
    if (signer === undefined) {
      throw new PonsError('SIGNATURE_REQUIRED', 'this trade exists only once it is signed', {
        exitCode: ExitCode.Wallet,
      })
    }
    const signature = await signer.account.signTypedData(permitTypedData(permit))
    return buildV4SellPlan(client, launch, v4, {
      tokensIn,
      slippageBps,
      account,
      now,
      permit,
      signature,
      ...(minOut === undefined ? {} : { minOut }),
    })
  }

  if (signer === undefined) {
    // No key, so no signature, so no transaction, but the quote is still
    // worth printing, and it is the number the user came for.
    const zeroForOne = v4.key.currency0 === token.toLowerCase()
    const { quoteV4ExactIn } = await import('../core/routes/v4.js')
    const quote = await quoteV4ExactIn(client, v4.key, zeroForOne, tokensIn, account)
    context.reporter.emit(
      {
        mode: 'quote',
        route: 'v4',
        token,
        tokensIn: tokensIn.toString(),
        amountOut: quote.amountOut.toString(),
        symbol: launch.metadata.symbol,
        decimals: launch.metadata.decimals,
        quoteSymbol: launch.quote.symbol,
        quoteDecimals: launch.quote.decimals,
        prerequisites: prerequisites.map((plan) => plan.summary),
      },
      (payload, paint) =>
        [
          paint(
            'bold',
            `sell ${formatToken(BigInt(payload.tokensIn), payload.decimals, payload.symbol)} for ${formatToken(BigInt(payload.amountOut), payload.quoteDecimals, payload.quoteSymbol)}`,
          ),
          paint('grey', 'on the Uniswap V4 pool'),
          ...payload.prerequisites.map((step) => paint('yellow', `first: ${step}`)),
          '',
          paint(
            'grey',
            'a V4 sell is built at signing time: the router pulls the token through Permit2, and',
          ),
          paint('grey', 'the signature that authorises it can only be made by the holder. Add --confirm.'),
        ].join('\n'),
    )
    return
  }

  await runPlan({
    context,
    plan: await build(),
    flags,
    account,
    signer,
    prerequisites,
    rebuild: async (accepted) => build(floorOf(accepted, 'minAmountOut')),
    recheck: (fresh, original) => floorCheck(fresh, original, 'amountOut', 'minAmountOut'),
  })
}

/**
 * Hold a rebuilt plan to the floor the user already accepted.
 *
 * The slippage tolerance is not re-applied to the new price. If it were, a
 * large move between reading the plan and sending it would be silently
 * accepted, which is the exact failure slippage protection exists to prevent.
 * The floor stays where it was; the rebuild only decides whether the trade
 * still clears it.
 */
/**
 * The floor the user accepted, read off the plan they approved.
 *
 * Carried into the rebuild so the trade cannot be signed under it. Recomputing
 * a floor from a moved price and calling it the same bound is the bug this
 * exists to prevent.
 */
function floorOf(accepted: Plan, key: string): bigint | undefined {
  const value = accepted.economics[key]
  return value === undefined ? undefined : BigInt(value)
}

function floorCheck(
  fresh: Plan,
  original: Plan,
  expectedKey: string,
  floorKey: string,
): PonsError | undefined {
  const expected = fresh.economics[expectedKey]
  const floor = original.economics[floorKey]
  if (expected === undefined || floor === undefined) return undefined
  if (BigInt(expected) >= BigInt(floor)) return undefined
  return new PonsError('PRICE_MOVED', 'the price moved past the floor you accepted', {
    exitCode: ExitCode.Aborted,
    details: { expected, floor, plan: original.id },
    hint: 'nothing was sent. run it again to price it fresh, or raise --slippage',
  })
}
