import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createServer } from './mcp/server.js'

/**
 * Binary entry point for `pons-mcp`.
 *
 * stdio is the transport, which makes stdout the JSON-RPC channel: anything
 * written there that is not a protocol message desynchronises the client's
 * parser. Nothing in this process may `console.log`. The RPC layer's warnings
 * are routed to stderr in `mcp/context.ts` for the same reason, and errors
 * below go there too.
 */
const server = createServer()

await server.connect(new StdioServerTransport())

process.on('uncaughtException', (error: Error) => {
  process.stderr.write(`pons-mcp: ${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
