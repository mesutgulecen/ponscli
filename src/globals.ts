import type { Command } from 'commander'

import { UsageError } from './errors.js'
import type { ConfigKey } from './config/index.js'

interface GlobalFlag {
  /** The long form as typed, without a value. */
  flag: string
  /** commander's option string, including any value placeholder. */
  spec: string
  describe: string
  /** True when the flag consumes the following argv entry. */
  takesValue: boolean
  /** commander's camelCase key on the options object. */
  optionKey: string
}

/**
 * Options accepted by every command.
 *
 * Each one maps onto a configuration key, which is what makes `pons config
 * list` able to report `source: flag` rather than having flags shadow the
 * config silently.
 */
export const GLOBAL_FLAGS: readonly GlobalFlag[] = [
  {
    flag: '--json',
    spec: '--json',
    describe: 'Machine-readable output (default when stdout is not a TTY)',
    takesValue: false,
    optionKey: 'json',
  },
  {
    flag: '--human',
    spec: '--human',
    describe: 'Force human-readable output even when piped',
    takesValue: false,
    optionKey: 'human',
  },
  {
    flag: '--color',
    spec: '--color <mode>',
    describe: "ANSI colour: auto, always or never",
    takesValue: true,
    optionKey: 'color',
  },
  {
    flag: '--rpc',
    spec: '--rpc <url>',
    describe: 'Your own RPC node, tried before the shared free endpoints',
    takesValue: true,
    optionKey: 'rpc',
  },
  {
    flag: '--rpc-tier',
    spec: '--rpc-tier <tier>',
    describe: 'Pin the waterfall to a tier: auto, 1 or 2',
    takesValue: true,
    optionKey: 'rpcTier',
  },
  {
    flag: '--timeout',
    spec: '--timeout <ms>',
    describe: 'Per-request RPC timeout in milliseconds',
    takesValue: true,
    optionKey: 'timeout',
  },
  {
    flag: '--keystore',
    spec: '--keystore <path>',
    describe: 'Path to the encrypted keystore',
    takesValue: true,
    optionKey: 'keystore',
  },
  {
    flag: '--slippage',
    spec: '--slippage <bps>',
    describe: 'Slippage tolerance in basis points (100 = 1%)',
    takesValue: true,
    optionKey: 'slippage',
  },
  {
    flag: '--priority-fee',
    spec: '--priority-fee <gwei>',
    describe: 'EIP-1559 maxPriorityFeePerGas in gwei',
    takesValue: true,
    optionKey: 'priorityFee',
  },
  {
    flag: '--cache-dir',
    spec: '--cache-dir <path>',
    describe: 'Directory for cached immutable chain data',
    takesValue: true,
    optionKey: 'cacheDir',
  },
]

export function registerGlobalFlags(program: Command): Command {
  for (const global of GLOBAL_FLAGS) program.option(global.spec, global.describe)
  return program
}

const BY_FLAG = new Map(GLOBAL_FLAGS.map((global) => [global.flag, global]))

/**
 * Move global flags ahead of the subcommand name.
 *
 * commander only recognises an option on the command that declared it, so
 * `pons config list --json` would otherwise fail as an unknown option while
 * `pons --json config list` worked. Requiring the second form is a poor fit for
 * this CLI: agents compose arguments left to right and append `--json` last.
 *
 * Hoisting is limited to the flags declared above, stops at `--`, and carries a
 * flag's value along with it, so nothing else about argv order changes.
 */
export interface SplitArgv {
  /** Global flags, with their values, moved to the front. */
  hoisted: string[]
  /**
   * Everything else, in order.
   *
   * Empty means no command was given: global flags are the only tokens that can
   * precede a command name, so `pons`, `pons --json` and `pons --rpc <url>` all
   * leave nothing here, while `pons frobnicate` leaves the word commander needs
   * in order to complain about it.
   */
  rest: string[]
}

export function splitGlobalFlags(argv: readonly string[]): SplitArgv {
  const hoisted: string[] = []
  const rest: string[] = []
  let passthrough = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string

    if (passthrough) {
      rest.push(token)
      continue
    }
    if (token === '--') {
      passthrough = true
      rest.push(token)
      continue
    }

    // `--rpc=https://...` carries its own value and needs no lookahead.
    const equalsAt = token.indexOf('=')
    const bare = equalsAt === -1 ? token : token.slice(0, equalsAt)
    const global = BY_FLAG.get(bare)
    if (global === undefined) {
      rest.push(token)
      continue
    }

    if (equalsAt !== -1 || !global.takesValue) {
      hoisted.push(token)
      continue
    }

    const value = argv[index + 1]
    if (value === undefined) {
      // Let commander produce its own "option requires argument" message
      // rather than inventing a second phrasing for the same mistake.
      hoisted.push(token)
      continue
    }
    hoisted.push(token, value)
    index += 1
  }

  return { hoisted, rest }
}

export function hoistGlobalFlags(argv: readonly string[]): string[] {
  const { hoisted, rest } = splitGlobalFlags(argv)
  return [...hoisted, ...rest]
}

export interface GlobalOptions {
  json?: boolean
  human?: boolean
  color?: string
  rpc?: string
  rpcTier?: string
  timeout?: string
  keystore?: string
  slippage?: string
  priorityFee?: string
  cacheDir?: string
}

/**
 * Translate parsed global options into configuration overrides.
 *
 * Only keys the user actually passed appear in the result: an absent key must
 * fall through to the environment, not overwrite it with `undefined`.
 */
export function overridesFrom(options: GlobalOptions): Partial<Record<ConfigKey, unknown>> {
  if (options.json === true && options.human === true) {
    throw new UsageError('--json and --human contradict each other', {
      hint: 'pass one or neither; without either, output follows whether stdout is a TTY',
    })
  }

  const overrides: Partial<Record<ConfigKey, unknown>> = {}
  if (options.json === true) overrides['output.json'] = true
  if (options.human === true) overrides['output.json'] = false
  if (options.color !== undefined) overrides['output.color'] = options.color
  if (options.rpc !== undefined) overrides['rpc.url'] = options.rpc
  if (options.rpcTier !== undefined) overrides['rpc.tier'] = options.rpcTier
  if (options.timeout !== undefined) overrides['rpc.timeoutMs'] = options.timeout
  if (options.keystore !== undefined) overrides['wallet.keystore'] = options.keystore
  if (options.slippage !== undefined) overrides['trade.slippageBps'] = options.slippage
  if (options.priorityFee !== undefined) overrides['trade.priorityFeeGwei'] = options.priorityFee
  if (options.cacheDir !== undefined) overrides['cache.dir'] = options.cacheDir
  return overrides
}
