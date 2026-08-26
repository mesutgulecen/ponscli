import { erc20Abi, type Abi, type AbiEvent, type Address, type Log, type PublicClient } from 'viem'

import { v2FactoryAbi } from '../abi/index.js'
import { NATIVE_PAIR_TOKEN, V2_FACTORY_FIRST_LOG_BLOCK, addresses } from '../chain/addresses.js'
import { ExitCode, PonsError } from '../errors.js'
import { IndexStore } from './index/store.js'
import { scanLogs } from './index/scanner.js'

/**
 * The approved quote assets a launch may price against.
 *
 * `PonsV2LaunchFactory` refuses any `pairToken` outside `approvedPairTokens`,
 * and the mapping has no enumerator, so the only way to learn the list is to
 * replay `PairTokenApprovalUpdated` over the whole history and fold it.
 *
 * **The whole history, not a recent window.** Approvals happened early, around
 * block 26.8M, and the chain is past 45M; a fourteen-day window returned six of
 * twenty-three. The scan starts at the factory's first log.
 *
 * The fold is then confirmed against `approvedPairTokens` rather than trusted.
 * Replaying events is a reconstruction, and a reconstruction that disagrees
 * with the mapping it is reconstructing is wrong by definition, and one multicall
 * settles it.
 */

/**
 * Taken from the committed factory ABI rather than written out here, so the
 * filter cannot drift from the contract the CLI otherwise talks to.
 */
const APPROVAL_EVENT = (v2FactoryAbi as Abi).find(
  (item): item is AbiEvent => item.type === 'event' && item.name === 'PairTokenApprovalUpdated',
) as AbiEvent

/** What the cache holds between runs. Immutable facts only; see `readPairTokens`. */
interface CachedPairs {
  /** Last block the approval scan covered. */
  scannedTo: string
  /** Every address ever named by an approval event, in first-seen order. */
  entries: { address: Address; approved: boolean; block: string }[]
  /** Token metadata, which cannot change. */
  metadata: Record<string, { symbol: string; name: string; decimals: number }>
}

export interface PairToken {
  address: Address
  symbol: string
  name: string
  decimals: number
  /** True for the zero address, which is the native asset rather than a token. */
  native: boolean
  /** Curve reserve and threshold, in this asset's own decimals. */
  phantomQuote: bigint
  graduationThreshold: bigint
  /**
   * The scale the factory sized its economics against.
   *
   * Equal to `decimals` in every healthy case. They differ only if an
   * upgradeable quote asset changed its report after approval, which the
   * factory itself rejects at launch, and surfacing it here explains the refusal
   * before the user meets it.
   */
  expectedDecimals: number
  /** Block of the approval that currently stands. Zero for the native asset. */
  approvedAtBlock: bigint
}

export interface ReadPairsOptions {
  /**
   * The launch config the native row's economics come from.
   *
   * `pairTokenEconomics(address(0))` returns zeros, because the native asset is not
   * in that mapping. ETH takes its phantom reserve and threshold from the
   * launch config instead, so the native row is only meaningful relative to
   * one config.
   */
  configId?: bigint
  store?: IndexStore
  /** Ignore the cached fold and replay the whole history. */
  refresh?: boolean
  onProgress?: (message: string) => void
}

/** Approval events folded to final state, in first-seen order. */
function fold(
  logs: Log[],
  seed: CachedPairs['entries'],
): CachedPairs['entries'] {
  const order: Address[] = seed.map((entry) => entry.address)
  const state = new Map<Address, { approved: boolean; block: bigint }>(
    seed.map((entry) => [entry.address, { approved: entry.approved, block: BigInt(entry.block) }]),
  )

  for (const log of logs) {
    const args = (log as Log & { args?: { pairToken?: Address; approved?: boolean } }).args
    if (args?.pairToken === undefined || args.approved === undefined) continue
    const address = args.pairToken.toLowerCase() as Address
    if (!state.has(address)) order.push(address)
    state.set(address, { approved: args.approved, block: log.blockNumber ?? 0n })
  }

  return order.map((address) => {
    const entry = state.get(address) as { approved: boolean; block: bigint }
    return { address, approved: entry.approved, block: entry.block.toString() }
  })
}

/**
 * Read the live approved pair token list.
 *
 * Ordered by first approval, which is the order the Pons web client renders,
 * so the two views agree row for row. Sorting alphabetically here would be
 * tidier and would make every cross-check harder.
 */
export async function readPairTokens(
  client: PublicClient,
  options: ReadPairsOptions = {},
): Promise<PairToken[]> {
  const factory = addresses.v2Factory as Address
  const store = options.store ?? new IndexStore({ chainId: await client.getChainId() })
  const head = await client.getBlockNumber()

  const cached = options.refresh === true ? undefined : store.read<CachedPairs>('pairs')
  const from = cached === undefined ? V2_FACTORY_FIRST_LOG_BLOCK : BigInt(cached.value.scannedTo) + 1n
  const seed = cached?.value.entries ?? []
  const metadata = { ...(cached?.value.metadata ?? {}) }

  let entries = seed
  if (from <= head) {
    if (cached === undefined) options.onProgress?.('scanning the full approval history')
    const logs = await scanLogs(client, {
      address: factory,
      events: [APPROVAL_EVENT],
      fromBlock: from,
      toBlock: head,
      // One request covers the whole history: the filter is selective enough
      // that block 0 to head answered with 25 logs in 0.27 s in measurement.
      // Chunking it into the default 500,000-block steps would turn a single
      // call into nearly forty for no benefit; the scanner subdivides on its
      // own if this ever stops fitting.
      initialSpan: head,
    })
    entries = fold(logs, seed)
  }

  const candidates = entries.filter((entry) => entry.approved).map((entry) => entry.address)
  if (candidates.length === 0) {
    throw new PonsError('NO_PAIR_TOKENS', 'the factory reports no approved quote assets', {
      exitCode: ExitCode.Network,
      hint: 'a native (ETH) launch needs no approval and still works',
    })
  }

  // The fold says what the events implied; this says what the contract holds.
  const confirmations = await client.multicall({
    contracts: candidates.map((address) => ({
      address: factory,
      abi: v2FactoryAbi,
      functionName: 'approvedPairTokens' as const,
      args: [address] as const,
    })),
    allowFailure: false,
  })
  const approved = candidates.filter((_, index) => confirmations[index] === true)

  // Economics are owner-updatable and deliberately never cached. Metadata is
  // immutable, so it is only read for an address the cache has not seen.
  const unknown = approved.filter((address) => metadata[address] === undefined)
  const economics = await client.multicall({
    contracts: [
      ...approved.map((address) => ({
        address: factory,
        abi: v2FactoryAbi,
        functionName: 'pairTokenEconomics' as const,
        args: [address] as const,
      })),
      ...unknown.flatMap((address) => [
        { address, abi: erc20Abi, functionName: 'symbol' as const },
        { address, abi: erc20Abi, functionName: 'name' as const },
        { address, abi: erc20Abi, functionName: 'decimals' as const },
      ]),
    ],
    allowFailure: true,
  })

  for (const [index, address] of unknown.entries()) {
    const base = approved.length + index * 3
    const symbol = economics[base]
    const name = economics[base + 1]
    const decimals = economics[base + 2]
    metadata[address] = {
      symbol: symbol?.status === 'success' ? String(symbol.result) : address.slice(0, 8),
      name: name?.status === 'success' ? String(name.result) : '',
      decimals: decimals?.status === 'success' ? Number(decimals.result) : 18,
    }
  }

  const config = await client.readContract({
    address: factory,
    abi: v2FactoryAbi,
    functionName: 'getLaunchConfig',
    args: [options.configId ?? 0n],
  })

  const blockOf = new Map(entries.map((entry) => [entry.address, BigInt(entry.block)]))
  const tokens: PairToken[] = [
    {
      address: NATIVE_PAIR_TOKEN,
      symbol: 'ETH',
      name: 'Native ETH',
      decimals: 18,
      native: true,
      phantomQuote: config.phantomQuote,
      graduationThreshold: config.graduationThreshold,
      expectedDecimals: 18,
      approvedAtBlock: 0n,
    },
  ]

  for (const [index, address] of approved.entries()) {
    const result = economics[index]
    if (result?.status !== 'success') continue
    const [phantomQuote, graduationThreshold, expectedDecimals] = result.result as readonly [
      bigint,
      bigint,
      number,
    ]
    const info = metadata[address] as { symbol: string; name: string; decimals: number }
    tokens.push({
      address,
      symbol: info.symbol,
      name: info.name,
      decimals: info.decimals,
      native: false,
      phantomQuote,
      graduationThreshold,
      expectedDecimals,
      approvedAtBlock: blockOf.get(address) ?? 0n,
    })
  }

  store.write<CachedPairs>('pairs', { scannedTo: head.toString(), entries, metadata })
  return tokens
}

/**
 * Resolve `--pair` to an address.
 *
 * A symbol is matched case-insensitively against the live list, never against
 * a table compiled here: the list changes (RIVN was approved and then revoked)
 * and a stale hard-coded symbol would launch against the wrong asset. An
 * address is checked for membership rather than passed through, so the failure
 * is `pons pairs` rather than `PairTokenNotApproved` from the chain.
 */
/**
 * Re-read a resolved asset's symbol from its own contract.
 *
 * `resolvePairToken` matches against metadata that survives in the cache
 * between runs, and the cache is a file. Two approved assets with their symbols
 * swapped in it both pass `approvedPairTokens`, so `--pair NVDA` can resolve to
 * a different approved asset, quoting an irreversible launch in something the
 * creator did not choose. One call before the launch settles it.
 *
 * Only worth spending on the launch path. A trade names its token by address
 * and never consults this list.
 */
export async function assertPairSymbol(client: PublicClient, pair: PairToken): Promise<void> {
  if (pair.native) return
  const onChain = await client.readContract({
    address: pair.address,
    abi: erc20Abi,
    functionName: 'symbol',
  })
  if (onChain === pair.symbol) return
  throw new PonsError('PAIR_SYMBOL_MISMATCH', `${pair.address} calls itself ${onChain}, not ${pair.symbol}`, {
    exitCode: ExitCode.Usage,
    details: { address: pair.address, expected: pair.symbol, onChain },
    hint: "the cached pair list disagrees with the chain; 'pons pairs --refresh' rebuilds it",
  })
}

export function resolvePairToken(tokens: readonly PairToken[], raw: string): PairToken {
  const wanted = raw.trim()
  if (wanted === '') {
    throw new PonsError('USAGE', '--pair needs a symbol or an address', { exitCode: ExitCode.Usage })
  }

  if (wanted.startsWith('0x') && wanted.length === 42) {
    const address = wanted.toLowerCase() as Address
    const match = tokens.find((token) => token.address.toLowerCase() === address)
    if (match !== undefined) return match
    throw new PonsError('PAIR_NOT_APPROVED', `${wanted} is not an approved quote asset`, {
      exitCode: ExitCode.Usage,
      hint: "'pons pairs' lists every asset a launch may price against",
    })
  }

  const matches = tokens.filter((token) => token.symbol.toLowerCase() === wanted.toLowerCase())
  if (matches.length === 1) return matches[0] as PairToken
  if (matches.length === 0) {
    throw new PonsError('PAIR_NOT_APPROVED', `no approved quote asset is called ${wanted}`, {
      exitCode: ExitCode.Usage,
      hint: "'pons pairs' lists every asset a launch may price against",
    })
  }
  // Two approved assets sharing a symbol has not happened, but the list is
  // owner-controlled and nothing prevents it. Guessing between them would pick
  // the launch's quote asset for the user; the address is theirs to give.
  throw new PonsError('AMBIGUOUS_PAIR', `${matches.length} approved assets are called ${wanted}`, {
    exitCode: ExitCode.Usage,
    details: { candidates: matches.map((token) => token.address) },
    hint: 'pass the address instead of the symbol',
  })
}
