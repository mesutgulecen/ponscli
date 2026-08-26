import type { Address } from 'viem'

import { robinhoodChain } from '../chain/definition.js'
import { marketCap, spotPrice, type V1Launch } from '../core/adapters/v1.js'
import { renderTable, type Painter } from '../output/index.js'
import { formatAmount, formatBps, formatRatio } from '../output/format.js'

/**
 * `pons info` for a V1 launch.
 *
 * A different shape from V2's and deliberately not squeezed into it. V1 has no
 * curve, no phases, no snipe tax and no reserves — it has a Uniswap V3 position
 * that exists from the first block. Rendering it through V2's table would mean
 * printing five fields as "not applicable", which tells a reader less than a
 * table that only holds what V1 actually has.
 */

export interface V1InfoPayload {
  generation: 'v1'
  token: Address
  pool: Address
  name: string
  symbol: string
  decimals: number
  totalSupply: string
  pair: { address: Address; symbol: string; decimals: number }
  /** Spot price and cap in the pair asset's base units. */
  price: string
  marketCap: string
  poolFee: number
  liquidity: string
  tick: number
  graduation: { raised: string; threshold: string; graduated: boolean }
  restrictions: { maxWallet: string; maxTx: string; endBlock: string; active: boolean }
  positionId: string
  feeRecipient: Address
  protocolFeeSharePercent: number
  deployer: Address
  explorer: string
}

export function toV1Payload(launch: V1Launch): V1InfoPayload {
  return {
    generation: 'v1',
    token: launch.token,
    pool: launch.pool,
    name: launch.metadata.name,
    symbol: launch.metadata.symbol,
    decimals: launch.metadata.decimals,
    totalSupply: launch.metadata.totalSupply.toString(),
    pair: launch.pair,
    price: spotPrice(launch).toString(),
    marketCap: marketCap(launch).toString(),
    poolFee: launch.poolFee,
    liquidity: launch.poolState.liquidity.toString(),
    tick: launch.poolState.tick,
    graduation: {
      raised: launch.graduation.raised.toString(),
      threshold: launch.graduation.threshold.toString(),
      graduated: launch.graduation.graduated,
    },
    restrictions: {
      maxWallet: launch.restrictions.maxWallet.toString(),
      maxTx: launch.restrictions.maxTx.toString(),
      endBlock: launch.restrictions.endBlock.toString(),
      active: launch.restrictions.active,
    },
    positionId: launch.positionId.toString(),
    feeRecipient: launch.feeRecipient,
    protocolFeeSharePercent: Number(launch.protocolFeeSharePercent),
    deployer: launch.deployer,
    explorer: `${robinhoodChain.blockExplorers.default.url}/token/${launch.token}`,
  }
}

export function renderV1(payload: V1InfoPayload, paint: Painter): string {
  const pair = (value: string): string => formatAmount(BigInt(value), payload.pair.decimals)
  const tokens = (value: string): string => formatAmount(BigInt(value), payload.decimals)

  const rows: string[][] = [
    ['price', `${pair(payload.price)} ${payload.pair.symbol}`, paint('grey', `per ${payload.symbol}`)],
    [
      'market cap',
      `${pair(payload.marketCap)} ${payload.pair.symbol}`,
      paint('grey', 'fully diluted, at spot'),
    ],
    ['supply', `${tokens(payload.totalSupply)} ${payload.symbol}`, ''],
    [
      'graduation',
      `${pair(payload.graduation.raised)} / ${pair(payload.graduation.threshold)} ${payload.pair.symbol}`,
      paint(
        payload.graduation.graduated ? 'green' : 'grey',
        // V1 does not migrate anywhere at the threshold: the position is the
        // pool from the first block. The figure is a milestone, not a phase.
        `${formatRatio(BigInt(payload.graduation.raised), BigInt(payload.graduation.threshold))} — the position stays locked either way`,
      ),
    ],
    ['pool fee', formatBps(payload.poolFee / 100), paint('grey', `tick ${String(payload.tick)}`)],
    [
      'liquidity',
      payload.liquidity === '0' ? paint('red', 'drained') : formatAmount(BigInt(payload.liquidity), 18),
      paint('grey', `position #${payload.positionId}, held by the locker`),
    ],
    [
      'position fees',
      `to ${payload.feeRecipient}`,
      paint('grey', `less ${String(payload.protocolFeeSharePercent)}% to the protocol`),
    ],
  ]

  if (payload.restrictions.active) {
    rows.push([
      'restrictions',
      paint('yellow', 'active'),
      paint(
        'grey',
        `max ${tokens(payload.restrictions.maxTx)} per buy, ${tokens(payload.restrictions.maxWallet)} per wallet, until block ${payload.restrictions.endBlock}`,
      ),
    ])
  }

  return [
    `${paint('bold', payload.name)} ${paint('dim', `(${payload.symbol})`)}  ${paint('grey', payload.token)}`,
    paint(
      'grey',
      `V1  ·  pool ${payload.pool}  ·  quoted in ${payload.pair.symbol}`,
    ),
    '',
    renderTable([{ header: '' }, { header: '' }, { header: '' }], rows, '  '),
    '',
    paint('grey', '  V1 is closed to new launches; this token trades on its Uniswap V3 pool as it always has.'),
    '',
    paint('grey', payload.explorer),
  ].join('\n')
}
