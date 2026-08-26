import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_DIR = 'ponscli'

/**
 * Resolve the XDG base directories.
 *
 * The XDG variables are honoured on every platform, not just Linux. A user who
 * sets `XDG_CONFIG_HOME` has said where configuration belongs, and macOS users
 * running a dotfile setup routinely do. Falling back to `~/.config` rather than
 * `~/Library/Application Support` keeps a single documented path.
 */
export function configHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const xdg = env['XDG_CONFIG_HOME']
  return xdg !== undefined && xdg !== '' ? xdg : join(home, '.config')
}

export function cacheHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const xdg = env['XDG_CACHE_HOME']
  return xdg !== undefined && xdg !== '' ? xdg : join(home, '.cache')
}

export function configDir(env?: NodeJS.ProcessEnv, home?: string): string {
  return join(configHome(env, home), APP_DIR)
}

export function configFilePath(env?: NodeJS.ProcessEnv, home?: string): string {
  return join(configDir(env, home), 'config.json')
}

export function defaultCacheDir(env?: NodeJS.ProcessEnv, home?: string): string {
  return join(cacheHome(env, home), APP_DIR)
}

export function defaultKeystorePath(env?: NodeJS.ProcessEnv, home?: string): string {
  return join(configDir(env, home), 'keystore.json')
}
