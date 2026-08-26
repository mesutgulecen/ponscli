import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { privateKeyToAccount } from 'viem/accounts'
import { isHex, type Address, type Hex } from 'viem'

import { ExitCode, PonsError } from '../errors.js'

const scrypt = promisify(scryptCallback)

/**
 * An encrypted private key on disk.
 *
 * scrypt for the key derivation and AES-256-GCM for the encryption. GCM is
 * authenticated, so the format carries no separate MAC: a wrong password fails
 * the tag check and the plaintext is never produced, where a v3 keystore
 * decrypts first and compares a keccak MAC afterwards.
 *
 * This is deliberately **not** EIP-2335. That standard describes BLS keys for
 * the consensus layer and specifies aes-128-ctr; it does not apply to a
 * secp256k1 signing key, and claiming compatibility with it would invite
 * somebody to feed this file to a tool that cannot read it. The envelope is
 * versioned instead, so a future format change is detectable.
 */

export const KEYSTORE_VERSION = 1

/**
 * scrypt cost. N = 2^17 puts one derivation at roughly a second and 128 MB.
 *
 * geth's "standard" 2^18 is stronger and takes four times the memory; this
 * runs on a laptop next to a browser, and the difference for an attacker is
 * one bit. Recorded in the file so a stored keystore stays readable if the
 * default ever moves.
 */
const SCRYPT_N = 131_072
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32
/** scrypt needs about 128 · N · r bytes; Node's default cap is far below it. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024

export interface KeystoreFile {
  version: number
  id: string
  address: Address
  crypto: {
    kdf: 'scrypt'
    kdfparams: { n: number; r: number; p: number; dklen: number; salt: string }
    cipher: 'aes-256-gcm'
    cipherparams: { iv: string; tag: string }
    ciphertext: string
  }
  createdAt: string
}

async function deriveKey(password: string, salt: Buffer, params = { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dklen: KEY_LENGTH }): Promise<Buffer> {
  // `promisify` picks the three-argument overload, so the options object is
  // reattached through a cast rather than being silently dropped, because losing it
  // would derive a different key with Node's default cost.
  const derive = scrypt as (
    password: string,
    salt: Buffer,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
  ) => Promise<Buffer>
  return derive(password.normalize('NFKC'), salt, params.dklen, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  })
}

function assertPrivateKey(privateKey: string): asserts privateKey is Hex {
  if (!isHex(privateKey) || privateKey.length !== 66) {
    throw new PonsError('WALLET_INVALID_KEY', 'a private key is 0x followed by 64 hexadecimal characters', {
      exitCode: ExitCode.Wallet,
    })
  }
}

export async function encryptPrivateKey(privateKey: string, password: string): Promise<KeystoreFile> {
  assertPrivateKey(privateKey)
  if (password.length === 0) {
    throw new PonsError('WALLET_EMPTY_PASSWORD', 'refusing to write a keystore with an empty password', {
      exitCode: ExitCode.Wallet,
      hint: 'an unprotected key belongs in an environment variable, not in a file that looks encrypted',
    })
  }

  const salt = randomBytes(32)
  const key = await deriveKey(password, salt)
  // 12 bytes is the GCM nonce size the mode is specified for; a 16-byte IV is
  // hashed down internally and buys nothing.
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey.slice(2), 'hex')),
    cipher.final(),
  ])

  return {
    version: KEYSTORE_VERSION,
    id: randomUUID(),
    address: privateKeyToAccount(privateKey).address,
    crypto: {
      kdf: 'scrypt',
      kdfparams: { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dklen: KEY_LENGTH, salt: salt.toString('hex') },
      cipher: 'aes-256-gcm',
      cipherparams: { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') },
      ciphertext: ciphertext.toString('hex'),
    },
    createdAt: new Date().toISOString(),
  }
}

export async function decryptKeystore(keystore: KeystoreFile, password: string): Promise<Hex> {
  if (keystore.version !== KEYSTORE_VERSION) {
    throw new PonsError('WALLET_UNKNOWN_FORMAT', `keystore version ${String(keystore.version)} is not supported`, {
      exitCode: ExitCode.Wallet,
      hint: `this build writes and reads version ${String(KEYSTORE_VERSION)}`,
    })
  }
  const { kdfparams, cipherparams, ciphertext } = keystore.crypto
  const key = await deriveKey(password, Buffer.from(kdfparams.salt, 'hex'), {
    n: kdfparams.n,
    r: kdfparams.r,
    p: kdfparams.p,
    dklen: kdfparams.dklen,
  })

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(cipherparams.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(cipherparams.tag, 'hex'))
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()])
  } catch {
    // GCM cannot tell a wrong password from a tampered file, and neither can
    // we. Saying "wrong password" is right almost always and harmless when it
    // is not; saying "corrupt" would send the user hunting for a backup.
    throw new PonsError('WALLET_BAD_PASSWORD', 'the password did not decrypt this keystore', {
      exitCode: ExitCode.Wallet,
      hint: 'the file is authenticated, so an edited keystore fails the same way',
    })
  }

  const privateKey: Hex = `0x${plaintext.toString('hex')}`
  const derived = privateKeyToAccount(privateKey).address
  // The address is stored in cleartext, so an attacker who cannot decrypt the
  // file can still rewrite that field. Checking it here means a mismatch is
  // reported rather than the CLI happily signing as an unexpected account.
  const stored = Buffer.from(String(keystore.address).toLowerCase())
  const expected = Buffer.from(derived.toLowerCase())
  // `timingSafeEqual` throws on unequal lengths rather than returning false, so
  // the length is compared first. `readKeystoreFile` already rejects a
  // wrong-shaped address; this keeps `decryptKeystore` safe on its own.
  if (stored.length !== expected.length || !timingSafeEqual(expected, stored)) {
    throw new PonsError('WALLET_ADDRESS_MISMATCH', 'the keystore names an address its key does not produce', {
      exitCode: ExitCode.Wallet,
      details: { stored: keystore.address, derived },
    })
  }
  return privateKey
}

export function readKeystoreFile(path: string): KeystoreFile {
  if (!existsSync(path)) {
    throw new PonsError('WALLET_NOT_FOUND', `no keystore at ${path}`, {
      exitCode: ExitCode.Wallet,
      details: { path },
      hint: "run 'pons wallet create' or point --keystore at an existing file",
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new PonsError('WALLET_UNREADABLE', `${path} is not valid JSON`, {
      exitCode: ExitCode.Wallet,
      details: { path },
    })
  }
  const keystore = parsed as KeystoreFile
  const complaint = describeMalformed(keystore)
  if (complaint !== undefined) {
    throw new PonsError('WALLET_UNREADABLE', `${path} is not a usable ponscli keystore: ${complaint}`, {
      exitCode: ExitCode.Wallet,
      details: { path },
      hint: 'a truncated or edited file fails here rather than deeper in the crypto',
    })
  }
  return keystore
}

/**
 * Why a parsed keystore cannot be used, or undefined if it can.
 *
 * Every field below reaches a crypto primitive that raises its own error on bad
 * input, and those errors are unreadable: a truncated `address` surfaces as
 * `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`, an `address` that is a number as
 * `TypeError: keystore.address.toLowerCase is not a function`, a wrong `dklen`
 * as `ERR_CRYPTO_INVALID_KEYLEN`. None of them tells somebody with a
 * half-written file what is wrong with it, which is the realistic way to arrive
 * here is an interrupted write, not an attacker.
 */
function describeMalformed(keystore: KeystoreFile | undefined): string | undefined {
  if (keystore === undefined || typeof keystore !== 'object') return 'not an object'
  const { address, crypto } = keystore
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return 'the address field is not a 20-byte hex address'
  }
  if (crypto === undefined || typeof crypto !== 'object') return 'the crypto section is missing'
  if (!isHexString(crypto.ciphertext)) return 'the ciphertext is not hex'
  if (!isHexString(crypto.cipherparams?.iv)) return 'the iv is not hex'
  if (!isHexString(crypto.cipherparams?.tag)) return 'the authentication tag is not hex'
  if (!isHexString(crypto.kdfparams?.salt)) return 'the salt is not hex'

  const { n, r, p, dklen } = crypto.kdfparams ?? {}
  // Bounds, not equality: a keystore written under a different cost has to stay
  // readable, which is why the parameters are stored at all.
  if (!isPositiveInteger(n) || n > SCRYPT_N_CEILING || (n & (n - 1)) !== 0) {
    return 'the scrypt cost is not a power of two within the supported range'
  }
  if (!isPositiveInteger(r) || r > 32) return 'the scrypt block size is out of range'
  if (!isPositiveInteger(p) || p > 16) return 'the scrypt parallelism is out of range'
  if (dklen !== KEY_LENGTH) return `the derived key length must be ${String(KEY_LENGTH)} for aes-256`
  return undefined
}

/** Upper bound on a stored scrypt cost. Above this `maxmem` refuses anyway. */
const SCRYPT_N_CEILING = 1_048_576

function isHexString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && /^[0-9a-fA-F]+$/.test(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Write a keystore, refusing to overwrite one that already exists.
 *
 * There is no undo for replacing a key file, and the mistake is silent until
 * the moment somebody needs the old key. The mode is set before the content is
 * written, so the plaintext window where the file is world-readable never
 * exists.
 */
export function writeKeystoreFile(path: string, keystore: KeystoreFile, options: { force?: boolean } = {}): void {
  if (existsSync(path) && options.force !== true) {
    throw new PonsError('WALLET_EXISTS', `${path} already holds a keystore`, {
      exitCode: ExitCode.Wallet,
      details: { path, address: keystore.address },
      hint: 'move it aside, or pass --keystore to write somewhere else',
    })
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(keystore, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}
