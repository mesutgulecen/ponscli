import type { Rpc } from './chain/transport.js'
import type { ResolvedConfig, ResolveContext } from './config/index.js'
import type { Reporter } from './output/index.js'

/**
 * Everything a command needs that it did not receive as an argument.
 *
 * Commands take this rather than reaching for `process.env` or constructing
 * their own client, which is what makes them testable without a subprocess.
 */
export interface CommandContext {
  config: ResolvedConfig
  resolveContext: ResolveContext
  reporter: Reporter
  /**
   * The RPC pool and viem client, built on first use.
   *
   * Lazy because most of the surface is offline: `config`, `--version` and
   * `--help` must not assemble a network stack, and a broken endpoint list
   * should fail the command that needs the network rather than every command.
   */
  rpc: () => Rpc
}
