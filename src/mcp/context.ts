import { homedir } from 'node:os'

import type { Dispatch } from '../chain/pool.js'
import { createRpc, type Rpc } from '../chain/transport.js'
import { defaultContext, resolveConfig, type ResolvedConfig } from '../config/index.js'
import { IndexStore } from '../core/index/store.js'

/**
 * What the MCP server shares across tool calls.
 *
 * The same configuration ladder the CLI resolves, flag > env > file > default,
 * minus the flags since a server has no argv, and one RPC pool for the whole
 * process. Building the pool once matters more here than in the CLI: a server
 * lives for hours and would otherwise reset every endpoint's health, park and
 * counter on each tool call, throwing away exactly the knowledge the waterfall
 * exists to accumulate.
 */
export interface McpContext {
  config: ResolvedConfig
  rpc: () => Rpc
  store: IndexStore
}

export interface McpContextOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  /** Replaces the wire layer. A test seam; nothing in production supplies it. */
  dispatch?: Dispatch
}

export function createMcpContext(options: McpContextOptions = {}): McpContext {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const resolveContext = defaultContext({ env, home, isTTY: false })
  const config = resolveConfig({}, resolveContext)

  let rpc: Rpc | undefined
  return {
    config,
    rpc: () => {
      rpc ??= createRpc(config.values, {
        // Warnings would otherwise reach stdout, which on a stdio transport is
        // the JSON-RPC channel itself: one stray line and the client's parser
        // desynchronises. Everything conversational goes to stderr.
        onWarn: (message) => process.stderr.write(`${message}\n`),
        ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
      })
      return rpc
    },
    store: new IndexStore({ chainId: 4663, dir: config.values['cache.dir'] }),
  }
}
