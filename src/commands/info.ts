import { Command } from 'commander'
import { isAddress, type Address } from 'viem'

import { robinhoodChain } from '../chain/definition.js'
import type { CommandContext } from '../context.js'
import {
  graduationProgress,
  marketCap,
  readV2Launch,
  spotPrice,
  type V2Launch,
} from '../core/adapters/v2.js'
import { detectGeneration } from '../core/adapters/detect.js'
import { readV1Launch } from '../core/adapters/v1.js'
import { UsageError } from '../errors.js'
import { renderV1, toV1Payload } from './infoV1.js'
import { renderTable, type Painter } from '../output/index.js'
import {
  formatAge,
  formatAmount,
  formatBps,
  formatDuration,
  formatRatio,
  formatToken,
} from '../output/format.js'

/**
 * `pons info <token>` — everything about one launch that needs no key.
 *
 * The JSON payload carries base units as strings and the human table carries
 * scaled numbers. Both come from the same read, so the two cannot drift.
 */

interface InfoPayload {
  /** Which factory launched this token. Present on both shapes. */
  generation: 'v2'
  token: Address
  curve: Address
  name: string
  symbol: string
  decimals: number
  /** Base units, as a string: JSON numbers cannot hold a token supply. */
  totalSupply: string
  phase: V2Launch['phase']
  quote: V2Launch['quote']
  /**
   * Spot price and cap in quote base units, or null once the curve has been
   * drained: after graduation the token trades on the V4 pool and the curve's
   * remaining reserves would price it at zero.
   */
  price: string | null
  marketCap: string | null
  reserves: {
    quote: string
    realQuote: string
    phantomQuote: string
    token: string
    sellable: string
    reserved: string
  }
  graduation: {
    raised: string
    threshold: string
    ready: boolean
    graduated: boolean
    sweptQuote: string
    sweptTokens: string
    sweptAt: number
  }
  snipeTax: { currentBps: number; startBps: number; windowSeconds: number }
  fees: {
    curveFeeBps: number
    creatorTaxBps: number
    protocolFeeShareBps: number
    hookFeeBps: number
    buybackBurnBps: number
  }
  buyback: { enabled: boolean; lockedQuote: string }
  pending: { quoteFees: string; creatorTax: string }
  creatorFeeRecipient: Address
  deployer: Address
  launchedAt: number
  explorer: string
}

/** True while the bonding curve is still the venue for this token. */
function onCurve(launch: V2Launch): boolean {
  return launch.phase === 'NotGraduated' && !launch.graduation.graduated
}

function toPayload(launch: V2Launch): InfoPayload {
  const progress = graduationProgress(launch)
  const priced = onCurve(launch)
  return {
    generation: 'v2',
    token: launch.token,
    curve: launch.curve,
    name: launch.metadata.name,
    symbol: launch.metadata.symbol,
    decimals: launch.metadata.decimals,
    totalSupply: launch.metadata.totalSupply.toString(),
    phase: launch.phase,
    quote: launch.quote,
    price: priced ? spotPrice(launch).toString() : null,
    marketCap: priced ? marketCap(launch).toString() : null,
    reserves: {
      quote: launch.reserves.quote.toString(),
      realQuote: launch.reserves.realQuote.toString(),
      phantomQuote: launch.reserves.phantomQuote.toString(),
      token: launch.reserves.token.toString(),
      sellable: launch.reserves.sellable.toString(),
      reserved: launch.reserves.reserved.toString(),
    },
    graduation: {
      raised: progress.raised.toString(),
      threshold: progress.threshold.toString(),
      ready: launch.graduation.ready,
      graduated: launch.graduation.graduated,
      sweptQuote: launch.swept.quote.toString(),
      sweptTokens: launch.swept.tokens.toString(),
      sweptAt: Number(launch.swept.at),
    },
    snipeTax: {
      currentBps: Number(launch.snipeTax.currentBps),
      startBps: Number(launch.snipeTax.startBps),
      windowSeconds: Number(launch.snipeTax.windowSeconds),
    },
    fees: {
      curveFeeBps: Number(launch.fees.curveFeeBps),
      creatorTaxBps: Number(launch.fees.creatorTaxBps),
      protocolFeeShareBps: launch.fees.protocolFeeShareBps,
      hookFeeBps: launch.fees.hookFeeBps,
      buybackBurnBps: launch.fees.buybackBurnBps,
    },
    buyback: { enabled: launch.buyback.enabled, lockedQuote: launch.buyback.quoteBalance.toString() },
    pending: {
      quoteFees: launch.pending.quoteFees.toString(),
      creatorTax: launch.pending.creatorTax.toString(),
    },
    creatorFeeRecipient: launch.creatorFeeRecipient,
    deployer: launch.deployer,
    launchedAt: Number(launch.launchedAt),
    explorer: `${robinhoodChain.blockExplorers.default.url}/token/${launch.token}`,
  }
}

const PHASE_NOTE: Record<V2Launch['phase'], string> = {
  NotGraduated: 'trading on the bonding curve',
  Swept: 'graduated, pool not created yet',
  PoolCreated: 'trading on the Uniswap V4 pool',
  Rescued: 'graduation was rescued by the protocol',
}

function render(payload: InfoPayload, paint: Painter, now: bigint): string {
  const quoteSymbol = payload.quote.symbol
  const quoteDecimals = payload.quote.decimals
  const amount = (value: string): string => formatAmount(BigInt(value), quoteDecimals)
  const tokens = (value: string): string => formatAmount(BigInt(value), payload.decimals)

  const rows: string[][] = []
  const traded = payload.price !== null

  if (traded) {
    rows.push([
      'price',
      `${amount(payload.price ?? '0')} ${quoteSymbol}`,
      paint('grey', `per ${payload.symbol}`),
    ])
    rows.push([
      'market cap',
      `${amount(payload.marketCap ?? '0')} ${quoteSymbol}`,
      paint('grey', 'fully diluted, at spot'),
    ])
  }
  rows.push(['supply', `${tokens(payload.totalSupply)} ${payload.symbol}`, ''])

  if (traded) {
    const { raised, threshold } = payload.graduation
    rows.push([
      'graduation',
      `${amount(raised)} / ${amount(threshold)} ${quoteSymbol}`,
      paint(
        payload.graduation.ready ? 'yellow' : 'grey',
        formatRatio(BigInt(raised), BigInt(threshold)),
      ),
    ])
    rows.push([
      'sellable',
      `${tokens(payload.reserves.sellable)} ${payload.symbol}`,
      paint('grey', `${tokens(payload.reserves.reserved)} reserved to seed the pool`),
    ])
    rows.push([
      'reserves',
      `${amount(payload.reserves.quote)} ${quoteSymbol}`,
      paint('grey', `${amount(payload.reserves.phantomQuote)} of it phantom`),
    ])
  } else {
    // Post-graduation the curve holds nothing but its phantom reserve, so
    // every number it would price the token with is zero. The swept amounts
    // are the one thing still on record — and only until the pool is created,
    // because `createGraduatedPool` zeroes them once it has spent them.
    if (payload.graduation.sweptAt > 0) {
      rows.push([
        'swept',
        `${amount(payload.graduation.sweptQuote)} ${quoteSymbol}`,
        paint('grey', `with ${tokens(payload.graduation.sweptTokens)} ${payload.symbol}, waiting to seed the pool`),
      ])
      rows.push([
        'graduated',
        formatAge(BigInt(payload.graduation.sweptAt), now),
        paint('grey', `threshold was ${amount(payload.graduation.threshold)} ${quoteSymbol}`),
      ])
    } else {
      rows.push([
        'graduated',
        `threshold ${amount(payload.graduation.threshold)} ${quoteSymbol}`,
        paint('grey', 'the curve was drained into the pool'),
      ])
    }
  }

  const snipe = payload.snipeTax
  if (traded) {
    rows.push([
      'snipe tax',
      snipe.currentBps === 0
        ? paint('green', 'none')
        : paint('yellow', `${formatBps(snipe.currentBps)} now`),
      paint(
        'grey',
        snipe.startBps === 0
          ? 'disabled for this launch'
          : `starts at ${formatBps(snipe.startBps)}, decays over ${formatDuration(BigInt(snipe.windowSeconds))}`,
      ),
    ])
  }
  rows.push([
    'fees',
    `${formatBps(payload.fees.curveFeeBps)} curve`,
    paint(
      'grey',
      `${formatBps(payload.fees.creatorTaxBps)} creator tax, ${formatBps(payload.fees.protocolFeeShareBps)} of fees to the protocol`,
    ),
  ])
  rows.push([
    'buyback',
    payload.buyback.enabled ? 'on' : paint('grey', 'off'),
    payload.buyback.enabled
      ? paint(
          'grey',
          `${formatBps(payload.fees.buybackBurnBps)} of the creator's fee share, ${amount(payload.buyback.lockedQuote)} ${quoteSymbol} pending`,
        )
      : '',
  ])

  const pendingTotal = BigInt(payload.pending.quoteFees) + BigInt(payload.pending.creatorTax)
  if (pendingTotal > 0n) {
    rows.push([
      'pending fees',
      formatToken(pendingTotal, quoteDecimals, quoteSymbol),
      paint('grey', 'charged, not yet swept — outside the tradeable reserve'),
    ])
  }

  const title = `${paint('bold', payload.name)} ${paint('dim', `(${payload.symbol})`)}`
  const lines = [
    `${title}  ${paint('grey', payload.token)}`,
    paint(
      'grey',
      `curve ${payload.curve}  ·  launched ${formatAge(BigInt(payload.launchedAt), now)}  ·  ${PHASE_NOTE[payload.phase]}`,
    ),
    '',
    renderTable([{ header: '' }, { header: '' }, { header: '' }], rows, '  '),
  ]

  if (payload.graduation.ready) {
    lines.push(
      '',
      paint('yellow', 'ready to graduate'),
      paint('grey', "  the curve stops selling here; sells revert until 'pons graduate' has run"),
    )
  }
  if (payload.phase === 'Swept') {
    lines.push(
      '',
      paint('yellow', 'graduated, but the pool does not exist yet'),
      paint('grey', "  anyone can finish it: 'pons graduate <token> --phase pool'"),
    )
  } else if (!traded) {
    lines.push(
      '',
      paint('grey', '  the curve no longer prices this token; it trades on the Uniswap V4 pool'),
    )
  }
  lines.push('', paint('grey', payload.explorer))
  return lines.join('\n')
}

export function createInfoCommand(getContext: () => CommandContext): Command {
  return new Command('info')
    .description('Price, reserves, graduation phase and live snipe tax for one launch')
    .argument('<token>', 'Token address')
    .action(async (rawToken: string) => {
      const context = getContext()
      if (!isAddress(rawToken, { strict: false })) {
        throw new UsageError(`${rawToken} is not an address`, {
          hint: 'pass the token contract address, for example 0x44D6736eB4Bc60c17Fe8220062d8fdE3C28920f4',
        })
      }

      const { client } = context.rpc()
      // Which factory owns the token decides everything below it. Asked once,
      // of both registries at the same time, rather than guessed from the
      // address or discovered by letting the wrong read fail.
      const { generation } = await detectGeneration(client, rawToken)
      if (generation === 'v1') {
        const v1 = await readV1Launch(client, rawToken)
        context.reporter.emit(toV1Payload(v1), renderV1)
        return
      }

      const launch = await readV2Launch(client, rawToken)
      // Taken from the chain rather than the local clock: a machine with a
      // skewed clock would otherwise report a launch as being in the future.
      const block = await client.getBlock({ blockTag: 'latest' })

      context.reporter.emit(toPayload(launch), (payload, paint) =>
        render(payload, paint, block.timestamp),
      )
    })
}
