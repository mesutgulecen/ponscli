/**
 * Process exit codes.
 *
 * These are part of the CLI's contract with scripts and agents: a caller must
 * be able to distinguish "you asked for something impossible" from "the network
 * is down" without parsing prose. Never renumber an existing code.
 */
export const ExitCode = {
  Ok: 0,
  /** Unclassified failure. */
  Failure: 1,
  /** Bad flags, bad arguments, unknown command. */
  Usage: 2,
  /** Configuration is missing, malformed, or contradictory. */
  Config: 3,
  /** Every RPC endpoint failed, or the request could not be dispatched. */
  Network: 4,
  /** The chain answered, and the answer was a revert. */
  Revert: 5,
  /** Keystore missing, wrong password, or signing refused. */
  Wallet: 6,
  /** The user declined a confirmation prompt, or sent SIGINT. */
  Aborted: 7,
  /** The account cannot pay for what was asked. Not a revert: fund it. */
  Funds: 8,
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

/**
 * An error the CLI raised deliberately and can explain.
 *
 * Anything thrown that is not a `PonsError` is a bug in the CLI, and is
 * reported as such rather than being dressed up as a user-facing message.
 */
export class PonsError extends Error {
  readonly code: string
  readonly exitCode: ExitCodeValue
  /** Machine-readable context, emitted verbatim in `--json` mode. */
  readonly details: Record<string, unknown>
  /** A concrete next step for the user, when one exists. */
  readonly hint: string | undefined

  constructor(
    code: string,
    message: string,
    options: {
      exitCode?: ExitCodeValue
      details?: Record<string, unknown>
      hint?: string
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PonsError'
    this.code = code
    this.exitCode = options.exitCode ?? ExitCode.Failure
    this.details = options.details ?? {}
    this.hint = options.hint
  }
}

export class UsageError extends PonsError {
  constructor(message: string, options: { hint?: string; details?: Record<string, unknown> } = {}) {
    super('USAGE', message, { ...options, exitCode: ExitCode.Usage })
    this.name = 'UsageError'
  }
}

export class ConfigError extends PonsError {
  constructor(message: string, options: { hint?: string; details?: Record<string, unknown> } = {}) {
    super('CONFIG', message, { ...options, exitCode: ExitCode.Config })
    this.name = 'ConfigError'
  }
}

/**
 * Raised when Tier 1 is exhausted and no paid Tier 2 credential is configured.
 *
 * This is a valid configuration, not a misconfiguration: it means bulk work
 * degrades instead of silently converting an outage into an invoice.
 */
export class NoPaidFallbackError extends PonsError {
  constructor(details: Record<string, unknown> = {}) {
    super('NO_PAID_FALLBACK', 'every free endpoint failed and no paid fallback is configured', {
      exitCode: ExitCode.Network,
      details,
      hint: 'set rpc.alchemyKey (PONS_ALCHEMY_KEY) to enable the paid tier, or retry later',
    })
    this.name = 'NoPaidFallbackError'
  }
}

/** Shape of the JSON written to stderr when a command fails in `--json` mode. */
export interface SerializedError {
  ok: false
  error: {
    code: string
    message: string
    hint?: string
    details?: Record<string, unknown>
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof PonsError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
      },
    }
  }
  return {
    ok: false,
    error: {
      code: 'INTERNAL',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

export function exitCodeOf(error: unknown): ExitCodeValue {
  return error instanceof PonsError ? error.exitCode : ExitCode.Failure
}
