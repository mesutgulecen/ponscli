import { ExitCode, PonsError } from '../errors.js'

/**
 * Reading a password without putting it on the screen or in a shell history.
 *
 * Three sources, in the order a person expects: an explicit environment
 * variable for automation, then the terminal. There is deliberately no flag —
 * a `--password` on the command line lands in the shell history and in the
 * process table, where anyone on the machine can read it.
 */

export interface PromptIO {
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  env?: NodeJS.ProcessEnv
  isTTY?: boolean
}

export const PASSWORD_ENV = 'PONS_PASSWORD'

/**
 * Read one line with the terminal's echo turned off.
 *
 * Raw mode is restored in a `finally`, including on Ctrl-C: leaving a terminal
 * in raw mode with echo off is a broken shell, and the user's next command
 * would be invisible.
 */
function readHidden(prompt: string, input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw === true
    output.write(prompt)
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')

    let value = ''
    const restore = (): void => {
      input.setRawMode(wasRaw)
      input.pause()
      input.removeListener('data', onData)
      output.write('\n')
    }

    const onData = (chunk: string): void => {
      for (const character of chunk) {
        switch (character) {
          case '\r':
          case '\n':
          case '\u0004': // Ctrl-D
            restore()
            resolve(value)
            return
          case '\u0003': // Ctrl-C
            restore()
            reject(
              new PonsError('ABORTED', 'cancelled', {
                exitCode: ExitCode.Aborted,
              }),
            )
            return
          case '\u007f': // backspace
          case '\b':
            value = value.slice(0, -1)
            break
          default:
            // Ignore the rest of the C0 range: an arrow key arrives as an
            // escape sequence and would otherwise be typed into the password.
            if (character >= ' ') value += character
        }
      }
    }

    input.on('data', onData)
  })
}

export async function readPassword(prompt: string, io: PromptIO = {}): Promise<string> {
  const env = io.env ?? process.env
  const fromEnv = env[PASSWORD_ENV]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv

  const input = io.input ?? process.stdin
  const output = io.output ?? process.stderr
  const isTTY = io.isTTY ?? Boolean(input.isTTY)
  if (!isTTY) {
    throw new PonsError('WALLET_NO_PASSWORD', 'a password is needed and there is no terminal to ask on', {
      exitCode: ExitCode.Wallet,
      hint: `set ${PASSWORD_ENV} in the environment`,
    })
  }
  return readHidden(prompt, input, output)
}

/** Ask twice, so a typo in a new password is caught before it is unrecoverable. */
export async function readNewPassword(io: PromptIO = {}): Promise<string> {
  const env = io.env ?? process.env
  const fromEnv = env[PASSWORD_ENV]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv

  const first = await readPassword('Password for the new keystore: ', io)
  const second = await readPassword('Repeat it: ', io)
  if (first !== second) {
    throw new PonsError('WALLET_PASSWORD_MISMATCH', 'the two passwords did not match', {
      exitCode: ExitCode.Wallet,
    })
  }
  return first
}
