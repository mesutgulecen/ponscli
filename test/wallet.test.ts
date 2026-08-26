import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'

import { parseAmountSpec, resolveAmount } from '../src/core/amount.js'
import { createPlan, planId, shortPlanId } from '../src/core/plan.js'
import { ExitCode, PonsError } from '../src/errors.js'
import {
  decryptKeystore,
  encryptPrivateKey,
  readKeystoreFile,
  writeKeystoreFile,
} from '../src/wallet/keystore.js'

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const ADDRESS = privateKeyToAccount(KEY).address
const PASSWORD = 'correct horse battery staple'

let directory: string | undefined

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function temp(): string {
  directory ??= mkdtempSync(join(tmpdir(), 'ponscli-wallet-'))
  return directory
}

describe('keystore', () => {
  it('round-trips a key through scrypt and AES-256-GCM', async () => {
    const keystore = await encryptPrivateKey(KEY, PASSWORD)
    expect(keystore.address).toBe(ADDRESS)
    expect(keystore.crypto.cipher).toBe('aes-256-gcm')
    expect(await decryptKeystore(keystore, PASSWORD)).toBe(KEY)
  })

  it('never stores the key in the clear', async () => {
    const keystore = await encryptPrivateKey(KEY, PASSWORD)
    expect(JSON.stringify(keystore)).not.toContain(KEY.slice(2))
  })

  it('rejects a wrong password on the authentication tag', async () => {
    // GCM authenticates, so the plaintext is never produced at all — unlike a
    // v3 keystore, which decrypts first and compares a MAC afterwards.
    const keystore = await encryptPrivateKey(KEY, PASSWORD)
    await expect(decryptKeystore(keystore, 'wrong')).rejects.toMatchObject({
      code: 'WALLET_BAD_PASSWORD',
      exitCode: ExitCode.Wallet,
    })
  })

  it('rejects a keystore whose address was edited', async () => {
    // The address is cleartext, so anyone can rewrite it. Signing as an
    // unexpected account is worse than failing to sign.
    const keystore = await encryptPrivateKey(KEY, PASSWORD)
    const tampered = { ...keystore, address: '0x000000000000000000000000000000000000dEaD' as const }
    await expect(decryptKeystore(tampered, PASSWORD)).rejects.toMatchObject({
      code: 'WALLET_ADDRESS_MISMATCH',
    })
  })

  it('detects a tampered ciphertext', async () => {
    const keystore = await encryptPrivateKey(KEY, PASSWORD)
    const flipped = keystore.crypto.ciphertext.replace(/^../, '00')
    const tampered = { ...keystore, crypto: { ...keystore.crypto, ciphertext: flipped } }
    await expect(decryptKeystore(tampered, PASSWORD)).rejects.toThrow(PonsError)
  })

  it('refuses an empty password', async () => {
    await expect(encryptPrivateKey(KEY, '')).rejects.toMatchObject({ code: 'WALLET_EMPTY_PASSWORD' })
  })

  it('refuses a key that is not one', async () => {
    await expect(encryptPrivateKey('0x1234', PASSWORD)).rejects.toMatchObject({
      code: 'WALLET_INVALID_KEY',
    })
  })

  it('writes the file readable only by its owner', async () => {
    const path = join(temp(), 'keystore.json')
    writeKeystoreFile(path, await encryptPrivateKey(KEY, PASSWORD))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readKeystoreFile(path).address).toBe(ADDRESS)
  })

  it('will not overwrite an existing keystore without being told to', async () => {
    const path = join(temp(), 'keystore.json')
    const keystore = await encryptPrivateKey(KEY, PASSWORD)
    writeKeystoreFile(path, keystore)
    expect(() => writeKeystoreFile(path, keystore)).toThrow(PonsError)
    // There is no undo for replacing a key file, and the mistake stays silent
    // until somebody needs the old key.
    expect(() => writeKeystoreFile(path, keystore, { force: true })).not.toThrow()
  })

  it('names a file that is not a keystore', () => {
    const path = join(temp(), 'not-a-keystore.json')
    writeFileSync(path, '{"hello":"world"}')
    expect(() => readKeystoreFile(path)).toThrow(PonsError)
  })

  it('records the kdf parameters it used', async () => {
    // A stored keystore has to stay readable if the default cost ever moves.
    const keystore = await encryptPrivateKey(KEY, PASSWORD)
    expect(keystore.crypto.kdfparams.n).toBeGreaterThanOrEqual(65_536)
    const path = join(temp(), 'keystore.json')
    writeKeystoreFile(path, keystore)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof keystore
    expect(parsed.crypto.kdfparams).toEqual(keystore.crypto.kdfparams)
  })
})

describe('parseAmountSpec', () => {
  it('parses a decimal into base units', () => {
    expect(parseAmountSpec('0.05', 18)).toMatchObject({ kind: 'absolute', value: 50_000_000_000_000_000n })
  })

  it('respects the asset decimals', () => {
    // USDG is 6-decimal, and treating it as 18 misprices by a factor of 1e12.
    expect(parseAmountSpec('1', 6).value).toBe(1_000_000n)
  })

  it('reads a percentage without resolving it', () => {
    const spec = parseAmountSpec('50%', 18)
    expect(spec).toMatchObject({ kind: 'percent', bps: 5_000n })
    expect(resolveAmount(spec, 1_000n)).toBe(500n)
  })

  it("treats 'all' and 100% as the whole balance", () => {
    expect(resolveAmount(parseAmountSpec('all', 18), 777n)).toBe(777n)
    expect(resolveAmount(parseAmountSpec('100%', 18), 777n)).toBe(777n)
  })

  it('rejects nonsense before a request goes out', () => {
    expect(() => parseAmountSpec('lots', 18)).toThrow()
    expect(() => parseAmountSpec('-1', 18)).toThrow()
    expect(() => parseAmountSpec('0', 18)).toThrow()
    expect(() => parseAmountSpec('150%', 18)).toThrow()
  })
})

describe('planId', () => {
  const base = {
    kind: 'buy' as const,
    to: '0x60CeF8379Aa278F087074bC60595778985c1bD8E' as const,
    data: '0xdeadbeef' as const,
    value: 1n,
    gasLimit: undefined,
  }

  it('is the same for two plans that send the same bytes', () => {
    expect(planId(base)).toBe(planId({ ...base }))
  })

  it('changes when anything on the wire changes', () => {
    expect(planId({ ...base, value: 2n })).not.toBe(planId(base))
    expect(planId({ ...base, data: '0xdeadbeee' })).not.toBe(planId(base))
    expect(planId({ ...base, kind: 'sell' })).not.toBe(planId(base))
  })

  it('ignores the prose that describes the plan', () => {
    // Two plans that differ only in their summary are the same transaction.
    const first = createPlan({ ...base, route: 'curve', summary: 'one', warnings: [], economics: {} })
    const second = createPlan({ ...base, route: 'curve', summary: 'two', warnings: [], economics: {} })
    expect(first.id).toBe(second.id)
    expect(shortPlanId(first.id)).toHaveLength(10)
  })
})
