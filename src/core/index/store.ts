import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { defaultCacheDir } from '../../config/paths.js'

/**
 * The scanner's cache on disk.
 *
 * A scan of the whole history is a few seconds of somebody's time; repeating
 * it on every invocation of `pons pairs` is a few seconds they should not have
 * to spend twice. What is stored is a cursor and a fold, not an archive: the
 * approved pair token list is 23 entries and `watch` keeps one block number.
 *
 * **Not SQLite, despite the architecture doc.** `node:sqlite` does not exist
 * before Node 22.5 and prints an experimental warning to stderr on the 22.x
 * line, which would appear in the middle of the CLI's own output; the
 * alternative, `better-sqlite3`, is a native module that has to compile at
 * install time. Both are a heavy price for a few kilobytes of JSON, and
 * neither buys anything a file cannot do at this size. The interface below is
 * narrow enough that a real database can replace it if a command ever needs to
 * hold a table of logs.
 */

/** Bumped when a stored shape changes, so an old file is discarded, not read. */
const SCHEMA_VERSION = 1

interface Envelope<T> {
  version: number
  chainId: number
  /** Unix seconds. Only for a human reading the file or an age display. */
  updatedAt: number
  value: T
}

export interface CacheOptions {
  /** Explicit directory. Overrides the XDG lookup below. */
  dir?: string
  chainId: number
  /**
   * Where the XDG lookup reads from, when no directory is given.
   *
   * Commands pass `dir` from the resolved `cache.dir`, which already went
   * through the flag > env > file > default ladder. These exist for a direct
   * construction that has not: taking `process.env` implicitly is how a test
   * with its own home directory ends up sharing the developer's real cache and
   * reading entries no fixture ever wrote.
   */
  env?: NodeJS.ProcessEnv
  home?: string
  /** Frozen clock for tests. */
  now?: () => number
}

export class IndexStore {
  private readonly dir: string
  private readonly chainId: number
  private readonly now: () => number

  constructor(options: CacheOptions) {
    this.dir = options.dir ?? defaultCacheDir(options.env, options.home)
    this.chainId = options.chainId
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  path(name: string): string {
    return join(this.dir, `${name}.json`)
  }

  /**
   * Read one entry, or undefined.
   *
   * Every failure returns undefined rather than raising. A cache is an
   * optimisation, and a corrupt one must degrade into a slower command rather
   * than a broken one — the caller's fallback is to scan, which always works.
   */
  read<T>(name: string): { value: T; updatedAt: number } | undefined {
    let raw: string
    try {
      raw = readFileSync(this.path(name), 'utf8')
    } catch {
      return undefined
    }
    try {
      const envelope = JSON.parse(raw) as Envelope<T>
      if (envelope.version !== SCHEMA_VERSION) return undefined
      if (envelope.chainId !== this.chainId) return undefined
      return { value: envelope.value, updatedAt: envelope.updatedAt }
    } catch {
      return undefined
    }
  }

  /**
   * Write one entry.
   *
   * Through a temporary file and a rename, which is atomic within a directory
   * on every platform this runs on. Two `pons watch` processes writing the
   * same cursor must leave one of the two cursors behind, never half of each.
   * A write that fails is swallowed for the same reason a read is: a read-only
   * cache directory should slow the CLI down, not stop it.
   */
  write<T>(name: string, value: T): void {
    const envelope: Envelope<T> = {
      version: SCHEMA_VERSION,
      chainId: this.chainId,
      updatedAt: this.now(),
      value,
    }
    const target = this.path(name)
    const temporary = `${target}.${String(process.pid)}.tmp`
    try {
      // Owner-only, like the config directory. The cache decides which asset a
      // launch is quoted in, so it is not the inert scratch space the name
      // suggests.
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, target)
    } catch {
      // Ignored on purpose. See above.
    }
  }
}
