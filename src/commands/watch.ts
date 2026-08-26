import { Command } from 'commander'
import { isAddress, type Abi, type AbiEvent, type Address, type Log } from 'viem'

import { v1LockerAbi, v2CurveAbi, v2FactoryAbi, v3PoolAbi } from '../abi/index.js'
import { addresses } from '../chain/addresses.js'
import type { CommandContext } from '../context.js'
import { detectGeneration } from '../core/adapters/detect.js'
import { readV1Launch } from '../core/adapters/v1.js'
import { readV2Launch } from '../core/adapters/v2.js'
import { decodeLogs, displayArgs } from '../core/events.js'
import { scanLogs } from '../core/index/scanner.js'
import { IndexStore } from '../core/index/store.js'
import { resolveUnits, type Units } from '../core/units.js'
import { UsageError } from '../errors.js'
import type { Painter } from '../output/index.js'

/**
 * `pons watch <token>`: the event stream for one launch.
 *
 * **Not a per-block poll.** At ten blocks a second, asking for the head every
 * block is ten requests a second to learn that nothing happened. A cursored
 * `eth_getLogs` over the blocks that have accumulated since the last look
 * costs one request per interval and misses nothing in between: a three-second
 * gap is thirty blocks, and the next scan asks for exactly those thirty.
 */

/**
 * The events worth following, taken from the committed ABIs by name.
 *
 * The curve speaks for one launch and the factory for all of them, which is
 * why the factory's logs are filtered by token afterwards.
 */
const WATCHED_V2 = new Set([
  'CurveBuy',
  'CurveSell',
  'CurveBuyRefunded',
  'CurveCompleted',
  'SnipeTaxCharged',
  'BuybackLocked',
  'FeesSwept',
  'LaunchSwept',
  'PoolGraduated',
  'GraduationTokensPermanentlyLocked',
])

/**
 * V1 has neither a curve nor a graduation, so there is nothing to follow but
 * the pool itself and the locker's fee collections. `Swap` carries signed
 * deltas rather than named in/out amounts, which is why the two generations
 * cannot share a renderer either.
 */
const WATCHED_V1 = new Set(['Swap', 'Mint', 'Burn', 'FeesClaimed'])

function eventsFrom(abis: Abi[], wanted: Set<string>): AbiEvent[] {
  const collected: AbiEvent[] = []
  for (const abi of abis) {
    for (const item of abi) {
      if (item.type === 'event' && wanted.has(item.name)) collected.push(item)
    }
  }
  return collected
}

interface WatchEvent {
  name: string
  blockNumber: string
  transactionHash: string
  address: Address
  /** Base units, as strings. The human view scales them; this does not. */
  args: Record<string, string>
}

interface WatchPayload {
  token: Address
  symbol: string
  fromBlock: string
  toBlock: string
  events: WatchEvent[]
}

function render(payload: WatchPayload, paint: Painter, units: Units): string {
  if (payload.events.length === 0) {
    return paint(
      'grey',
      `no ${payload.symbol} activity in blocks ${payload.fromBlock} to ${payload.toBlock}`,
    )
  }
  return payload.events
    .map((event) => {
      const decoded = { name: event.name, address: event.address, args: event.args }
      const fields = Object.entries(
        displayArgs(
          { index: 0, address: event.address, name: event.name, source: null, topic0: null, args: decoded.args },
          units,
        ),
      )
        .map(([key, value]) => `${paint('grey', key)} ${value}`)
        .join('  ')
      return `${paint('grey', event.blockNumber.padStart(9))}  ${paint('cyan', event.name.padEnd(16))}${fields}`
    })
    .join('\n')
}

export function createWatchCommand(getContext: () => CommandContext): Command {
  return new Command('watch')
    .description('Follow one launch: curve trades, buybacks and graduation')
    .argument('<token>', 'Token address')
    .option('--since <blocks>', 'Blocks of history to print before following', '1000')
    .option('--interval <seconds>', 'Seconds between scans', '3')
    .option('--once', 'Print the backlog and exit instead of following')
    .action(async (rawToken: string, flags: { since?: string; interval?: string; once?: boolean }) => {
      const context = getContext()
      if (!isAddress(rawToken, { strict: false })) throw new UsageError(`${rawToken} is not an address`)
      const token: Address = rawToken
      const { client } = context.rpc()

      // A V1 launch has no curve: its venue is the pool, and the second
      // address worth following is the locker rather than the factory.
      const { generation } = await detectGeneration(client, token)
      const target =
        generation === 'v1'
          ? await v1Target(client, token)
          : await v2Target(client, token)
      const units = await resolveUnits(client, [target.venue, token])
      const store = new IndexStore({
        chainId: client.chain?.id ?? 4663,
        dir: context.config.values['cache.dir'],
      })
      const cursorKey = `watch-${token.toLowerCase()}`

      const head = await client.getBlockNumber()
      const since = BigInt(flags.since ?? '1000')
      const cached = store.read<{ block: string }>(cursorKey)
      // The cursor resumes where the last run stopped, but never earlier than
      // the requested window: a cursor from last week would print a week of
      // history to somebody who asked for the last thousand blocks.
      const start = cached === undefined ? head - since : maxOf(BigInt(cached.value.block) + 1n, head - since)

      const scan = async (from: bigint, to: bigint): Promise<void> => {
        if (from > to) return
        const logs = await scanLogs(client, {
          address: [target.venue, target.registry],
          events: target.events,
          fromBlock: from,
          toBlock: to,
          // Exactly the window asked for. Starting from the scanner's default
          // half a million would ask for the whole recent history on every
          // tick of a loop that is meant to cost one request.
          initialSpan: maxOf(to - from + 1n, 1n),
        })

        const mine = logs.filter((log) => belongsTo(log, target.venue, token))
        context.reporter.emit(
          {
            token,
            symbol: target.symbol,
            fromBlock: from.toString(),
            toBlock: to.toString(),
            events: decodeLogs(mine).map((decoded, position) => ({
              name: decoded.name ?? 'unknown',
              blockNumber: (mine[position]?.blockNumber ?? 0n).toString(),
              transactionHash: mine[position]?.transactionHash ?? '0x',
              address: decoded.address,
              args: decoded.args,
            })),
          } satisfies WatchPayload,
          (payload, paint) => render(payload, paint, units),
        )
        store.write(cursorKey, { block: to.toString() })
      }

      await scan(start, head)
      if (flags.once === true) return

      const intervalMs = Number(flags.interval ?? '3') * 1000
      context.reporter.note(`following ${target.symbol}; ctrl-c to stop`)
      let cursor = head + 1n
      // A follow loop that dies on the first transient failure is not a follow
      // loop. Two free endpoints both answering 429 at the same moment is an
      // ordinary minute on this chain, and the cursor is on disk, so the only
      // cost of waiting is the wait.
      let consecutiveFailures = 0
      for (;;) {
        await sleep(intervalMs * (consecutiveFailures > 0 ? 2 ** Math.min(consecutiveFailures, 5) : 1))
        try {
          const now = await client.getBlockNumber()
          if (now < cursor) continue
          await scan(cursor, now)
          cursor = now + 1n
          consecutiveFailures = 0
        } catch (error) {
          consecutiveFailures += 1
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) throw error
          context.reporter.warn(
            `scan failed (${String(consecutiveFailures)}/${String(MAX_CONSECUTIVE_FAILURES)}), backing off: ${
              error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)
            }`,
          )
        }
      }
    })
}

interface WatchTarget {
  /** The contract that speaks for this launch alone. */
  venue: Address
  /** A shared contract that speaks for every launch, filtered by token. */
  registry: Address
  events: AbiEvent[]
  symbol: string
}

async function v2Target(
  client: Parameters<typeof readV2Launch>[0],
  token: Address,
): Promise<WatchTarget> {
  const launch = await readV2Launch(client, token)
  return {
    venue: launch.curve,
    registry: addresses.v2Factory,
    events: eventsFrom([v2CurveAbi, v2FactoryAbi] as Abi[], WATCHED_V2),
    symbol: launch.metadata.symbol,
  }
}

async function v1Target(
  client: Parameters<typeof readV1Launch>[0],
  token: Address,
): Promise<WatchTarget> {
  const launch = await readV1Launch(client, token)
  return {
    venue: launch.pool,
    registry: addresses.v1Locker,
    events: eventsFrom([v3PoolAbi, v1LockerAbi] as Abi[], WATCHED_V1),
    symbol: launch.metadata.symbol,
  }
}

/**
 * Whether a log is about this launch.
 *
 * Everything the venue emits is, by construction: a V2 curve and a V1 pool
 * both serve exactly one launch. The shared registry, meaning the V2 factory and the V1
 * locker, emits for every launch on the chain, so its logs are kept only when
 * they name this token.
 */
function belongsTo(log: Log, venue: Address, token: Address): boolean {
  if (log.address.toLowerCase() === venue.toLowerCase()) return true
  // `token` is the first indexed parameter of every factory event that names
  // one, so it sits in topic 1 whatever the event.
  const topic = log.topics[1]
  return topic !== undefined && `0x${topic.slice(26)}`.toLowerCase() === token.toLowerCase()
}

/** Consecutive failed scans before `watch` gives up and reports the reason. */
const MAX_CONSECUTIVE_FAILURES = 5

function maxOf(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type { WatchPayload }
