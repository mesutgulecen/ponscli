import { ConfigError } from '../errors.js'
import type { ColorMode } from '../output/color.js'
import { defaultCacheDir, defaultKeystorePath } from './paths.js'

/**
 * Tier 1 endpoints, in the order the waterfall tries them.
 *
 * Only endpoints that answered a real `eth_call` in measurement are listed.
 * drpc is deliberately absent: it answers `eth_chainId` faster than anything
 * else and then rejects `eth_call` with `-32601`, which is exactly the shape of
 * failure a naive health check reports as healthy.
 */
export const DEFAULT_RPC_ENDPOINTS: readonly string[] = [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://rpc.nodeflare.app/robinhood/public',
]

export type RpcTier = 'auto' | '1' | '2'

export interface PonsConfig {
  /** A node the user operates. Always tried before the shared free endpoints. */
  'rpc.url': string | undefined
  /** Tier 1 pool, round-robined. */
  'rpc.endpoints': readonly string[]
  /** Tier 2 credential. Absent means bulk work degrades rather than billing. */
  'rpc.alchemyKey': string | undefined
  /** Pin the waterfall to one tier. `auto` walks Tier 1 then Tier 2. */
  'rpc.tier': RpcTier
  'rpc.timeoutMs': number
  'wallet.keystore': string
  /**
   * Tokens `pons wallet balance` reports without being asked.
   *
   * A list rather than a log scan: at ten blocks a second a full `Transfer`
   * scan is a different piece of machinery, and a trader watches a handful of
   * positions. `pons wallet track` adds to it.
   */
  'wallet.tracked': readonly string[]
  'output.json': boolean
  'output.color': ColorMode
  /** Default slippage tolerance for trades, in basis points. */
  'trade.slippageBps': number
  /** EIP-1559 `maxPriorityFeePerGas`, in gwei. Unset means let the node decide. */
  'trade.priorityFeeGwei': number | undefined
  'cache.dir': string
}

export type ConfigKey = keyof PonsConfig

/** Where a resolved value came from. Reported by `pons config list`. */
export type ConfigSource = 'flag' | 'env' | 'file' | 'default'

export interface ResolveContext {
  env: NodeJS.ProcessEnv
  home: string
  isTTY: boolean
}

interface FieldSpec<K extends ConfigKey> {
  env: string
  describe: string
  /**
   * True for values that must never be printed in full. `config list` prints a
   * placeholder and log redaction keys off this flag. The Alchemy key lives
   * inside a URL, which is precisely how it escapes into transport errors.
   */
  secret?: boolean
  parse: (raw: string, key: K) => PonsConfig[K]
  /** Accept a value that arrived already typed, from the JSON file or a flag. */
  coerce: (raw: unknown, key: K) => PonsConfig[K]
  format: (value: PonsConfig[K]) => string
  fallback: (context: ResolveContext) => PonsConfig[K]
}

type Schema = { [K in ConfigKey]: FieldSpec<K> }

function invalid(key: string, raw: unknown, expected: string): never {
  throw new ConfigError(`invalid value for ${key}: expected ${expected}`, {
    details: { key, received: typeof raw === 'string' ? raw : JSON.stringify(raw) },
    hint: `run 'pons config set ${key} <value>' with a valid value, or 'pons config unset ${key}'`,
  })
}

function parseBoolean(raw: string, key: string): boolean {
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false
  return invalid(key, raw, 'a boolean (true/false)')
}

function parseInteger(raw: string, key: string, min: number, max: number): number {
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value < min || value > max) {
    return invalid(key, raw, `an integer between ${min} and ${max}`)
  }
  return value
}

function parseUrlList(raw: string, key: string): readonly string[] {
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (items.length === 0) return invalid(key, raw, 'a comma-separated list of URLs')
  for (const item of items) assertUrl(item, key)
  return items
}

/**
 * A comma-separated token list.
 *
 * An empty list is legitimate here — it is the default, and unsetting the last
 * tracked token has to be expressible — so unlike the endpoint list this does
 * not reject one.
 */
function parseAddressList(raw: string, key: string): readonly string[] {
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return items.map((item) => assertAddress(item, key))
}

/** Checksums are not enforced: a lowercased address is still the address. */
function assertAddress(raw: string, key: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return invalid(key, raw, 'a 20-byte hex address')
  return raw
}

function assertUrl(raw: string, key: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return invalid(key, raw, 'an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalid(key, raw, 'an absolute http(s) URL')
  }
  return raw
}

function asString(raw: unknown, key: string): string {
  if (typeof raw !== 'string') return invalid(key, raw, 'a string')
  return raw
}

export const SCHEMA: Schema = {
  'rpc.url': {
    env: 'PONS_RPC_URL',
    describe: 'Your own RPC node. Tried before the shared free endpoints.',
    parse: (raw, key) => assertUrl(raw.trim(), key),
    coerce: (raw, key) => assertUrl(asString(raw, key).trim(), key),
    format: (value) => value ?? '',
    fallback: () => undefined,
  },
  'wallet.tracked': {
    env: 'PONS_WALLET_TRACKED',
    describe: 'Token addresses reported by `wallet balance`. Comma-separated.',
    parse: (raw, key) => parseAddressList(raw, key),
    coerce: (raw, key) => {
      if (typeof raw === 'string') return parseAddressList(raw, key)
      if (!Array.isArray(raw)) return invalid(key, raw, 'an array of token addresses')
      return raw.map((item) => assertAddress(asString(item, key).trim(), key))
    },
    format: (value) => value.join(','),
    fallback: () => [],
  },
  'rpc.endpoints': {
    env: 'PONS_RPC_ENDPOINTS',
    describe: 'Tier 1 free endpoints, round-robined. Comma-separated.',
    parse: (raw, key) => parseUrlList(raw, key),
    coerce: (raw, key) => {
      if (typeof raw === 'string') return parseUrlList(raw, key)
      if (!Array.isArray(raw)) return invalid(key, raw, 'an array of URLs')
      return raw.map((item) => assertUrl(asString(item, key).trim(), key))
    },
    format: (value) => value.join(','),
    fallback: () => DEFAULT_RPC_ENDPOINTS,
  },
  'rpc.alchemyKey': {
    env: 'PONS_ALCHEMY_KEY',
    describe: 'Alchemy API key. Enables Tier 2, the paid last resort.',
    secret: true,
    parse: (raw) => raw.trim(),
    coerce: (raw, key) => asString(raw, key).trim(),
    format: (value) => value ?? '',
    fallback: () => undefined,
  },
  'rpc.tier': {
    env: 'PONS_RPC_TIER',
    describe: "Pin the waterfall to one tier: 'auto', '1' or '2'.",
    parse: (raw, key) => {
      const normalized = raw.trim().toLowerCase()
      if (normalized === 'auto' || normalized === '1' || normalized === '2') return normalized
      return invalid(key, raw, "one of 'auto', '1', '2'")
    },
    coerce: (raw, key) => SCHEMA['rpc.tier'].parse(String(raw), key),
    format: (value) => value,
    fallback: () => 'auto',
  },
  'rpc.timeoutMs': {
    env: 'PONS_RPC_TIMEOUT_MS',
    describe: 'Per-request timeout before an endpoint is considered failed.',
    parse: (raw, key) => parseInteger(raw, key, 500, 600_000),
    coerce: (raw, key) => parseInteger(String(raw), key, 500, 600_000),
    format: (value) => String(value),
    fallback: () => 10_000,
  },
  'wallet.keystore': {
    env: 'PONS_KEYSTORE',
    describe: 'Path to the encrypted keystore. Its presence never implies signing.',
    parse: (raw) => raw.trim(),
    coerce: (raw, key) => asString(raw, key).trim(),
    format: (value) => value,
    fallback: (context) => defaultKeystorePath(context.env, context.home),
  },
  'output.json': {
    env: 'PONS_JSON',
    describe: 'Machine-readable output. Defaults on when stdout is not a TTY.',
    parse: (raw, key) => parseBoolean(raw, key),
    coerce: (raw, key) => (typeof raw === 'boolean' ? raw : parseBoolean(String(raw), key)),
    format: (value) => String(value),
    fallback: (context) => !context.isTTY,
  },
  'output.color': {
    env: 'PONS_COLOR',
    describe: "ANSI colour: 'auto', 'always' or 'never'.",
    parse: (raw, key) => {
      const normalized = raw.trim().toLowerCase()
      if (normalized === 'auto' || normalized === 'always' || normalized === 'never') {
        return normalized
      }
      return invalid(key, raw, "one of 'auto', 'always', 'never'")
    },
    coerce: (raw, key) => SCHEMA['output.color'].parse(String(raw), key),
    format: (value) => value,
    fallback: () => 'auto',
  },
  'trade.slippageBps': {
    env: 'PONS_SLIPPAGE_BPS',
    describe: 'Default slippage tolerance in basis points. 100 = 1%.',
    parse: (raw, key) => parseInteger(raw, key, 0, 10_000),
    coerce: (raw, key) => parseInteger(String(raw), key, 0, 10_000),
    format: (value) => String(value),
    fallback: () => 100,
  },
  'trade.priorityFeeGwei': {
    env: 'PONS_PRIORITY_FEE_GWEI',
    describe: 'EIP-1559 maxPriorityFeePerGas in gwei. Unset lets the node decide.',
    parse: (raw, key) => {
      const value = Number(raw.trim())
      if (!Number.isFinite(value) || value < 0) return invalid(key, raw, 'a non-negative number')
      return value
    },
    coerce: (raw, key) => SCHEMA['trade.priorityFeeGwei'].parse(String(raw), key),
    format: (value) => (value === undefined ? '' : String(value)),
    fallback: () => undefined,
  },
  'cache.dir': {
    env: 'PONS_CACHE_DIR',
    describe: 'Where immutable chain data is cached. Safe to delete.',
    parse: (raw) => raw.trim(),
    coerce: (raw, key) => asString(raw, key).trim(),
    format: (value) => value,
    fallback: (context) => defaultCacheDir(context.env, context.home),
  },
}

export const CONFIG_KEYS = Object.keys(SCHEMA) as ConfigKey[]

export function isConfigKey(key: string): key is ConfigKey {
  return Object.prototype.hasOwnProperty.call(SCHEMA, key)
}

/**
 * Environment variables that are read but are deliberately not config keys.
 *
 * Neither belongs in a file that `config list` prints and that users paste into
 * issue reports, and neither may ever be a flag: argv is in the process table
 * and in shell history. They are accepted from the environment for unattended
 * use and otherwise read from a hidden prompt.
 *
 * `pons config list` prints them anyway, without their values. A user looking
 * for "what can I set" looks there, and leaving these out is how somebody ends
 * up inventing a flag for them.
 */
export const ENV_ONLY = {
  PONS_PASSWORD: 'Keystore password for unattended use. Never stored in config.',
  PONS_PRIVATE_KEY: 'Key to import. Read by `wallet import`, never from a flag.',
} as const
