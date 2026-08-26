import { serializeError } from '../errors.js'
import { createPainter, shouldColorize, type ColorMode, type Painter } from './color.js'
import { stringify } from './json.js'

export type { ColorMode, Painter } from './color.js'
export { renderTable, type Column } from './table.js'
export {
  formatAge,
  formatAmount,
  formatBps,
  formatDuration,
  formatRatio,
  formatToken,
  shortAddress,
} from './format.js'
export { jsonReplacer, stringify } from './json.js'

/** Minimal surface of a writable stream, so tests can substitute a buffer. */
export interface Sink {
  write(chunk: string): unknown
}

export interface ReporterOptions {
  json: boolean
  color: ColorMode
  /** Pretty-print JSON. Off when piped, so a consumer gets one object per line. */
  pretty?: boolean
  stdout?: Sink
  stderr?: Sink
  env?: NodeJS.ProcessEnv
  isTTY?: boolean
}

/**
 * The single writer for everything the CLI says.
 *
 * Commands never call `console.log`. They hand the reporter a structured
 * payload plus a function that renders it for a human, and the reporter picks
 * one. This keeps the two representations from drifting apart, which is what
 * happens when `--json` is added to a command after the fact.
 *
 * Channel discipline: results go to stdout, everything else to stderr. A caller
 * doing `pons info X --json | jq` must never find a warning in the pipe.
 */
export class Reporter {
  readonly json: boolean
  readonly paint: Painter
  private readonly pretty: boolean
  private readonly stdout: Sink
  private readonly stderr: Sink

  constructor(options: ReporterOptions) {
    const env = options.env ?? process.env
    const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY)
    this.json = options.json
    this.pretty = options.pretty ?? isTTY
    this.stdout = options.stdout ?? process.stdout
    this.stderr = options.stderr ?? process.stderr
    this.paint = createPainter(shouldColorize(options.color, env, isTTY))
  }

  /** Emit a command's result. Exactly one call per command invocation. */
  emit<T>(payload: T, renderHuman: (payload: T, paint: Painter) => string): void {
    const text = this.json ? stringify(payload, this.pretty) : renderHuman(payload, this.paint)
    this.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  }

  /** A condition the user should know about that does not stop the command. */
  warn(message: string, details?: Record<string, unknown>): void {
    if (this.json) {
      this.stderr.write(`${stringify({ level: 'warn', message, ...details }, false)}\n`)
      return
    }
    this.stderr.write(`${this.paint('yellow', 'warning')} ${message}\n`)
  }

  /** Human-only commentary. Suppressed entirely in JSON mode. */
  note(message: string): void {
    if (this.json) return
    this.stderr.write(`${this.paint('grey', message)}\n`)
  }

  /** Report a failure. The caller owns the exit code. */
  fail(error: unknown): void {
    const serialized = serializeError(error)
    if (this.json) {
      this.stderr.write(`${stringify(serialized, this.pretty)}\n`)
      return
    }
    const { code, message, hint } = serialized.error
    this.stderr.write(`${this.paint('red', 'error')} ${this.paint('dim', `[${code}]`)} ${message}\n`)
    if (hint !== undefined) {
      this.stderr.write(`  ${this.paint('cyan', 'hint')} ${hint}\n`)
    }
  }
}
