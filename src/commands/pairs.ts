import { Command } from 'commander'
import type { Address } from 'viem'

import type { CommandContext } from '../context.js'
import { readPairTokens, type PairToken } from '../core/pairs.js'
import { IndexStore } from '../core/index/store.js'
import { renderTable, type Painter } from '../output/index.js'
import { formatAmount, formatRatio } from '../output/format.js'

/**
 * `pons pairs`: the quote assets a launch may price against.
 *
 * Ordered by approval, which is how the Pons web client renders it, so the two
 * lists agree row for row and a user can check one against the other.
 */

interface PairRow {
  symbol: string
  name: string
  address: Address
  decimals: number
  expectedDecimals: number
  native: boolean
  phantomQuote: string
  graduationThreshold: string
  approvedAtBlock: string
  /** True when the asset's own report disagrees with the factory's record. */
  decimalsMismatch: boolean
}

interface PairsPayload {
  configId: number
  count: number
  pairs: PairRow[]
}

function toRow(token: PairToken): PairRow {
  return {
    symbol: token.symbol,
    name: token.name,
    address: token.address,
    decimals: token.decimals,
    expectedDecimals: token.expectedDecimals,
    native: token.native,
    phantomQuote: token.phantomQuote.toString(),
    graduationThreshold: token.graduationThreshold.toString(),
    approvedAtBlock: token.approvedAtBlock.toString(),
    decimalsMismatch: !token.native && token.decimals !== token.expectedDecimals,
  }
}

function render(payload: PairsPayload, paint: Painter): string {
  const rows = payload.pairs.map((pair) => {
    return [
      pair.native ? paint('cyan', pair.symbol) : pair.symbol,
      // Called out because it is the one field that silently ruins a launch:
      // a wei-denominated reserve on a six-decimal asset is off by a factor of
      // a million million, and USDG is a live six-decimal quote asset.
      pair.decimals === 18 ? paint('grey', '18') : paint('yellow', String(pair.decimals)),
      formatAmount(BigInt(pair.phantomQuote), pair.decimals),
      formatAmount(BigInt(pair.graduationThreshold), pair.decimals),
      formatRatio(BigInt(pair.graduationThreshold), BigInt(pair.phantomQuote) + BigInt(pair.graduationThreshold)),
      paint('grey', pair.address),
      paint('grey', pair.name),
    ].concat(
      pair.decimalsMismatch
        ? [paint('red', `reports ${String(pair.decimals)}, factory recorded ${String(pair.expectedDecimals)}`)]
        : [],
    )
  })

  const table = renderTable(
    [
      { header: 'symbol' },
      { header: 'dec', align: 'right' },
      { header: 'phantom', align: 'right' },
      { header: 'threshold', align: 'right' },
      { header: 'to pool', align: 'right' },
      { header: 'address' },
      { header: 'name' },
    ],
    rows,
    '  ',
  )

  return [
    table,
    '',
    paint(
      'grey',
      `  ${String(payload.count)} quote assets against launch config ${String(payload.configId)}. Phantom reserve and threshold are in each`,
    ),
    paint(
      'grey',
      "  asset's own units; 'to pool' is the share of supply that reaches the Uniswap V4 pool, and is",
    ),
    paint('grey', '  the same for every one of them.'),
  ].join('\n')
}

export function createPairsCommand(getContext: () => CommandContext): Command {
  return new Command('pairs')
    .description('Approved quote assets a launch may price against')
    .option('--config <id>', 'Launch config the native row is priced against', '0')
    .option('--refresh', 'Replay the whole approval history instead of resuming from the cache')
    .action(async (flags: { config?: string; refresh?: boolean }) => {
      const context = getContext()
      const configId = BigInt(flags.config ?? '0')
      const { client } = context.rpc()
      const tokens = await readPairTokens(client, {
        configId,
        store: new IndexStore({
          chainId: client.chain?.id ?? 4663,
          dir: context.config.values['cache.dir'],
        }),
        ...(flags.refresh === true ? { refresh: true } : {}),
        onProgress: (message) => context.reporter.note(message),
      })

      context.reporter.emit(
        { configId: Number(configId), count: tokens.length, pairs: tokens.map(toRow) },
        render,
      )
    })
}
