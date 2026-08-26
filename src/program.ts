import { Command, CommanderError } from 'commander'
import { homedir } from 'node:os'

import type { Dispatch } from './chain/pool.js'
import { createRpc, type Rpc } from './chain/transport.js'
import { createConfigCommand } from './commands/config.js'
import { createDoctorCommand } from './commands/doctor.js'
import { createInfoCommand } from './commands/info.js'
import { createLaunchCommand } from './commands/launch.js'
import { createPairsCommand } from './commands/pairs.js'
import { createWatchCommand } from './commands/watch.js'
import {
  createClaimCommand,
  createCollectCommand,
  createGraduateCommand,
  createVaultCommand,
} from './commands/lifecycle.js'
import { createBuyCommand, createSellCommand } from './commands/trade.js'
import { createTxCommand } from './commands/tx.js'
import { createWalletCommand } from './commands/wallet.js'
import { defaultContext, resolveConfig } from './config/index.js'
import type { CommandContext } from './context.js'
import { ExitCode, PonsError, UsageError, exitCodeOf, type ExitCodeValue } from './errors.js'
import { GLOBAL_FLAGS, overridesFrom, registerGlobalFlags, splitGlobalFlags } from './globals.js'
import { Reporter, type Sink } from './output/index.js'
import { BINARY_NAME, PACKAGE_NAME, VERSION } from './version.js'

export interface RunOptions {
  /** Arguments after the node binary and script path. */
  argv: readonly string[]
  env?: NodeJS.ProcessEnv
  home?: string
  isTTY?: boolean
  stdout?: Sink
  stderr?: Sink
  /**
   * Replaces the wire layer. A test seam: it exists so the command surface can
   * be exercised end to end without a network, and nothing in production
   * supplies it.
   */
  dispatch?: Dispatch
}

/**
 * commander error codes that mean "the user asked for output and got it".
 * These are a successful run, not a failure.
 */
const INFORMATIONAL = new Set(['commander.helpDisplayed', 'commander.help', 'commander.version'])

/**
 * Give every command in the tree our error handling, not just the root.
 *
 * `exitOverride` and `configureOutput` apply to the command they are called on.
 * A command added with `addCommand` inherits neither, so before this every
 * argument mistake on every subcommand, `pons info` with no token or `pons buy`
 * with one, printed commander's own prose to stderr and called
 * `process.exit(1)` on the spot: no JSON envelope, no exit code from our
 * taxonomy, and no chance for `run` to catch it. The root looked correct
 * because the root is the one place that was configured.
 *
 * The thrown error is tagged with the command it came from, which is what lets
 * the handler name the command and quote its usage line back.
 */
function applyErrorHandling(command: Command, write: { out: Sink; err: Sink }, jsonMode: boolean): void {
  command.exitOverride((error) => {
    throw Object.assign(error, { ponsCommand: command })
  })
  // A human who mistyped a subcommand gets a pointer rather than the whole
  // help: the root prints its full help after an error because the command
  // list is the thing they are missing, but somebody who already reached
  // `pons wallet transfer` only needs its arguments.
  if (!jsonMode && command.parent !== null) {
    command.showHelpAfterError(`(run '${commandPath(command)} --help' for usage)`)
  }
  command.configureOutput({
    writeOut: (text) => void write.out.write(text),
    // In JSON mode commander's own prose would land on stderr beside our
    // structured error, giving a consumer two representations of one failure.
    // Swallowed; the message survives on the CommanderError we catch.
    writeErr: (text) => {
      if (!jsonMode) write.err.write(text)
    },
  })
  for (const child of command.commands) applyErrorHandling(child, write, jsonMode)
}

/** `pons wallet transfer`: how the failing command is invoked. */
function commandPath(command: Command): string {
  const path: string[] = []
  let current: Command | null = command
  while (current !== null) {
    path.unshift(current.name())
    current = current.parent
  }
  return path.join(' ')
}

/** `pons info [options] <token>`: the usage line for whichever command failed. */
function usageOf(command: Command): string {
  return `${commandPath(command)} ${command.usage()}`.trim()
}

const USAGE_CODES = new Set([
  'commander.unknownCommand',
  'commander.unknownOption',
  'commander.missingArgument',
  'commander.optionMissingArgument',
  'commander.excessArguments',
  'commander.invalidArgument',
  'commander.missingMandatoryOptionValue',
  'commander.conflictingOption',
])

/**
 * Decide the output mode before any configuration has been read.
 *
 * `--version` and usage errors must behave sensibly even when the config file
 * is unreadable, so this deliberately looks only at argv, the environment and
 * the terminal: the three things that cannot fail.
 */
function earlyJsonMode(argv: readonly string[], env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (argv.includes('--human')) return false
  if (argv.includes('--json')) return true
  const fromEnv = env['PONS_JSON']
  if (fromEnv !== undefined && fromEnv !== '') {
    return !['0', 'false', 'no', 'off'].includes(fromEnv.trim().toLowerCase())
  }
  return !isTTY
}

function buildProgram(getContext: () => CommandContext, jsonMode: boolean): Command {
  const program = new Command(BINARY_NAME)
    .description('Command-line interface for the Pons launchpad on Robinhood Chain')
    .option('-V, --version', 'Print the version and exit')
    // A full help dump after an error helps a person and only bloats the
    // structured record an agent parses. The suggestion ("did you mean ...")
    // lands inside the message itself, so both audiences keep it.
    .showHelpAfterError(!jsonMode)
    .showSuggestionAfterError()

  registerGlobalFlags(program)
  program.addHelpText(
    'after',
    `\nGlobal options may appear anywhere on the line.\nEnvironment: ${GLOBAL_FLAGS.length} flags map onto config keys; run '${BINARY_NAME} config list' to see them.`,
  )

  program.addCommand(createConfigCommand(getContext))
  program.addCommand(createDoctorCommand(getContext))
  program.addCommand(createInfoCommand(getContext))
  program.addCommand(createPairsCommand(getContext))
  program.addCommand(createWatchCommand(getContext))
  program.addCommand(createTxCommand(getContext))
  program.addCommand(createBuyCommand(getContext))
  program.addCommand(createSellCommand(getContext))
  program.addCommand(createLaunchCommand(getContext))
  program.addCommand(createGraduateCommand(getContext))
  program.addCommand(createClaimCommand(getContext))
  program.addCommand(createCollectCommand(getContext))
  program.addCommand(createVaultCommand(getContext))
  program.addCommand(createWalletCommand(getContext))

  return program
}

/**
 * Execute one CLI invocation and return its process exit code.
 *
 * Nothing here calls `process.exit`, and every stream is injectable, so the
 * whole surface is exercisable from a test without spawning a subprocess.
 */
export async function run(options: RunOptions): Promise<ExitCodeValue> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY)
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const { hoisted, rest } = splitGlobalFlags(options.argv)
  const argv = [...hoisted, ...rest]

  const jsonHint = earlyJsonMode(argv, env, isTTY)
  const bootstrapReporter = new Reporter({
    json: jsonHint,
    color: 'auto',
    stdout,
    stderr,
    env,
    isTTY,
  })

  // Answered before configuration is touched: `--version` has to work on a
  // machine whose config file is broken, which is exactly when someone runs it.
  if (argv.includes('--version') || argv.includes('-V')) {
    bootstrapReporter.emit(
      { name: PACKAGE_NAME, version: VERSION },
      (payload) => payload.version,
    )
    return ExitCode.Ok
  }

  let context: CommandContext | undefined
  const getContext = (): CommandContext => {
    if (context === undefined) {
      throw new PonsError('INTERNAL', 'command context was requested before it was built')
    }
    return context
  }

  const program = buildProgram(getContext, jsonHint)
  applyErrorHandling(program, { out: stdout, err: stderr }, jsonHint)

  // No command at all. Global flags are the only tokens that may precede one,
  // so an empty `rest` means the user typed `pons` and nothing else, which
  // used to print the help to stderr and exit 0, or in JSON mode print nothing
  // whatsoever. Both are the wrong answer to "you did not tell me what to do".
  if (rest.length === 0) {
    if (jsonHint) {
      bootstrapReporter.fail(
        new PonsError('USAGE', 'no command given', {
          exitCode: ExitCode.Usage,
          hint: `run '${BINARY_NAME} --help' for the command list`,
        }),
      )
    } else {
      // stdout, not stderr: the help is the result of the invocation here, and
      // a user redirecting stdout asked to keep it.
      stdout.write(program.helpInformation())
    }
    return ExitCode.Usage
  }

  program.hook('preAction', () => {
    const resolveContext = defaultContext({ env, home, isTTY })
    const config = resolveConfig(overridesFrom(program.opts()), resolveContext)
    const reporter = new Reporter({
      json: config.values['output.json'],
      color: config.values['output.color'],
      stdout,
      stderr,
      env,
      isTTY,
    })

    let rpc: Rpc | undefined
    context = {
      config,
      resolveContext,
      reporter,
      rpc: () => {
        // Built once per invocation and reused, so a command issuing several
        // requests keeps one view of endpoint health rather than resetting
        // every park and counter between calls.
        rpc ??= createRpc(config.values, {
          onWarn: (message) => reporter.warn(message),
          ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
        })
        return rpc
      },
    }
  })

  try {
    await program.parseAsync([...argv], { from: 'user' })
    return ExitCode.Ok
  } catch (error) {
    if (error instanceof CommanderError) {
      if (INFORMATIONAL.has(error.code)) return ExitCode.Ok
      const isUsage = USAGE_CODES.has(error.code)
      // Which command produced it, tagged on by `applyErrorHandling`. Without
      // it the hint can only point at the top-level help, which is the wrong
      // page when the mistake was in `pons wallet transfer`.
      const source = (error as CommanderError & { ponsCommand?: Command }).ponsCommand
      const isRoot = source === undefined || source === program
      if (jsonHint) {
        // Reported under our own error code rather than commander's, so a
        // consumer never has to know which argument parser we happen to use.
        // The parser's own code is kept as a detail for debugging.
        const reporter = context?.reporter ?? bootstrapReporter
        reporter.fail(
          new PonsError(isUsage ? 'USAGE' : 'CLI', error.message.replace(/^error: /, ''), {
            exitCode: isUsage ? ExitCode.Usage : ExitCode.Failure,
            details: {
              parser: error.code,
              // The usage line travels with the error so an agent can correct
              // itself from the failure alone, rather than spending a second
              // invocation on `--help` to learn what it should have written.
              ...(isRoot || source === undefined
                ? {}
                : { command: source.name(), usage: usageOf(source) }),
            },
            hint:
              isRoot || source === undefined
                ? `run '${BINARY_NAME} --help' for the command list`
                : `run '${commandPath(source)} --help'`,
          }),
        )
      }
      return isUsage ? ExitCode.Usage : ExitCode.Failure
    }

    const reporter = context?.reporter ?? bootstrapReporter
    reporter.fail(error)
    return exitCodeOf(error)
  }
}

export { buildProgram, UsageError }
