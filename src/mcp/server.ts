import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { PACKAGE_NAME, VERSION } from '../version.js'
import { createMcpContext, type McpContext } from './context.js'
import { registerTools } from './tools.js'

/**
 * `pons-mcp`: the same core, addressed by a model instead of a terminal.
 *
 * A second binary from the same package rather than a separate project. Every
 * tool calls straight into `core/`, which never knew about commander or the
 * reporter, so this is a wrapper and not a reimplementation: the pricing an
 * agent sees is the pricing `pons buy` prints, because it is the same function.
 *
 * The one thing this binary deliberately cannot do is sign. See `tools.ts`.
 */
export function createServer(context: McpContext = createMcpContext()): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: VERSION },
    {
      instructions: [
        'Pons is a token launchpad on Robinhood Chain (chain id 4663). These tools are',
        'an unofficial third-party client for it, not affiliated with Pons or Robinhood.',
        'Two generations exist and every tool detects which one a token belongs to:',
        'V2 tokens trade on a bonding curve until they graduate to a Uniswap V4 pool;',
        'V1 tokens trade on a Uniswap V3 pool and V1 is closed to new launches.',
        '',
        'These tools read the chain and build unsigned transactions. None of them signs',
        'or broadcasts anything, and there is no tool that will: a plan is returned as',
        'calldata for a person to send. Amounts are base units, so apply the `decimals`',
        'each tool reports before showing a number to anybody.',
      ].join('\n'),
    },
  )
  registerTools(server, context)
  return server
}
