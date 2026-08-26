import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_RPC_ENDPOINTS,
  configFilePath,
  displayValue,
  resolveConfig,
  setConfigValue,
  unsetConfigValue,
  assertConfigKey,
} from '../src/config/index.js'
import { ConfigError } from '../src/errors.js'
import { createTempHome, type TempHome } from './helpers.js'

let temp: TempHome | undefined

afterEach(() => {
  temp?.cleanup()
  temp = undefined
})

function context(extraEnv: NodeJS.ProcessEnv = {}, isTTY = false) {
  temp = createTempHome(extraEnv)
  return { env: temp.env, home: temp.home, isTTY }
}

function seedFile(ctx: ReturnType<typeof context>, contents: Record<string, unknown>): string {
  const path = configFilePath(ctx.env, ctx.home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(contents, null, 2))
  return path
}

describe('precedence ladder', () => {
  it('falls back to defaults when nothing is set', () => {
    const ctx = context()
    const { values, sources } = resolveConfig({}, ctx)
    expect(values['rpc.endpoints']).toEqual(DEFAULT_RPC_ENDPOINTS)
    expect(values['rpc.tier']).toBe('auto')
    expect(sources['rpc.tier']).toBe('default')
  })

  it('prefers the file over the default', () => {
    const ctx = context()
    seedFile(ctx, { 'rpc.tier': '2' })
    const { values, sources } = resolveConfig({}, ctx)
    expect(values['rpc.tier']).toBe('2')
    expect(sources['rpc.tier']).toBe('file')
  })

  it('prefers the environment over the file', () => {
    const ctx = context({ PONS_RPC_TIER: '1' })
    seedFile(ctx, { 'rpc.tier': '2' })
    const { values, sources } = resolveConfig({}, ctx)
    expect(values['rpc.tier']).toBe('1')
    expect(sources['rpc.tier']).toBe('env')
  })

  it('prefers a flag over the environment', () => {
    const ctx = context({ PONS_RPC_TIER: '1' })
    seedFile(ctx, { 'rpc.tier': '2' })
    const { values, sources } = resolveConfig({ 'rpc.tier': 'auto' }, ctx)
    expect(values['rpc.tier']).toBe('auto')
    expect(sources['rpc.tier']).toBe('flag')
  })

  it('treats an empty environment variable as unset', () => {
    // An exported-but-empty variable is a common shell accident. Honouring it
    // would silently blank a value the user set deliberately in the file.
    const ctx = context({ PONS_RPC_TIER: '' })
    seedFile(ctx, { 'rpc.tier': '2' })
    const { values, sources } = resolveConfig({}, ctx)
    expect(values['rpc.tier']).toBe('2')
    expect(sources['rpc.tier']).toBe('file')
  })

  it('derives output.json from whether stdout is a TTY', () => {
    expect(resolveConfig({}, context({}, true)).values['output.json']).toBe(false)
    temp?.cleanup()
    temp = undefined
    expect(resolveConfig({}, context({}, false)).values['output.json']).toBe(true)
  })
})

describe('validation', () => {
  it('rejects a non-http rpc url', () => {
    const ctx = context({ PONS_RPC_URL: 'ftp://example.com' })
    expect(() => resolveConfig({}, ctx)).toThrow(ConfigError)
  })

  it('rejects slippage outside the basis-point range', () => {
    const ctx = context({ PONS_SLIPPAGE_BPS: '10001' })
    expect(() => resolveConfig({}, ctx)).toThrow(/between 0 and 10000/)
  })

  it('rejects an unknown tier', () => {
    const ctx = context({ PONS_RPC_TIER: '3' })
    expect(() => resolveConfig({}, ctx)).toThrow(/auto/)
  })

  it('parses a comma-separated endpoint list from the environment', () => {
    const ctx = context({ PONS_RPC_ENDPOINTS: 'https://a.example, https://b.example' })
    expect(resolveConfig({}, ctx).values['rpc.endpoints']).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('rejects a malformed config file rather than falling back to defaults', () => {
    const ctx = context()
    const path = configFilePath(ctx.env, ctx.home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ not json')
    expect(() => resolveConfig({}, ctx)).toThrow(/not valid JSON/)
  })

  it('rejects an unknown key by name', () => {
    expect(() => assertConfigKey('rpc.nope')).toThrow(/unknown config key/)
  })
})

describe('writing', () => {
  it('creates the file owner-only', () => {
    const ctx = context()
    setConfigValue('rpc.tier', '2', ctx)
    const path = configFilePath(ctx.env, ctx.home)
    // A file that may hold an API key must not be group- or world-readable.
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('round-trips through the file', () => {
    const ctx = context()
    setConfigValue('trade.slippageBps', '250', ctx)
    expect(resolveConfig({}, ctx).values['trade.slippageBps']).toBe(250)
    expect(unsetConfigValue('trade.slippageBps', ctx)).toBe(true)
    expect(resolveConfig({}, ctx).values['trade.slippageBps']).toBe(100)
  })

  it('reports an unset key as not removed', () => {
    const ctx = context()
    expect(unsetConfigValue('trade.slippageBps', ctx)).toBe(false)
  })

  it('preserves keys it does not recognise', () => {
    // A config written by a newer build must survive an older one editing it.
    const ctx = context()
    seedFile(ctx, { 'future.key': 'keep me' })
    setConfigValue('rpc.tier', '2', ctx)
    const written = JSON.parse(readFileSync(configFilePath(ctx.env, ctx.home), 'utf8')) as Record<
      string,
      unknown
    >
    expect(written['future.key']).toBe('keep me')
    expect(written['rpc.tier']).toBe('2')
  })

  it('rejects an invalid value before touching the file', () => {
    const ctx = context()
    expect(() => setConfigValue('rpc.url', 'not-a-url', ctx)).toThrow(ConfigError)
    expect(resolveConfig({}, ctx).fileExists).toBe(false)
  })
})

describe('secret handling', () => {
  it('masks a long key but keeps it distinguishable', () => {
    expect(displayValue('rpc.alchemyKey', 'abcd1234efgh5678')).toBe('abcd...5678')
  })

  it('masks a short key entirely', () => {
    expect(displayValue('rpc.alchemyKey', 'short')).toBe('********')
  })

  it('does not mask a non-secret', () => {
    expect(displayValue('rpc.tier', 'auto')).toBe('auto')
  })
})
