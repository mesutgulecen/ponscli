import { readFileSync } from 'node:fs'

interface PackageManifest {
  name?: string
  version?: string
}

/**
 * Read the package version at runtime.
 *
 * Both `src/cli.ts` in development and `dist/cli.js` after bundling sit one
 * directory below the package root, so the same relative path resolves in
 * either. Reading it beats baking the version in at build time, which produces
 * a `dist/` that disagrees with `package.json` whenever the two are versioned
 * separately.
 */
function readManifest(): PackageManifest {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return JSON.parse(raw) as PackageManifest
  } catch {
    return {}
  }
}

const manifest = readManifest()

export const PACKAGE_NAME = manifest.name ?? 'ponscli'
export const VERSION = manifest.version ?? '0.0.0-unknown'
/** The name the binary is invoked as, used in help text and hints. */
export const BINARY_NAME = 'pons'
