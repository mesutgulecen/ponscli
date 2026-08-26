import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Sink } from '../src/output/index.js'

/**
 * An isolated home directory for one test.
 *
 * Config resolution reads real paths, so tests get a real directory rather than
 * a mocked filesystem — that way the permission bits and the XDG lookup are
 * exercised too, not just the code around them.
 */
export interface TempHome {
  home: string
  env: NodeJS.ProcessEnv
  cleanup: () => void
}

export function createTempHome(extraEnv: NodeJS.ProcessEnv = {}): TempHome {
  const home = mkdtempSync(join(tmpdir(), 'ponscli-test-'))
  return {
    home,
    env: {
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      // Keep the ambient environment out: a developer with PONS_RPC_URL
      // exported would otherwise see different results than CI.
      ...extraEnv,
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

/** A `Sink` that accumulates everything written to it. */
export class BufferSink implements Sink {
  private chunks: string[] = []

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }

  get text(): string {
    return this.chunks.join('')
  }

  get lines(): string[] {
    return this.text.split('\n').filter((line) => line !== '')
  }

  json<T = unknown>(): T {
    return JSON.parse(this.text) as T
  }

  reset(): void {
    this.chunks = []
  }
}
