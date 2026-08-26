import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

import { ConfigError } from '../errors.js'
import { configFilePath } from './paths.js'
import {
  CONFIG_KEYS,
  SCHEMA,
  isConfigKey,
  type ConfigKey,
  type ConfigSource,
  type PonsConfig,
  type ResolveContext,
} from './schema.js'

export * from './schema.js'
export * from './paths.js'

/** File permissions: the config may hold an API key, so it is owner-only. */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

export interface ResolvedConfig {
  values: PonsConfig
  /** Where each value came from, for `pons config list`. */
  sources: Record<ConfigKey, ConfigSource>
  filePath: string
  fileExists: boolean
}

/**
 * The schema is written with per-key types so callers get precise inference.
 * Iterating it generically needs one erased view; this is the single place that
 * cast lives, rather than sprinkling `any` through the resolution loop.
 */
interface ErasedSpec {
  env: string
  describe: string
  secret?: boolean
  parse: (raw: string, key: string) => unknown
  coerce: (raw: unknown, key: string) => unknown
  format: (value: unknown) => string
  fallback: (context: ResolveContext) => unknown
}

function specOf(key: ConfigKey): ErasedSpec {
  return SCHEMA[key] as unknown as ErasedSpec
}

export function defaultContext(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    env: overrides.env ?? process.env,
    home: overrides.home ?? homedir(),
    isTTY: overrides.isTTY ?? Boolean(process.stdout.isTTY),
  }
}

/**
 * Read the config file.
 *
 * The on-disk shape is a flat object of dotted keys, not a nested tree. That is
 * a deliberate choice: it makes `pons config set rpc.url ...` a one-line
 * operation with no merge semantics to get wrong, and it means an agent editing
 * the file sees exactly the keys `pons config list` prints.
 *
 * A missing file is not an error. A malformed one is: silently ignoring broken
 * JSON would run the command against defaults the user never asked for.
 */
export function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new ConfigError(`cannot read config file: ${path}`, {
      details: { path, reason: cause instanceof Error ? cause.message : String(cause) },
      hint: 'check the file permissions',
    })
  }
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new ConfigError(`config file is not valid JSON: ${path}`, {
      details: { path, reason: cause instanceof Error ? cause.message : String(cause) },
      hint: 'fix the file by hand, or delete it to start from defaults',
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`config file must contain a JSON object: ${path}`, { details: { path } })
  }
  return parsed as Record<string, unknown>
}

function writeConfigFile(path: string, contents: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
  const ordered: Record<string, unknown> = {}
  for (const key of CONFIG_KEYS) {
    if (key in contents) ordered[key] = contents[key]
  }
  // Preserve unknown keys rather than dropping them: a newer ponscli may have
  // written a key this build does not know about, and silently discarding it on
  // the next `config set` would be data loss.
  for (const key of Object.keys(contents)) {
    if (!(key in ordered)) ordered[key] = contents[key]
  }
  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`, { mode: FILE_MODE })
}

/**
 * Resolve every key through the precedence ladder: flag > env > file > default.
 *
 * `overrides` carries values that came from command-line flags. A key absent
 * from it, or present as `undefined`, does not count as a flag: that is the
 * difference between "the user did not pass `--rpc`" and "the user passed an
 * empty `--rpc`", and only the latter should override the environment.
 */
export function resolveConfig(
  overrides: Partial<Record<ConfigKey, unknown>> = {},
  context: ResolveContext = defaultContext(),
): ResolvedConfig {
  const filePath = configFilePath(context.env, context.home)
  const fileExists = existsSync(filePath)
  const fromFile = readConfigFile(filePath)

  const values: Record<string, unknown> = {}
  const sources = {} as Record<ConfigKey, ConfigSource>

  for (const key of CONFIG_KEYS) {
    const spec = specOf(key)

    const flagValue = overrides[key]
    if (flagValue !== undefined) {
      values[key] = spec.coerce(flagValue, key)
      sources[key] = 'flag'
      continue
    }

    const envValue = context.env[spec.env]
    if (envValue !== undefined && envValue !== '') {
      values[key] = spec.parse(envValue, key)
      sources[key] = 'env'
      continue
    }

    if (Object.prototype.hasOwnProperty.call(fromFile, key)) {
      values[key] = spec.coerce(fromFile[key], key)
      sources[key] = 'file'
      continue
    }

    values[key] = spec.fallback(context)
    sources[key] = 'default'
  }

  return { values: values as unknown as PonsConfig, sources, filePath, fileExists }
}

export function assertConfigKey(key: string): ConfigKey {
  if (isConfigKey(key)) return key
  throw new ConfigError(`unknown config key: ${key}`, {
    details: { key, known: CONFIG_KEYS },
    hint: "run 'pons config list' to see every key",
  })
}

/** Write one key to the config file. Returns the value as it was stored. */
export function setConfigValue(
  key: ConfigKey,
  raw: string,
  context: ResolveContext = defaultContext(),
): unknown {
  const parsed = specOf(key).parse(raw, key)
  const path = configFilePath(context.env, context.home)
  const contents = readConfigFile(path)
  contents[key] = parsed
  writeConfigFile(path, contents)
  return parsed
}

/** Remove one key from the config file. Returns whether it was present. */
export function unsetConfigValue(
  key: ConfigKey,
  context: ResolveContext = defaultContext(),
): boolean {
  const path = configFilePath(context.env, context.home)
  const contents = readConfigFile(path)
  if (!Object.prototype.hasOwnProperty.call(contents, key)) return false
  delete contents[key]
  writeConfigFile(path, contents)
  return true
}

/**
 * Render a value for display, masking secrets.
 *
 * Enough of a secret is shown to tell two keys apart without disclosing either.
 * Short secrets are masked entirely, since a prefix and suffix of a short
 * string is most of the string.
 */
export function displayValue(key: ConfigKey, value: unknown): string {
  const spec = specOf(key)
  const formatted = spec.format(value)
  if (formatted === '') return ''
  if (spec.secret !== true) return formatted
  return formatted.length > 12 ? `${formatted.slice(0, 4)}...${formatted.slice(-4)}` : '********'
}
