import { Command } from 'commander'
import { formatUnits, isAddress, isHex, size, type Address, type Hex } from 'viem'

import { NATIVE_PAIR_TOKEN } from '../chain/addresses.js'
import type { CommandContext } from '../context.js'
import { parseAmount } from '../core/amount.js'
import { parseSlippageBps, readAllowance } from '../core/adapters/v2trade.js'
import {
  EMPTY_SOCIALS,
  buildLaunchAndBuyPlan,
  buildLaunchApprovalPlan,
  buildLaunchPlan,
  predictLaunchAddresses,
  previewEconomics,
  readEconomicsGuard,
  readLaunchContext,
  saltFor,
  validateLaunch,
  type LaunchContext,
  type LaunchIntent,
  type Socials,
} from '../core/adapters/v2launch.js'
import {
  buildV1LaunchPlan,
  predictV1TokenAddress,
  readV1LaunchContext,
  validateV1Launch,
  type V1LaunchIntent,
} from '../core/adapters/v1launch.js'
import { IndexStore } from '../core/index/store.js'
import { assertPairSymbol, readPairTokens, resolvePairToken, type PairToken } from '../core/pairs.js'
import type { Plan } from '../core/plan.js'
import { ExitCode, PonsError, UsageError } from '../errors.js'
import { formatBps, formatToken } from '../output/format.js'
import { renderTable, type Painter } from '../output/index.js'
import { readKeystoreFile } from '../wallet/keystore.js'
import { addWriteFlags, runPlan, type WriteFlags } from './execute.js'

/**
 * `pons launch` — create a token.
 *
 * The one irreversible command in the CLI. It spends the launch fee, deploys
 * two immutable contracts, and freezes the creator tax, the quote asset and the
 * snipe-tax exemption list for the life of the token. Everything that can be
 * checked before the transaction exists is checked before the transaction
 * exists, and the terms are printed in full before anything is signed.
 */

interface LaunchFlags extends WriteFlags {
  name?: string
  symbol?: string
  desc?: string
  config?: string
  pair?: string
  logo?: string
  twitter?: string
  telegram?: string
  discord?: string
  website?: string
  farcaster?: string
  creatorTax?: string
  buyback?: boolean
  devBuy?: string
  slippage?: string
  exempt?: string
  recipient?: string
  feeRecipient?: string
  salt?: string
  from?: string
  generation?: string
  dex?: string
}

interface LaunchPreviewPayload {
  launcher: Address
  configId: number
  /** Predicted CREATE2 addresses. Known before the launch is sent. */
  token: Address
  curve: Address
  salt: Hex
  expectedEconomics: Hex
  name: string
  symbol: string
  pair: { symbol: string; address: Address; decimals: number; native: boolean }
  supply: string
  reservedTokens: string
  sellableTokens: string
  graduationThreshold: string
  curveFeeBps: number
  creatorTaxBps: number
  hookFeeBps: number
  protocolFeeShareBps: number
  buybackEnabled: boolean
  buybackBurnBps: number
  snipeTaxStartBps: number
  snipeTaxSeconds: number
  exemptions: Address[]
  launchFee: string
  devBuy: string
  tokensOut: string
  minTokensOut: string
  supplyShareBps: number
  totalValue: string
}

function assertAddress(raw: string, what: string): Address {
  if (!isAddress(raw, { strict: false })) throw new UsageError(`${what} ${raw} is not an address`)
  return raw
}

/**
 * The account that will launch.
 *
 * It has to be known before anything is built, not just before signing: it is
 * the CREATE2 namespace, so both predicted addresses depend on it, and
 * `canLaunch` is asked about this specific address.
 */
function resolveLauncher(context: CommandContext, flags: LaunchFlags): Address {
  if (flags.from !== undefined) return assertAddress(flags.from, '--from')
  try {
    return readKeystoreFile(context.config.values['wallet.keystore']).address
  } catch (error) {
    throw new PonsError('NO_ACCOUNT', 'no account to launch from', {
      exitCode: ExitCode.Wallet,
      cause: error,
      hint: "pass --from <address>, or create a keystore with 'pons wallet create'",
    })
  }
}

function socialsOf(flags: LaunchFlags): Socials {
  return {
    ...EMPTY_SOCIALS,
    ...(flags.twitter === undefined ? {} : { twitter: flags.twitter }),
    ...(flags.telegram === undefined ? {} : { telegram: flags.telegram }),
    ...(flags.discord === undefined ? {} : { discord: flags.discord }),
    ...(flags.website === undefined ? {} : { website: flags.website }),
    ...(flags.farcaster === undefined ? {} : { farcaster: flags.farcaster }),
  }
}

/**
 * The CREATE2 salt.
 *
 * A raw 32-byte value is taken as given; anything else is hashed, so a creator
 * mining a vanity address can feed it whatever their search produced. With no
 * `--salt` at all the salt is derived from the name and symbol, which makes
 * relaunching the identical token collide — that collision is a useful
 * refusal, not an obstacle, and `--salt` is right there for a deliberate
 * second launch.
 */
function saltOf(flags: LaunchFlags, name: string, symbol: string): Hex {
  const raw = flags.salt
  if (raw === undefined) return saltFor({ name, symbol }, '')
  if (isHex(raw) && size(raw) === 32) return raw
  return saltFor({ name, symbol }, raw)
}

function parseCreatorTax(raw: string | undefined): number {
  if (raw === undefined) return 0
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`--creator-tax must be a whole number of basis points, got ${raw}`, {
      hint: '100 basis points is 1%',
    })
  }
  return value
}

function parseExemptions(raw: string | undefined): Address[] {
  if (raw === undefined || raw.trim() === '') return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => assertAddress(entry, '--exempt'))
}

function render(payload: LaunchPreviewPayload, paint: Painter): string {
  const scale = (value: string, decimals: number): string => formatUnits(BigInt(value), decimals)
  const rows: string[][] = [
    ['token', paint('bold', payload.token), paint('grey', 'predicted, before it exists')],
    ['curve', payload.curve, ''],
    ['launcher', payload.launcher, ''],
    ['quote asset', `${payload.pair.symbol}`, paint('grey', payload.pair.address)],
    ['supply', scale(payload.supply, 18), ''],
    [
      'sellable on the curve',
      scale(payload.sellableTokens, 18),
      paint('grey', 'the rest seeds the Uniswap V4 pool at graduation'),
    ],
    [
      'graduation at',
      `${scale(payload.graduationThreshold, payload.pair.decimals)} ${payload.pair.symbol}`,
      '',
    ],
    [
      'trade fee',
      formatBps(payload.curveFeeBps + payload.creatorTaxBps),
      paint(
        'grey',
        `${formatBps(payload.curveFeeBps)} curve + ${formatBps(payload.creatorTaxBps)} yours`,
      ),
    ],
    [
      'your share of the curve fee',
      formatBps(10_000 - payload.protocolFeeShareBps),
      paint('grey', `${formatBps(payload.protocolFeeShareBps)} to the protocol`),
    ],
    [
      'snipe tax',
      `${formatBps(payload.snipeTaxStartBps)} decaying over ${String(payload.snipeTaxSeconds)}s`,
      paint('grey', 'you and your fee recipient are exempt automatically'),
    ],
    [
      'buyback vault',
      payload.buybackEnabled ? paint('yellow', 'enabled') : 'off',
      payload.buybackEnabled
        ? paint('grey', `${formatBps(payload.buybackBurnBps)} of your fee share, released over five years`)
        : '',
    ],
    ['launch fee', formatToken(BigInt(payload.launchFee), 18, 'ETH'), ''],
  ]

  if (payload.exemptions.length > 0) {
    rows.push([
      'extra exemptions',
      String(payload.exemptions.length),
      paint('grey', payload.exemptions.join(' ')),
    ])
  }

  if (payload.devBuy !== '0') {
    rows.push(
      [
        'opening buy',
        `${scale(payload.devBuy, payload.pair.decimals)} ${payload.pair.symbol}`,
        paint('grey', 'atomic with the launch, through the launch router'),
      ],
      [
        'you receive',
        `${scale(payload.tokensOut, 18)} ${payload.symbol}`,
        paint('grey', `${formatBps(payload.supplyShareBps)} of supply, floor ${scale(payload.minTokensOut, 18)}`),
      ],
      ['total value', formatToken(BigInt(payload.totalValue), 18, 'ETH'), ''],
    )
  }

  return [
    `${paint('bold', payload.symbol)} ${paint('grey', payload.name)}`,
    '',
    renderTable([{ header: '' }, { header: '' }, { header: '' }], rows, '  '),
    '',
    paint('grey', `  economics pinned to ${payload.expectedEconomics.slice(0, 18)}… — the launch reverts if the`),
    paint('grey', '  protocol owner changes any of these terms before it lands.'),
  ].join('\n')
}

export function createLaunchCommand(getContext: () => CommandContext): Command {
  return addWriteFlags(
    new Command('launch')
      .description('Create a token. V2 by default; V1 is closed to new launches')
      .requiredOption('--name <name>', 'Token name, up to 64 bytes')
      .requiredOption('--symbol <symbol>', 'Token symbol, up to 16 bytes')
      .option('--desc <text>', 'Description, up to 2048 bytes', '')
      .option('--config <id>', 'Launch config id', '0')
      .option('--pair <symbol|address>', 'Quote asset. ETH by default', 'ETH')
      .option('--logo <url>', 'Logo URL, up to 512 bytes', '')
      .option('--twitter <handle>')
      .option('--telegram <handle>')
      .option('--discord <invite>')
      .option('--website <url>')
      .option('--farcaster <handle>')
      .option('--creator-tax <bps>', 'Trade tax paid to you, in basis points', '0')
      .option('--buyback', 'Enable the buyback vault. Costs you, not holders')
      .option('--dev-buy <amount>', 'Opening buy, atomic with the launch')
      .option('--slippage <bps>', 'Slippage tolerance for the opening buy')
      .option('--exempt <addr,addr>', 'Extra wallets exempt from the snipe tax. Cannot be added later')
      .option('--recipient <address>', 'Who receives the opening buy. Defaults to the launcher')
      .option('--fee-recipient <address>', 'Who earns the creator fees. Defaults to the launcher')
      .option('--salt <hex|text>', 'CREATE2 salt, for a chosen or vanity address')
      .option('--from <address>', 'Account to launch from, when there is no keystore')
      .option('--generation <v1|v2>', 'Which factory to launch on. V2 by default', 'v2')
      .option('--dex <id>', 'V1 only: which dex config to launch against', '0'),
  ).action(async (flags: LaunchFlags) => {
    const context = getContext()
    const launcher = resolveLauncher(context, flags)
    const configId = BigInt(flags.config ?? '0')
    const { client } = context.rpc()

    const generation = flags.generation ?? 'v2'
    if (generation !== 'v1' && generation !== 'v2') {
      throw new UsageError(`--generation must be v1 or v2, got ${generation}`)
    }
    if (generation === 'v1') {
      await launchV1(context, flags, launcher, configId)
      return
    }

    const [pairs, launchContext] = await Promise.all([
      readPairTokens(client, {
        configId,
        store: new IndexStore({
          chainId: client.chain?.id ?? 4663,
          dir: context.config.values['cache.dir'],
        }),
        onProgress: (message) => context.reporter.note(message),
      }),
      readLaunchContext(client, configId, launcher),
    ])

    const pair = resolvePairToken(pairs, flags.pair ?? 'ETH')
    // The symbol came out of a cache; a launch is irreversible. One call.
    await assertPairSymbol(client, pair)
    const intent = await buildIntent(context, flags, launchContext, pair, launcher)

    validateLaunch(intent, launchContext)

    const predicted = await predictLaunchAddresses(client, intent, launchContext, launcher)
    if (predicted.taken) {
      throw new PonsError('SALT_ALREADY_USED', 'this launch would land on an address that already exists', {
        exitCode: ExitCode.Usage,
        details: { token: predicted.token, curve: predicted.curve, salt: intent.params.salt },
        hint: 'pass --salt with a different value to launch the same terms again',
      })
    }

    const economics = previewEconomics(intent, launchContext)
    // A note, not an emit: a command emits exactly one payload, and the plan
    // below is it. Everything a machine needs from this table rides on the
    // plan's own economics, so JSON output loses nothing by skipping it.
    context.reporter.note(
      render({
        launcher,
        configId: Number(configId),
        token: predicted.token,
        curve: predicted.curve,
        salt: intent.params.salt,
        expectedEconomics: intent.params.expectedEconomics,
        name: intent.params.name,
        symbol: intent.params.symbol,
        pair: {
          symbol: pair.symbol,
          address: pair.address,
          decimals: pair.decimals,
          native: pair.native,
        },
        supply: launchContext.config.supply.toString(),
        reservedTokens: economics.reservedTokens.toString(),
        sellableTokens: economics.sellableTokens.toString(),
        graduationThreshold: (pair.native
          ? launchContext.config.graduationThreshold
          : pair.graduationThreshold
        ).toString(),
        curveFeeBps: Number(launchContext.config.curveFeeBps),
        creatorTaxBps: intent.params.creatorTaxBps,
        hookFeeBps: launchContext.policy.hookFeeBps,
        protocolFeeShareBps: launchContext.policy.protocolFeeShareBps,
        buybackEnabled: intent.params.buybackEnabled,
        buybackBurnBps: launchContext.policy.buybackBurnBps,
        snipeTaxStartBps: Number(launchContext.snipeTaxStartBps),
        snipeTaxSeconds: Number(launchContext.snipeTaxSeconds),
        exemptions: [...intent.exemptions],
        launchFee: economics.launchFee.toString(),
        devBuy: intent.devBuy.toString(),
        tokensOut: economics.tokensOut.toString(),
        minTokensOut: economics.minTokensOut.toString(),
        supplyShareBps: Number(economics.supplyShareBps),
        totalValue: economics.value.toString(),
      } satisfies LaunchPreviewPayload, context.reporter.paint),
    )

    const withAddresses: LaunchIntent = {
      ...intent,
      predicted: { token: predicted.token, curve: predicted.curve },
    }
    const plan =
      withAddresses.devBuy > 0n
        ? buildLaunchAndBuyPlan(withAddresses, launchContext)
        : buildLaunchPlan(withAddresses, launchContext)

    await runPlan({
      context,
      plan,
      flags,
      account: launcher,
      // A dev buy leaves the launcher holding the token; without this the one
      // command that both creates a token and buys it is the one that does not
      // put it in your balance.
      ...(withAddresses.devBuy > 0n ? { track: predicted.token } : {}),
      prerequisites: await launchPrerequisites(
        client,
        withAddresses,
        launcher,
        launchContext.launchForwarder,
      ),
    })
  })
}

/**
 * The approval an ERC-20 opening buy needs.
 *
 * Native launches need none: the router takes the fee and the buy together as
 * `msg.value`. A quote-asset launch has its buy pulled with `transferFrom`, so
 * the router must be approved first, and only for the exact amount.
 */
async function launchPrerequisites(
  client: Parameters<typeof readAllowance>[0],
  intent: LaunchIntent,
  launcher: Address,
  router: Address,
): Promise<Plan[]> {
  if (intent.devBuy === 0n || intent.pair.native) return []
  const allowance = await readAllowance(client, intent.pair.address, launcher, router)
  if (allowance >= intent.devBuy) return []
  return [buildLaunchApprovalPlan(intent.pair, intent.devBuy, router)]
}

async function buildIntent(
  context: CommandContext,
  flags: LaunchFlags,
  launchContext: LaunchContext,
  pair: PairToken,
  launcher: Address,
): Promise<LaunchIntent> {
  const { client } = context.rpc()
  const name = flags.name ?? ''
  const symbol = flags.symbol ?? ''

  // Always read for the resolved quote asset. The context carries the native
  // digest, and a launch against USDG pinned to ETH's terms would revert with
  // `LaunchEconomicsMismatch` at best and pin nothing at worst.
  const expectedEconomics = pair.native
    ? launchContext.economics
    : await readEconomicsGuard(client, launchContext.configId, pair.address)

  const devBuy =
    flags.devBuy === undefined ? 0n : parseAmount(flags.devBuy, pair.decimals, '--dev-buy')

  return {
    params: {
      name,
      symbol,
      logo: flags.logo ?? '',
      description: flags.desc ?? '',
      socials: socialsOf(flags),
      // Zero means "the deployer" to the factory, which is the right default
      // on the direct path. The atomic router rejects it outright — its three
      // payout addresses may all differ, so it insists the creator names one —
      // and the launcher is what zero would have resolved to anyway.
      creatorFeeRecipient:
        flags.feeRecipient !== undefined
          ? assertAddress(flags.feeRecipient, '--fee-recipient')
          : devBuy > 0n
            ? launcher
            : NATIVE_PAIR_TOKEN,
      creatorTaxBps: parseCreatorTax(flags.creatorTax),
      buybackEnabled: flags.buyback === true,
      expectedEconomics,
      salt: saltOf(flags, name, symbol),
    },
    configId: launchContext.configId,
    pair,
    exemptions: parseExemptions(flags.exempt),
    devBuy,
    slippageBps:
      flags.slippage === undefined
        ? BigInt(context.config.values['trade.slippageBps'])
        : parseSlippageBps(flags.slippage),
    recipient:
      flags.recipient === undefined ? launcher : assertAddress(flags.recipient, '--recipient'),
  }
}

/**
 * `pons launch --generation v1`.
 *
 * Kept separate from the V2 path rather than parameterised into it: the two
 * factories agree on almost nothing that matters here. V1 has a dex id and no
 * quote-asset choice, folds its opening buy into `msg.value`, has no economics
 * guard to pin, and is currently closed. Merging them would produce a function
 * that is mostly branches.
 */
async function launchV1(
  context: CommandContext,
  flags: LaunchFlags,
  launcher: Address,
  launchConfigId: bigint,
): Promise<void> {
  const { client } = context.rpc()
  const dexId = BigInt(flags.dex ?? '0')
  const name = flags.name ?? ''
  const symbol = flags.symbol ?? ''

  const launchContext = await readV1LaunchContext(client, launchConfigId, dexId, launcher)
  const intent: V1LaunchIntent = {
    params: {
      name,
      symbol,
      logo: flags.logo ?? '',
      description: flags.desc ?? '',
      socials: socialsOf(flags),
      feeWallet:
        flags.feeRecipient === undefined
          ? NATIVE_PAIR_TOKEN
          : assertAddress(flags.feeRecipient, '--fee-recipient'),
    },
    launchConfigId,
    dexId,
    salt: saltOf(flags, name, symbol),
    // V1 reads any value above the launch fee as the opening buy, priced in
    // the pair asset — WETH, which the factory wraps out of `msg.value`.
    devBuy: flags.devBuy === undefined ? 0n : parseAmount(flags.devBuy, 18, '--dev-buy'),
  }

  validateV1Launch(intent, launchContext)

  const predicted = await predictV1TokenAddress(client, intent, launcher)
  if (predicted.taken) {
    throw new PonsError('SALT_ALREADY_USED', 'this launch would land on an address that already exists', {
      exitCode: ExitCode.Usage,
      details: { token: predicted.token, salt: intent.salt },
      hint: 'pass --salt with a different value',
    })
  }

  const plan = buildV1LaunchPlan(intent, launchContext)
  context.reporter.note(
    [
      `  token       ${predicted.token}  (predicted)`,
      `  launcher    ${launcher}`,
      `  pool        Uniswap ${launchContext.dex.name}, fee ${String(launchContext.dex.poolFee / 10_000)}%`,
      `  quoted in   ${launchContext.config.pairToken}`,
      `  supply      ${formatUnits(launchContext.config.supply, 18)}`,
    ].join('\n'),
  )

  await runPlan({
    context,
    plan: { ...plan, economics: { ...plan.economics, token: predicted.token } },
    flags,
    account: launcher,
  })
}
