import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { configFilePath } from '../src/config/index.js'
import { ExitCode } from '../src/errors.js'
import { run } from '../src/program.js'
import { VERSION } from '../src/version.js'
import { PASSWORD_ENV } from '../src/wallet/prompt.js'
import { BufferSink, createTempHome, type TempHome } from './helpers.js'

let temp: TempHome | undefined

afterEach(() => {
  temp?.cleanup()
  temp = undefined
})

interface Invocation {
  code: number
  stdout: BufferSink
  stderr: BufferSink
}

async function invoke(argv: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Invocation> {
  temp ??= createTempHome(extraEnv)
  const stdout = new BufferSink()
  const stderr = new BufferSink()
  const code = await run({
    argv,
    env: { ...temp.env, ...extraEnv },
    home: temp.home,
    isTTY: false,
    stdout,
    stderr,
  })
  return { code, stdout, stderr }
}

describe('pons --version', () => {
  it('prints the package version', async () => {
    const { code, stdout } = await invoke(['--version', '--human'])
    expect(code).toBe(ExitCode.Ok)
    expect(stdout.text.trim()).toBe(VERSION)
  })

  it('answers even when the config file is unreadable', async () => {
    // The moment somebody runs `--version` is often the moment their config is
    // broken; it must not need the config to work.
    temp = createTempHome()
    const path = configFilePath(temp.env, temp.home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'not json at all')
    const { code, stdout } = await invoke(['--version', '--json'])
    expect(code).toBe(ExitCode.Ok)
    expect(stdout.json()).toEqual({ name: 'ponscli', version: VERSION })
  })
})

describe('pons config list', () => {
  it('is the default subcommand', async () => {
    const { code, stdout } = await invoke(['config', '--json'])
    expect(code).toBe(ExitCode.Ok)
    expect(stdout.json<{ entries: unknown[] }>().entries.length).toBeGreaterThan(0)
  })

  it('reports where each value came from', async () => {
    const { stdout } = await invoke(['config', 'list', '--json', '--rpc-tier', '2'], {
      PONS_SLIPPAGE_BPS: '250',
    })
    const entries = stdout.json<{ entries: { key: string; source: string; value: unknown }[] }>()
      .entries
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    expect(byKey.get('rpc.tier')?.source).toBe('flag')
    expect(byKey.get('trade.slippageBps')?.source).toBe('env')
    expect(byKey.get('rpc.timeoutMs')?.source).toBe('default')
  })

  it('renders an unset value as null rather than dropping the key', async () => {
    const { stdout } = await invoke(['config', 'list', '--json'])
    const entries = stdout.json<{ entries: { key: string; value: unknown }[] }>().entries
    const urlEntry = entries.find((entry) => entry.key === 'rpc.url')
    expect(urlEntry).toBeDefined()
    expect(urlEntry?.value).toBeNull()
  })

  it('masks a secret in the listing but not in get', async () => {
    await invoke(['config', 'set', 'rpc.alchemyKey', 'abcd1234efgh5678', '--json'])
    const list = await invoke(['config', 'list', '--json'])
    const entry = list.stdout
      .json<{ entries: { key: string; display: string }[] }>()
      .entries.find((candidate) => candidate.key === 'rpc.alchemyKey')
    expect(entry?.display).toBe('abcd...5678')

    const got = await invoke(['config', 'get', 'rpc.alchemyKey', '--human'])
    expect(got.stdout.text.trim()).toBe('abcd1234efgh5678')
  })

  it('names the environment-only variables, without their values', async () => {
    const { stdout } = await invoke(['config', 'list', '--json'])
    const payload = stdout.json<{ envOnly: { name: string; describe: string }[] }>()
    const names = payload.envOnly.map((entry) => entry.name)
    // `config list` is where somebody looks for "what can I set". Leaving these
    // out is how a flag for them gets invented; printing their values is how a
    // password reaches a terminal somebody is sharing.
    expect(names).toContain('PONS_PASSWORD')
    expect(names).toContain('PONS_PRIVATE_KEY')
    expect(JSON.stringify(payload.envOnly)).not.toContain('value')
  })

  it('names the password variable the wallet actually reads', async () => {
    // It was documented as PONS_KEYSTORE_PASSWORD and read as PONS_PASSWORD,
    // so anybody following the CLI's own listing got a prompt instead.
    const { stdout } = await invoke(['config', 'list', '--json'])
    const names = stdout
      .json<{ envOnly: { name: string }[] }>()
      .envOnly.map((entry) => entry.name)
    expect(names).toContain(PASSWORD_ENV)
  })
})

describe('global flag placement', () => {
  it('accepts a global flag after the subcommand', async () => {
    const { code, stdout } = await invoke(['config', 'path', '--json'])
    expect(code).toBe(ExitCode.Ok)
    expect(stdout.json<{ path: string }>().path).toMatch(/config\.json$/)
  })

  it('accepts a global flag before the subcommand', async () => {
    const { code, stdout } = await invoke(['--json', 'config', 'path'])
    expect(code).toBe(ExitCode.Ok)
    expect(stdout.json<{ path: string }>().path).toMatch(/config\.json$/)
  })
})

describe('exit codes', () => {
  it('returns Usage for an unknown command', async () => {
    const { code, stderr } = await invoke(['frobnicate', '--json'])
    expect(code).toBe(ExitCode.Usage)
    expect(stderr.json<{ error: { code: string } }>().error.code).toBe('USAGE')
  })

  it('does not leak the parser name into the error code', async () => {
    const { stderr } = await invoke(['frobnicate', '--json'])
    const error = stderr.json<{ error: { code: string; details?: { parser?: string } } }>().error
    expect(error.code).not.toMatch(/^commander\./)
    expect(error.details?.parser).toBe('commander.unknownCommand')
  })

  it('returns Config for an unknown config key', async () => {
    const { code, stderr } = await invoke(['config', 'get', 'rpc.nope', '--json'])
    expect(code).toBe(ExitCode.Config)
    expect(stderr.json<{ error: { code: string } }>().error.code).toBe('CONFIG')
  })

  it('returns Config for a value outside its allowed range', async () => {
    const { code } = await invoke(['config', 'set', 'trade.slippageBps', '99999', '--json'])
    expect(code).toBe(ExitCode.Config)
  })

  it('returns Usage when --json and --human contradict', async () => {
    const { code, stderr } = await invoke(['config', 'list', '--json', '--human'])
    expect(code).toBe(ExitCode.Usage)
    expect(stderr.text).toContain('contradict')
  })

  it('returns Ok for --help', async () => {
    const { code, stdout } = await invoke(['--help'])
    expect(code).toBe(ExitCode.Ok)
    expect(stdout.text).toContain('config')
  })
})

/**
 * Both of these were broken until the first-contact pass, and both were broken
 * in the way that is hardest to notice: the root command was configured
 * correctly, so everything looked right until somebody typed a subcommand.
 */
describe('no command given', () => {
  it('reports a usage error rather than printing nothing', async () => {
    const { code, stdout, stderr } = await invoke([])
    // Was: zero bytes on both streams, exit 0.
    expect(code).toBe(ExitCode.Usage)
    expect(stdout.text).toBe('')
    expect(stderr.json<{ error: { code: string } }>().error.code).toBe('USAGE')
  })

  it('prints the help to stdout for a human', async () => {
    const { code, stdout, stderr } = await invoke(['--human'])
    expect(code).toBe(ExitCode.Usage)
    // The help is the result of the invocation here, so it belongs on stdout —
    // it used to go to stderr, where a redirect would lose it.
    expect(stdout.text).toContain('Usage: pons')
    expect(stderr.text).toBe('')
  })

  it('still treats an explicit --help as a success', async () => {
    const { code } = await invoke(['--help'])
    expect(code).toBe(ExitCode.Ok)
  })

  it('counts global flags as no command', async () => {
    // `--rpc` takes a value, and the value must not be mistaken for a command.
    const { code, stderr } = await invoke(['--rpc', 'https://node.example'])
    expect(code).toBe(ExitCode.Usage)
    expect(stderr.json<{ error: { message: string } }>().error.message).toBe('no command given')
  })
})

describe('argument errors on subcommands', () => {
  interface UsageError {
    error: {
      code: string
      message: string
      hint: string
      details?: { parser?: string; command?: string; usage?: string }
    }
  }

  it('routes through the error taxonomy instead of commander', async () => {
    const { code, stdout, stderr } = await invoke(['info'])
    // Was: commander's raw prose on stderr and `process.exit(1)`, bypassing
    // `run` entirely — no envelope, and the wrong code for a bad argument.
    expect(code).toBe(ExitCode.Usage)
    expect(stdout.text).toBe('')
    const payload = stderr.json<UsageError>()
    expect(payload.error.code).toBe('USAGE')
    expect(payload.error.message).toBe("missing required argument 'token'")
  })

  it('quotes the usage line of the command that failed', async () => {
    const { stderr } = await invoke(['info'])
    const { error } = stderr.json<UsageError>()
    // Carried so an agent can correct itself from the failure alone, rather
    // than spending a second invocation on `--help`.
    expect(error.details?.command).toBe('info')
    expect(error.details?.usage).toBe('pons info [options] <token>')
    expect(error.hint).toBe("run 'pons info --help'")
  })

  it('names a nested subcommand by its full path', async () => {
    const { code, stderr } = await invoke(['wallet', 'transfer'])
    expect(code).toBe(ExitCode.Usage)
    const { error } = stderr.json<UsageError>()
    expect(error.details?.usage).toBe('pons wallet transfer [options] <to> <amount>')
    expect(error.hint).toBe("run 'pons wallet transfer --help'")
  })

  it('leaves an unknown command pointing at the top-level help', async () => {
    const { code, stderr } = await invoke(['frobnicate'])
    expect(code).toBe(ExitCode.Usage)
    const { error } = stderr.json<UsageError>()
    expect(error.details?.parser).toBe('commander.unknownCommand')
    // No command owns this failure, so there is no usage line to quote.
    expect(error.details?.usage).toBeUndefined()
    expect(error.hint).toBe("run 'pons --help' for the command list")
  })
})

describe('json mode selection', () => {
  it('defaults to json when stdout is not a TTY', async () => {
    const { stdout } = await invoke(['config', 'path'])
    expect(() => stdout.json()).not.toThrow()
  })

  it('honours --human when piped', async () => {
    const { stdout } = await invoke(['config', 'path', '--human'])
    expect(() => stdout.json()).toThrow()
  })

  it('honours PONS_JSON=0 when piped', async () => {
    const { stdout } = await invoke(['config', 'path'], { PONS_JSON: '0' })
    expect(() => stdout.json()).toThrow()
  })
})

describe('config set feedback', () => {
  it('warns that an environment variable still outranks the stored value', async () => {
    const { code, stderr } = await invoke(['config', 'set', 'rpc.tier', '2', '--json'], {
      PONS_RPC_TIER: '1',
    })
    expect(code).toBe(ExitCode.Ok)
    expect(stderr.text).toContain('PONS_RPC_TIER')
  })

  it('says nothing extra when the stored value takes effect', async () => {
    const { code, stderr } = await invoke(['config', 'set', 'rpc.tier', '2', '--json'])
    expect(code).toBe(ExitCode.Ok)
    expect(stderr.text).toBe('')
  })
})
