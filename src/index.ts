/**
 * Library entry point.
 *
 * Both command layers — `pons` and `pons-mcp` — are thin shells over these
 * modules, so anything importable here is usable from a script without going
 * through argv or a transport.
 *
 * The two generations are exported as namespaces rather than flattened. They
 * genuinely have the same functions with the same names and different meanings:
 * `v2.spotPrice` reads a bonding curve's reserves and `v1.spotPrice` reads a
 * Uniswap V3 pool's `sqrtPriceX96`. Flattening them would force one of the two
 * to be renamed, and a renamed `spotPrice` is worse to read than a qualified
 * one.
 */
export * as v1 from './core/adapters/v1.js'
export * as v1Launch from './core/adapters/v1launch.js'
export * as v1Trade from './core/adapters/v1trade.js'
export * as v2 from './core/adapters/v2.js'
export * as v2Launch from './core/adapters/v2launch.js'
export * as v2Trade from './core/adapters/v2trade.js'

export * from './abi/index.js'
export * from './chain/definition.js'
export * from './chain/addresses.js'
export * from './config/index.js'
export * from './core/adapters/detect.js'
export * from './core/amount.js'
export * from './core/events.js'
export * from './core/index/scanner.js'
export * from './core/index/store.js'
export * from './core/pairs.js'
export * from './core/plan.js'
export * from './core/quote.js'
export * from './core/receipt.js'
export * from './core/revert.js'
export * from './core/routes/v3.js'
export * from './core/routes/v4.js'
export * from './core/routes/v4trade.js'
export * from './core/simulate.js'
export * from './core/units.js'
export * from './errors.js'
export * from './output/index.js'
export * from './wallet/keystore.js'
export * from './wallet/signer.js'
export { VERSION, PACKAGE_NAME, BINARY_NAME } from './version.js'
export type { CommandContext } from './context.js'

/**
 * The MCP server, for embedding it in another process.
 *
 * Exported as a factory rather than started: `pons-mcp` connects it to stdio,
 * and a host that wants it on a different transport should not have to fork a
 * binary to get one.
 */
export { createServer as createMcpServer } from './mcp/server.js'
export { createMcpContext, type McpContext, type McpContextOptions } from './mcp/context.js'
