import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, erc20Abi, numberToHex, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { robinhoodChain } from '../src/chain/definition.js'
import { buildEndpoints } from '../src/chain/endpoint.js'
import { poolTransport } from '../src/chain/transport.js'
import { RpcPool, type Dispatch } from '../src/chain/pool.js'
import { buildCurveBuyPlan, buildCurveSellPlan } from '../src/core/adapters/v2trade.js'
import type { V2Launch } from '../src/core/adapters/v2.js'
import { IndexStore } from '../src/core/index/store.js'
import { createPlan } from '../src/core/plan.js'
import { assertPairSymbol } from '../src/core/pairs.js'
import { floorAtLeast } from '../src/core/quote.js'
import { decryptKeystore, encryptPrivateKey, readKeystoreFile, writeKeystoreFile } from '../src/wallet/keystore.js'
import { sendPlan, type Signer } from '../src/wallet/signer.js'
import { fakeChain } from './fakeChain.js'

/**
 * Regressions from the audit of 2026-08-25.
 *
 * Each of these reproduced a real defect before its fix, and each names what
 * went wrong rather than what the code now does, because a test that only asserts the
 * current shape stops being evidence the moment somebody reshapes it.
 */

const TOKEN = '0x44D6736eB4Bc60c17Fe8220062d8fdE3C28920f4' as Address

function launchAt(quoteReserve: bigint, tokenReserve: bigint): V2Launch {
  return {
    token: TOKEN, curve: TOKEN, deployer: TOKEN, creatorFeeRecipient: TOKEN,
    phase: 'NotGraduated',
    metadata: { name: 'Probe', symbol: 'PROBE', decimals: 18, totalSupply: 10n ** 27n },
    quote: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, native: true },
    reserves: {
      quote: quoteReserve, realQuote: quoteReserve - 1_680_000_000_000_000_000n,
      phantomQuote: 1_680_000_000_000_000_000n, token: tokenReserve,
      sellable: tokenReserve - 285_714_285_714_285_714_285_714_285n,
      reserved: 285_714_285_714_285_714_285_714_285n,
    },
    graduation: { threshold: 4_200_000_000_000_000_000n, ready: false, graduated: false },
    swept: { quote: 0n, tokens: 0n, at: 0n },
    snipeTax: { currentBps: 0n, startBps: 9_900n, windowSeconds: 3n },
    fees: { curveFeeBps: 100n, creatorTaxBps: 0n, protocolFeeShareBps: 3_000, hookFeeBps: 100, buybackBurnBps: 5_000 },
    buyback: { enabled: false, quoteBalance: 0n },
    pending: { quoteFees: 0n, creatorTax: 0n },
    launchedAt: 1_787_654_670n,
  } as unknown as V2Launch
}

describe('the rebuilt plan cannot be signed below the accepted floor', () => {
  const amountIn = 50_000_000_000_000_000n
  const slippageBps = 100n
  const before = launchAt(5_000_000_000_000_000_000n, 900_000_000_000_000_000_000_000_000n)
  // A move small enough that the gate still allows the trade. Before the fix
  // this was the exploitable window: the price fell, the fresh floor fell with
  // it, and the trade could execute up to a further 0.99% down.
  const after = launchAt(5_020_000_000_000_000_000n, 896_414_342_629_482_071_713_147_410n)

  it('carries the accepted floor into the rebuild', () => {
    const accepted = buildCurveBuyPlan(before, { amountIn, slippageBps, recipient: TOKEN })
    const acceptedFloor = BigInt(accepted.economics['minTokensOut'] as string)

    const rebuilt = buildCurveBuyPlan(after, {
      amountIn,
      slippageBps,
      recipient: TOKEN,
      minOut: acceptedFloor,
    })
    expect(BigInt(rebuilt.economics['minTokensOut'] as string)).toBeGreaterThanOrEqual(acceptedFloor)
  })

  it('shows what the rebuild does without the floor, so the window stays visible', () => {
    const accepted = buildCurveBuyPlan(before, { amountIn, slippageBps, recipient: TOKEN })
    const acceptedFloor = BigInt(accepted.economics['minTokensOut'] as string)
    const unpinned = buildCurveBuyPlan(after, { amountIn, slippageBps, recipient: TOKEN })
    const unpinnedFloor = BigInt(unpinned.economics['minTokensOut'] as string)

    // The price moved adversely but still clears the accepted floor, so the
    // pre-flight gate lets it through, and the recomputed floor is lower.
    expect(BigInt(unpinned.economics['tokensOut'] as string)).toBeGreaterThanOrEqual(acceptedFloor)
    expect(unpinnedFloor).toBeLessThan(acceptedFloor)
  })

  it('pins a sell the same way', () => {
    const tokensIn = 1_000_000_000_000_000_000_000_000n
    const accepted = buildCurveSellPlan(before, { tokensIn, slippageBps, recipient: TOKEN })
    const acceptedFloor = BigInt(accepted.economics['minQuoteOut'] as string)
    const rebuilt = buildCurveSellPlan(launchAt(4_990_000_000_000_000_000n, 901_803_607_214_428_857_715_430_861n), {
      tokensIn,
      slippageBps,
      recipient: TOKEN,
      minOut: acceptedFloor,
    })
    expect(BigInt(rebuilt.economics['minQuoteOut'] as string)).toBeGreaterThanOrEqual(acceptedFloor)
  })

  it('takes the higher of the two floors, so a favourable move is not given back', () => {
    expect(floorAtLeast(100n, 90n)).toBe(100n)
    expect(floorAtLeast(90n, 100n)).toBe(100n)
    expect(floorAtLeast(100n, undefined)).toBe(100n)
  })
})

describe('a failed broadcast says whether the node might already have it', () => {
  const account = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  )
  const signer: Signer = { address: account.address, account }
  const plan = createPlan({
    kind: 'transfer', route: 'native', to: '0x000000000000000000000000000000000000dEaD',
    data: '0x', value: 1n, gasLimit: 100_000n, summary: 'probe', warnings: [], economics: {},
  })

  /** A node that either takes the bytes and then drops, or rejects outright. */
  function poolFor(acceptsThenDrops: boolean): RpcPool {
    let accepted = false
    const dispatch: Dispatch = (_endpoint, method) => {
      if (method === 'eth_sendRawTransaction') {
        if (acceptsThenDrops) accepted = true
        return Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      }
      // A transaction the node kept counts as pending; a rejected one does not.
      if (method === 'eth_getTransactionCount') return Promise.resolve(numberToHex(accepted ? 8 : 7))
      if (method === 'eth_chainId') return Promise.resolve(numberToHex(4663))
      if (method === 'eth_blockNumber') return Promise.resolve(numberToHex(45_000_000))
      if (method === 'eth_maxPriorityFeePerGas') return Promise.resolve(numberToHex(1))
      if (method === 'eth_gasPrice') return Promise.resolve(numberToHex(1))
      if (method === 'eth_getBlockByNumber') {
        return Promise.resolve({
          number: numberToHex(45_000_000), hash: `0x${'11'.repeat(32)}`,
          parentHash: `0x${'22'.repeat(32)}`, timestamp: numberToHex(1_787_000_000),
          gasLimit: numberToHex(30_000_000), gasUsed: numberToHex(0),
          baseFeePerGas: numberToHex(1), transactions: [], uncles: [],
        })
      }
      return Promise.reject(Object.assign(new Error(`no stub for ${method}`), { code: -32601 }))
    }
    return new RpcPool({
      endpoints: buildEndpoints({ freeUrls: ['https://node.example'] }),
      dispatch,
      tier: '1',
    })
  }

  async function attempt(acceptsThenDrops: boolean): Promise<{ code: string; hint: string; hash: string }> {
    try {
      await sendPlan(poolFor(acceptsThenDrops), signer, plan, { gasLimit: 100_000n, timeoutMs: 20 })
      throw new Error('sendPlan resolved, which the stub cannot allow')
    } catch (error) {
      const e = error as { code: string; hint?: string; details?: { hash?: string } }
      return { code: e.code, hint: e.hint ?? '', hash: e.details?.hash ?? '' }
    }
  }

  it('does not claim nothing was sent when the nonce moved', async () => {
    const result = await attempt(true)
    // This used to be BROADCAST_FAILED with "nothing was sent; the nonce is
    // unchanged", which is an invitation to retry and make the same trade twice.
    expect(result.code).toBe('BROADCAST_UNCERTAIN')
    expect(result.hint).toMatch(/do not retry blindly/)
  })

  it('still says so plainly when the transaction really was refused', async () => {
    const result = await attempt(false)
    expect(result.code).toBe('BROADCAST_FAILED')
    expect(result.hint).toMatch(/nothing was sent/)
  })

  it('reports the hash either way, so the user can look it up', async () => {
    for (const accepted of [true, false]) {
      const result = await attempt(accepted)
      expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })
})

describe('a malformed keystore fails with a reason', () => {
  let dir: string

  afterEach(() => {
    dir = ''
  })

  async function written(): Promise<{ path: string; store: Awaited<ReturnType<typeof encryptPrivateKey>> }> {
    dir = mkdtempSync(join(tmpdir(), 'ponscli-audit-'))
    const store = await encryptPrivateKey(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      'correct horse',
    )
    const path = join(dir, 'keystore.json')
    writeKeystoreFile(path, store)
    return { path, store }
  }

  const cases: [string, (k: Record<string, unknown>) => void][] = [
    // Each of these used to surface as a raw Node crypto error.
    ['a truncated address', (k) => { (k as { address: string }).address = '0xdead' }],
    ['an address that is not a string', (k) => { (k as { address: unknown }).address = 42 }],
    ['a derived key length aes-256 cannot use', (k) => {
      ;(k as { crypto: { kdfparams: { dklen: number } } }).crypto.kdfparams.dklen = 16
    }],
    ['a scrypt cost that is not a power of two', (k) => {
      ;(k as { crypto: { kdfparams: { n: number } } }).crypto.kdfparams.n = 131_073
    }],
    ['a salt that is not hex', (k) => {
      ;(k as { crypto: { kdfparams: { salt: string } } }).crypto.kdfparams.salt = 'zzzz'
    }],
  ]

  for (const [label, mutate] of cases) {
    it(`rejects ${label}`, async () => {
      const { path, store } = await written()
      const copy = JSON.parse(JSON.stringify(store)) as Record<string, unknown>
      mutate(copy)
      writeFileSync(path, JSON.stringify(copy))
      expect(() => readKeystoreFile(path)).toThrow(/not a usable ponscli keystore/)
    })
  }

  it('compares the address without letting timingSafeEqual throw on length', async () => {
    const { store } = await written()
    const copy = JSON.parse(JSON.stringify(store)) as { address: string }
    copy.address = '0xdead'
    // `decryptKeystore` is reachable on its own, so it has to be safe on its own.
    await expect(decryptKeystore(copy as never, 'correct horse')).rejects.toThrow(
      /names an address its key does not produce/,
    )
  })

  it('still opens an untouched keystore', async () => {
    const { store } = await written()
    await expect(decryptKeystore(store, 'correct horse')).resolves.toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('a cached pair symbol is re-read from the chain before a launch', () => {
  const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' as Address
  const pair = {
    address: NVDA, symbol: 'NVDA', name: 'NVIDIA', decimals: 18, native: false,
    phantomQuote: 1n, graduationThreshold: 2n, expectedDecimals: 18, approvedAtBlock: 1n,
  }

  function clientAnswering(symbol: string): Parameters<typeof assertPairSymbol>[0] {
    const dispatch = fakeChain({
      answers: [{ address: NVDA, abi: erc20Abi, functionName: 'symbol', result: symbol }],
    })
    const pool = {
      send: (method: string, params: unknown[]) => dispatch({ url: 'test' } as never, method, params),
    } as unknown as Parameters<typeof poolTransport>[0]
    return createPublicClient({ chain: robinhoodChain, transport: poolTransport(pool) })
  }

  it('accepts a symbol the contract agrees with', async () => {
    await expect(assertPairSymbol(clientAnswering('NVDA'), pair)).resolves.toBeUndefined()
  })

  it('refuses one the contract disagrees with', async () => {
    // Two approved assets with their symbols swapped in the cache both pass
    // `approvedPairTokens`, so nothing else catches this before the launch.
    await expect(assertPairSymbol(clientAnswering('USDG'), pair)).rejects.toThrow(
      /calls itself USDG, not NVDA/,
    )
  })

  it('has nothing to check for native ETH', async () => {
    await expect(
      assertPairSymbol(clientAnswering('anything'), { ...pair, native: true }),
    ).resolves.toBeUndefined()
  })
})

describe('the cache directory is owner-only', () => {
  it('creates it at 0700, not the default', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ponscli-audit-')), 'nested')
    new IndexStore({ dir, chainId: 4663 }).write('probe', { value: 1 })
    // The cache decides which asset a launch is quoted in; it is not scratch.
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})
