import { Command } from 'commander'
import { isAddress, type Address } from 'viem'

import { buybackVaultAbi, feeEscrowAbi } from '../abi/index.js'
import { addresses } from '../chain/addresses.js'
import type { CommandContext } from '../context.js'
import { readV2Launch } from '../core/adapters/v2.js'
import {
  buildClaimPlan,
  buildGraduatePlan,
  buildVaultReleasePlan,
} from '../core/adapters/v2trade.js'
import type { Plan } from '../core/plan.js'
import { ExitCode, PonsError, UsageError } from '../errors.js'
import { renderTable, type Painter } from '../output/index.js'
import { formatAge, formatBps, formatDuration, formatRatio, formatToken } from '../output/format.js'
import { detectGeneration } from '../core/adapters/detect.js'
import { readV1Launch } from '../core/adapters/v1.js'
import { buildV1CollectPlan } from '../core/adapters/v1trade.js'
import { readKeystoreFile } from '../wallet/keystore.js'
import { addWriteFlags, runPlan, type WriteFlags } from './execute.js'

/**
 * The permissionless parts of a launch's life: graduation, fee claims, and the
 * buyback vault. None of these belong to the creator alone — `graduate` and
 * `release` can be called by anybody, which is exactly why a CLI should expose
 * them rather than leaving a stalled token stuck.
 */

function assertAddress(raw: string, what = 'token'): Address {
  if (!isAddress(raw, { strict: false })) throw new UsageError(`${raw} is not a ${what} address`)
  return raw
}

type PhaseChoice = 'sweep' | 'pool' | 'both'

export function createGraduateCommand(getContext: () => CommandContext): Command {
  return addWriteFlags(
    new Command('graduate')
      .description('Finish a curve that has raised its threshold. Anyone may call this')
      .argument('<token>', 'Token address')
      .option('--phase <phase>', 'sweep, pool, or both (default)', 'both'),
  ).action(async (rawToken: string, flags: WriteFlags & { phase?: string }) => {
    const context = getContext()
    const token = assertAddress(rawToken)
    const phase = (flags.phase ?? 'both') as PhaseChoice
    if (!['sweep', 'pool', 'both'].includes(phase)) {
      throw new UsageError(`--phase must be sweep, pool or both, got ${phase}`)
    }

    const { client } = context.rpc()
    const launch = await readV2Launch(client, token)
    const symbol = launch.metadata.symbol

    if (launch.phase === 'PoolCreated') {
      throw new PonsError('ALREADY_GRADUATED', `${symbol} already trades on its Uniswap V4 pool`, {
        exitCode: ExitCode.Usage,
        details: { token, phase: launch.phase },
      })
    }
    if (launch.phase === 'NotGraduated' && !launch.graduation.ready) {
      const { realQuote } = launch.reserves
      throw new PonsError('NOT_READY', `${symbol} has not raised its graduation threshold yet`, {
        exitCode: ExitCode.Revert,
        details: {
          raised: realQuote.toString(),
          threshold: launch.graduation.threshold.toString(),
        },
        hint: `it is at ${formatRatio(realQuote, launch.graduation.threshold)} — 'pons info ${token}' tracks it`,
      })
    }

    // The curve may already have been drained by somebody else, or by the
    // automatic trigger inside the last buy. Asking for both phases when only
    // the pool is left should do the one that remains, not fail on the one
    // that is already done.
    const needsSweep = launch.phase === 'NotGraduated'
    const wants = phase === 'both' ? (needsSweep ? ['sweep', 'pool'] : ['pool']) : [phase]
    if (wants.includes('sweep') && !needsSweep) {
      throw new PonsError('ALREADY_SWEPT', `the ${symbol} curve has already been drained`, {
        exitCode: ExitCode.Usage,
        hint: "run it with --phase pool to create the pool",
      })
    }

    const plans = wants.map((step) => buildGraduatePlan(token, step as 'sweep' | 'pool', symbol))
    const plan = plans[plans.length - 1] as Plan
    await runPlan({
      context,
      plan,
      flags,
      prerequisites: plans.slice(0, -1),
    })
  })
}

interface ClaimPayload {
  recipient: Address
  asset: { address: Address | null; symbol: string; decimals: number }
  claimable: string
}

export function createClaimCommand(getContext: () => CommandContext): Command {
  return addWriteFlags(
    new Command('claim')
      .description('Claim creator or protocol fees held in the escrow')
      .option('--token <address>', 'Claim an ERC-20 quote asset instead of native ETH')
      .option('--from <address>', 'Account to claim for, when there is no keystore'),
  ).action(async (flags: WriteFlags & { token?: string; from?: string }) => {
    const context = getContext()
    const recipient =
      flags.from !== undefined
        ? assertAddress(flags.from, 'account')
        : readKeystoreFile(context.config.values['wallet.keystore']).address
    const asset = flags.token === undefined ? undefined : assertAddress(flags.token)
    const { client } = context.rpc()
    const escrow = addresses.feeEscrow as Address

    // Read what is owed before building the claim: an empty claim is a wasted
    // transaction, and the escrow reverts on nothing rather than paying zero.
    const claimable =
      asset === undefined
        ? await client.readContract({
            address: escrow,
            abi: feeEscrowAbi,
            functionName: 'balanceOf',
            args: [recipient],
          })
        : await client.readContract({
            address: escrow,
            abi: feeEscrowAbi,
            functionName: 'balanceOfToken',
            args: [recipient, asset],
          })

    if (claimable === 0n) {
      throw new PonsError('NOTHING_TO_CLAIM', `the escrow owes ${recipient} nothing`, {
        exitCode: ExitCode.Usage,
        details: { recipient, asset: asset ?? 'native' },
        hint: 'fees accrue as trades happen and are swept on a schedule, not per trade',
      })
    }

    const symbol = asset === undefined ? 'ETH' : asset
    context.reporter.note(`escrow owes ${claimable.toString()} (base units of ${symbol})`)
    await runPlan({ context, plan: buildClaimPlan(asset, symbol), flags })
  })
}

interface VaultPayload {
  token: Address
  symbol: string
  decimals: number
  totalLocked: string
  totalReleased: string
  vested: string
  releasable: string
  vestingStart: number
  vestingDuration: number
  creatorRecipient: Address
  protocolRecipient: Address
  protocolFeeShareBps: number
}

function renderVault(payload: VaultPayload, paint: Painter, now: bigint): string {
  const amount = (value: string): string =>
    formatToken(BigInt(value), payload.decimals, payload.symbol)
  const end = BigInt(payload.vestingStart + payload.vestingDuration)
  const rows = [
    ['locked', amount(payload.totalLocked), ''],
    ['released', amount(payload.totalReleased), paint('grey', 'paid out so far')],
    [
      'vested',
      amount(payload.vested),
      paint('grey', formatRatio(BigInt(payload.vested), BigInt(payload.totalLocked))),
    ],
    ['releasable now', amount(payload.releasable), ''],
    [
      'vesting',
      payload.vestingStart === 0 ? paint('grey', 'not started') : `started ${formatAge(BigInt(payload.vestingStart), now)}`,
      paint(
        'grey',
        payload.vestingStart === 0
          ? `runs ${formatDuration(BigInt(payload.vestingDuration))} once it starts`
          : `runs ${formatDuration(BigInt(payload.vestingDuration))}, ending in ${formatDuration(end > now ? end - now : 0n)}`,
      ),
    ],
    ['creator', payload.creatorRecipient, paint('grey', `${formatBps(10_000 - payload.protocolFeeShareBps)} of each release`)],
    ['protocol', payload.protocolRecipient, paint('grey', `${formatBps(payload.protocolFeeShareBps)} of each release`)],
  ]
  // A launch that never enabled the buyback reads as an all-zero vault, which
  // looks like one that exists and is empty. Say which it is.
  const dormant = payload.vestingStart === 0 && BigInt(payload.totalLocked) === 0n
  return [
    `${paint('bold', payload.symbol)} ${paint('grey', payload.token)}`,
    ...(dormant ? ['', paint('grey', '  no vault holds anything for this token — the launch did not enable one')] : []),
    '',
    renderTable([{ header: '' }, { header: '' }, { header: '' }], rows, '  '),
    '',
    paint(
      'grey',
      '  Released supply goes to the creator and the protocol, never to holders. The lock is funded',
    ),
    paint('grey', "  entirely from the creator's fee share, so enabling it moves value to the protocol."),
  ].join('\n')
}

export function createVaultCommand(getContext: () => CommandContext): Command {
  const command = new Command('vault').description('Buyback vault: locked, released and vested supply')

  command
    .command('show', { isDefault: true })
    .argument('<token>', 'Token address')
    .description('Read the vault position for one launch')
    .action(async (rawToken: string) => {
      const context = getContext()
      const token = assertAddress(rawToken)
      const { client } = context.rpc()
      const vault = addresses.buybackVault as Address
      const launch = await readV2Launch(client, token)

      const [totalLocked, totalReleased, vested, releasable, vestingStart, duration, terms] =
        await client.multicall({
          contracts: [
            { address: vault, abi: buybackVaultAbi, functionName: 'totalLocked', args: [token] },
            { address: vault, abi: buybackVaultAbi, functionName: 'totalReleased', args: [token] },
            { address: vault, abi: buybackVaultAbi, functionName: 'vestedAmount', args: [token] },
            { address: vault, abi: buybackVaultAbi, functionName: 'releasable', args: [token] },
            { address: vault, abi: buybackVaultAbi, functionName: 'vestingStart', args: [token] },
            { address: vault, abi: buybackVaultAbi, functionName: 'VESTING_DURATION' },
            { address: vault, abi: buybackVaultAbi, functionName: 'vestingTerms', args: [token] },
          ],
          allowFailure: false,
        })

      const block = await client.getBlock({ blockTag: 'latest' })
      const payload: VaultPayload = {
        token,
        symbol: launch.metadata.symbol,
        decimals: launch.metadata.decimals,
        totalLocked: totalLocked.toString(),
        totalReleased: totalReleased.toString(),
        vested: vested.toString(),
        releasable: releasable.toString(),
        vestingStart: Number(vestingStart),
        vestingDuration: Number(duration),
        creatorRecipient: terms[0],
        protocolRecipient: terms[1],
        protocolFeeShareBps: terms[2],
      }
      context.reporter.emit(payload, (value, paint) => renderVault(value, paint, block.timestamp))
    })

  addWriteFlags(
    command
      .command('release')
      .argument('<token>', 'Token address')
      .description('Release vested supply to the recorded recipients. Anyone may call this'),
  ).action(async (rawToken: string, flags: WriteFlags) => {
    const context = getContext()
    const token = assertAddress(rawToken)
    const { client } = context.rpc()
    const releasable = await client.readContract({
      address: addresses.buybackVault,
      abi: buybackVaultAbi,
      functionName: 'releasable',
      args: [token],
    })
    if (releasable === 0n) {
      throw new PonsError('NOTHING_TO_RELEASE', 'the vault has nothing vested for this token yet', {
        exitCode: ExitCode.Usage,
        details: { token },
        hint: 'the vest runs linearly over five years from the first lock',
      })
    }
    const launch = await readV2Launch(client, token)
    await runPlan({ context, plan: buildVaultReleasePlan(token, launch.metadata.symbol), flags })
  })

  return command
}

/**
 * `pons collect <token>` — a V1 launch's accrued Uniswap V3 position fees.
 *
 * V1's answer to `pons claim`, and a different contract for a different
 * reason: V2 accrues fees into an escrow keyed by account, while V1 leaves
 * them on the locked V3 position and lets the locker collect them on demand.
 *
 * **Not permissionless**, unlike `graduate` or `vault release`. The locker
 * accepts the call only from the protocol owner, the launch's deployer, its
 * fee-redirect recipient, or a whitelisted collector — so this is checked
 * before a transaction is built rather than left to revert `NotAuthorized`.
 */
export function createCollectCommand(getContext: () => CommandContext): Command {
  return addWriteFlags(
    new Command('collect')
      .description("Collect a V1 launch's Uniswap V3 position fees")
      .argument('<token>', 'Token address')
      .option('--from <address>', 'Account to collect as, when there is no keystore'),
  ).action(async (rawToken: string, flags: WriteFlags & { from?: string }) => {
    const context = getContext()
    const token = assertAddress(rawToken)
    const { client } = context.rpc()

    const { generation } = await detectGeneration(client, token)
    if (generation !== 'v1') {
      throw new PonsError('WRONG_GENERATION', `${token} is a V2 launch; its fees live in the escrow`, {
        exitCode: ExitCode.Usage,
        hint: "'pons claim' collects those",
      })
    }

    const launch = await readV1Launch(client, token)
    const account =
      flags.from !== undefined
        ? assertAddress(flags.from, 'account')
        : readKeystoreFile(context.config.values['wallet.keystore']).address

    const allowed =
      account.toLowerCase() === launch.deployer.toLowerCase() ||
      account.toLowerCase() === launch.feeRecipient.toLowerCase()
    if (!allowed) {
      // The locker also accepts the protocol owner and any whitelisted
      // collector, neither of which is worth a round trip to check: an address
      // that is one of those knows it, and `--confirm` still simulates first.
      context.reporter.warn(
        `${account} is neither this launch's deployer nor its fee recipient; the locker will refuse unless it is the protocol owner or a whitelisted collector`,
      )
    }

    await runPlan({ context, plan: buildV1CollectPlan(launch), flags, account })
  })
}

export type { ClaimPayload }
