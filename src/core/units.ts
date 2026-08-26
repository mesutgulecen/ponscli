import { erc20Abi, getAddress, type Address, type PublicClient } from 'viem'

import { v2CurveAbi, v3PoolAbi } from '../abi/index.js'
import { NATIVE_PAIR_TOKEN } from '../chain/addresses.js'

/**
 * Putting units on the numbers in a receipt.
 *
 * A log carries `quoteIn=5000000000000000`, which is exact and unreadable. The
 * decimals that turn it into `0.005 ETH` are not in the log, the ABI, or the
 * receipt. They live on the token contract, so they have to be read.
 *
 * Nothing here is guessed. An address that does not answer `decimals()` is left
 * unresolved and its amounts are printed raw, which is the honest outcome: a
 * wrong scale is far worse than an unscaled number.
 */

export interface Unit {
  symbol: string
  decimals: number
}

export interface Units {
  /** ERC-20 metadata, keyed by lowercased address. */
  assets: Map<string, Unit>
  /**
   * Venue address → the two assets it trades, keyed by lowercased address.
   *
   * A V2 curve reports them as `token`/`pairToken` and a V3 pool as
   * `token0`/`token1`; both land here in that order, so a log's first amount is
   * always `token` and its second `quote` whichever venue emitted it.
   */
  curves: Map<string, { token: Address; quote: Address }>
}

const NATIVE: Unit = { symbol: 'ETH', decimals: 18 }

export function emptyUnits(): Units {
  return { assets: new Map(), curves: new Map() }
}

/** Look up one asset, treating the zero address as the native currency. */
export function unitOf(units: Units, address: Address | undefined): Unit | undefined {
  if (address === undefined) return undefined
  if (address === NATIVE_PAIR_TOKEN) return NATIVE
  return units.assets.get(address.toLowerCase())
}

/**
 * Resolve the units behind a set of addresses seen in a receipt.
 *
 * Two aggregates at most. The first asks every address both what an ERC-20
 * would answer and what a curve would; whichever succeeds identifies it. The
 * second fills in a curve's token or quote asset when that asset did not emit
 * a log of its own, which it usually did, because a trade moves it.
 */
export async function resolveUnits(
  client: PublicClient,
  addresses: readonly Address[],
): Promise<Units> {
  const units = emptyUnits()
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))] as Address[]
  if (unique.length === 0) return units

  const probes = await client.multicall({
    contracts: unique.flatMap((address) => [
      { address, abi: erc20Abi, functionName: 'decimals' } as const,
      { address, abi: erc20Abi, functionName: 'symbol' } as const,
      { address, abi: v2CurveAbi, functionName: 'token' } as const,
      { address, abi: v2CurveAbi, functionName: 'pairToken' } as const,
      { address, abi: v3PoolAbi, functionName: 'token0' } as const,
      { address, abi: v3PoolAbi, functionName: 'token1' } as const,
    ]),
  })

  const PROBES_PER_ADDRESS = 6
  const missing = new Set<string>()
  unique.forEach((address, position) => {
    const [decimals, symbol, token, pairToken, token0, token1] = probes.slice(
      position * PROBES_PER_ADDRESS,
      position * PROBES_PER_ADDRESS + PROBES_PER_ADDRESS,
    )
    if (decimals?.status === 'success' && symbol?.status === 'success') {
      units.assets.set(address, {
        symbol: symbol.result as string,
        decimals: decimals.result as number,
      })
    }
    // A curve answers the first pair, a V3 pool the second, an ERC-20 neither.
    const sides =
      token?.status === 'success' && pairToken?.status === 'success'
        ? [token.result as Address, pairToken.result as Address]
        : token0?.status === 'success' && token1?.status === 'success'
          ? [token0.result as Address, token1.result as Address]
          : undefined
    if (sides !== undefined) {
      const tokenAddress = getAddress(sides[0] as Address)
      const quoteAddress = getAddress(sides[1] as Address)
      units.curves.set(address, { token: tokenAddress, quote: quoteAddress })
      for (const asset of [tokenAddress, quoteAddress]) {
        if (asset !== NATIVE_PAIR_TOKEN && !units.assets.has(asset.toLowerCase())) {
          missing.add(asset.toLowerCase())
        }
      }
    }
  })

  if (missing.size === 0) return units

  const extra = [...missing] as Address[]
  const results = await client.multicall({
    contracts: extra.flatMap((address) => [
      { address, abi: erc20Abi, functionName: 'decimals' } as const,
      { address, abi: erc20Abi, functionName: 'symbol' } as const,
    ]),
  })
  extra.forEach((address, position) => {
    const [decimals, symbol] = results.slice(position * 2, position * 2 + 2)
    if (decimals?.status === 'success' && symbol?.status === 'success') {
      units.assets.set(address, {
        symbol: symbol.result as string,
        decimals: decimals.result as number,
      })
    }
  })

  return units
}
