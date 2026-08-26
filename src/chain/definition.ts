import { defineChain } from 'viem'

/**
 * Robinhood Chain mainnet.
 *
 * An Arbitrum Nitro Orbit L2 with ETH as the native gas asset. Every value
 * below was verified against the live chain on 2026-08-25; see
 * `docs/architecture/ponscli.md` for the measurements.
 *
 * Two properties of this chain drive design decisions elsewhere in the CLI:
 *
 *  - Block time is ~0.1 s, so a day is ~864,000 blocks. Any code that reasons
 *    about a time window in blocks must use this figure, not an L1 assumption.
 *  - The official RPC is not an archive node: state older than roughly 6,000
 *    to 10,000 blocks answers `-32000 "metadata is not found"`. Logs reach much
 *    further back than state does.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  network: 'robinhood-chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://robinhoodchain.blockscout.com',
      apiUrl: 'https://robinhoodchain.blockscout.com/api',
    },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      // Derived from the factory's first log rather than by bisecting
      // `eth_getCode`: state is pruned, so a bisection converges on the pruning
      // boundary instead of the deployment block.
      blockCreated: 0,
    },
  },
})

/** Robinhood Chain testnet. Present for completeness; not yet exercised. */
export const robinhoodChainTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  network: 'robinhood-chain-testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  testnet: true,
})

/** Approximate block time in milliseconds, measured at 200 blocks per 20 s. */
export const BLOCK_TIME_MS = 100

/** Approximate blocks per day, derived from {@link BLOCK_TIME_MS}. */
export const BLOCKS_PER_DAY = Math.round((24 * 60 * 60 * 1000) / BLOCK_TIME_MS)

/**
 * Gas limit for a native ETH transfer on this chain.
 *
 * Nitro charges the L1 posting cost out of the transaction's own gas limit and
 * `eth_estimateGas` does not surface it. A transfer signed at the usual 21,000
 * succeeds while L1 is cheap and fails intermittently when it is not, which is
 * the worst possible failure mode. Fixed headroom is the only fix, and 100,000
 * is the figure proven on this chain.
 */
export const NATIVE_TRANSFER_GAS_LIMIT = 100_000n
