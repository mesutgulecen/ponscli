import { run } from './program.js'

/**
 * Quietly accept a closed pipe.
 *
 * `pons pairs | head` closes stdout while we are still writing, and Node's
 * default is an unhandled 'error' event: a stack trace on the user's terminal
 * for a command that did exactly what they asked. Downstream closing the pipe
 * is a normal end to the conversation, so it exits zero.
 */
function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
    throw error
  })
}

ignoreBrokenPipe(process.stdout)
ignoreBrokenPipe(process.stderr)

/**
 * Binary entry point.
 *
 * Its only responsibilities are turning `process.argv` into a run and turning
 * the returned code into an exit. Everything testable lives in `run`.
 */
const exitCode = await run({ argv: process.argv.slice(2) })

// Assign rather than calling `process.exit`, so buffered stdout is flushed
// before the process ends. `process.exit` truncates a piped write.
process.exitCode = exitCode
