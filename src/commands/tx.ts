import { Command } from 'commander'
import { isHash } from 'viem'

import type { CommandContext } from '../context.js'
import { displayArgs, type DecodedLog } from '../core/events.js'
import { readTransaction, type TransactionReport } from '../core/receipt.js'
import { emptyUnits, resolveUnits, type Units } from '../core/units.js'
import { UsageError } from '../errors.js'
import { renderTable, type Painter } from '../output/index.js'
import { formatAmount, formatToken } from '../output/format.js'

/**
 * `pons tx <hash>`: what a transaction did, and why it failed if it did.
 *
 * The reason a CLI needs this at all is that a receipt says `status: 0` and
 * nothing else. The revert reason is not in the receipt; it has to be recovered
 * by replaying the call, and then translated out of a four-byte selector.
 */

function renderArgs(log: DecodedLog, units: Units, paint: Painter): string {
  const entries = Object.entries(displayArgs(log, units))
  if (entries.length === 0) return paint('grey', log.name === null ? 'not decoded' : '')
  return entries
    .map(([key, value]) => `${paint('grey', `${key}=`)}${abbreviate(value)}`)
    .join(' ')
}

/** Addresses and 32-byte words are unreadable in full inside a log line. */
function abbreviate(value: string): string {
  if (value.startsWith('0x') && value.length > 20) {
    return `${value.slice(0, 8)}…${value.slice(-4)}`
  }
  return value
}

function render(payload: TransactionReport, paint: Painter, units: Units): string {
  const status =
    payload.status === 'success'
      ? paint('green', 'success')
      : payload.status === 'pending'
        ? paint('yellow', 'pending')
        : paint('red', 'reverted')

  const rows: string[][] = [
    ['status', status, payload.block === null ? paint('grey', 'not mined yet') : paint('grey', `block ${payload.block.toString()}`)],
    ['from', payload.from, ''],
    ['to', payload.to ?? paint('grey', 'contract creation'), ''],
    ['value', formatToken(BigInt(payload.value), 18, 'ETH'), ''],
  ]

  if (payload.gas.used !== null) {
    rows.push([
      'gas',
      `${formatAmount(BigInt(payload.gas.used), 0)} of ${formatAmount(BigInt(payload.gas.limit), 0)}`,
      payload.gas.feeWei === null
        ? ''
        : paint('grey', `fee ${formatToken(BigInt(payload.gas.feeWei), 18, 'ETH')}`),
    ])
  }

  const lines = [renderTable([{ header: '' }, { header: '' }, { header: '' }], rows, '  ')]

  if (payload.revert !== null) {
    const { name, selector, message, hint, replayed } = payload.revert
    lines.push('', paint('red', `revert  ${name ?? selector ?? 'unknown'}`))
    // An error with no written explanation has its name as its message, and
    // printing that twice reads as a stutter rather than as detail.
    if (message !== name) lines.push(`  ${message}`)
    if (payload.revert.sources.length > 0) {
      lines.push(paint('grey', `  declared by ${payload.revert.sources.join(', ')}`))
    }
    if (payload.revert.args.length > 0) {
      lines.push(paint('grey', `  arguments: ${payload.revert.args.map(abbreviate).join(', ')}`))
    }
    if (!replayed) {
      lines.push(
        paint(
          'grey',
          '  the reason could not be recovered: replaying needs state this endpoint no longer keeps',
        ),
      )
    }
    if (hint !== undefined) lines.push(`  ${paint('cyan', 'hint')} ${hint}`)
  }

  if (payload.logs.length > 0) {
    lines.push('', paint('dim', `logs (${payload.logs.length.toString()})`))
    lines.push(
      renderTable(
        [{ header: '#', align: 'right' as const }, { header: 'EVENT' }, { header: 'FROM' }, { header: 'ARGUMENTS' }],
        payload.logs.map((log) => [
          log.index.toString(),
          log.name === null ? paint('grey', log.topic0?.slice(0, 10) ?? 'unknown') : log.name,
          paint('grey', log.source ?? log.address.slice(0, 10)),
          renderArgs(log, units, paint),
        ]),
        '  ',
      ),
    )
  }

  lines.push('', paint('grey', payload.explorer))
  return lines.join('\n')
}

export function createTxCommand(getContext: () => CommandContext): Command {
  return new Command('tx')
    .description('Receipt, decoded logs and the revert reason behind a failed transaction')
    .argument('<hash>', 'Transaction hash')
    .action(async (rawHash: string) => {
      const context = getContext()
      if (!isHash(rawHash)) {
        throw new UsageError(`${rawHash} is not a transaction hash`, {
          hint: 'a hash is 0x followed by 64 hexadecimal characters',
        })
      }
      const hash = rawHash
      const { client } = context.rpc()

      const report = await readTransaction(client, hash)
      // Units are resolved only for human output: the JSON payload carries
      // base units, so paying for the metadata that scales them would spend a
      // round trip on something the consumer never sees.
      const units = context.reporter.json
        ? emptyUnits()
        : await resolveUnits(client, report.logs.map((log) => log.address))

      context.reporter.emit(report, (payload, paint) => render(payload, paint, units))
    })
}
