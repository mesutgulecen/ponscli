import { describe, expect, it } from 'vitest'

import { hoistGlobalFlags, overridesFrom } from '../src/globals.js'
import { UsageError } from '../src/errors.js'

describe('hoistGlobalFlags', () => {
  it('leaves an already-leading flag alone', () => {
    expect(hoistGlobalFlags(['--json', 'config', 'list'])).toEqual(['--json', 'config', 'list'])
  })

  it('moves a trailing flag to the front', () => {
    expect(hoistGlobalFlags(['config', 'list', '--json'])).toEqual(['--json', 'config', 'list'])
  })

  it('carries a flag value along with the flag', () => {
    expect(hoistGlobalFlags(['config', 'list', '--rpc', 'https://n.example'])).toEqual([
      '--rpc',
      'https://n.example',
      'config',
      'list',
    ])
  })

  it('handles the --flag=value form without lookahead', () => {
    expect(hoistGlobalFlags(['config', 'list', '--rpc=https://n.example'])).toEqual([
      '--rpc=https://n.example',
      'config',
      'list',
    ])
  })

  it('preserves the relative order of the remaining arguments', () => {
    expect(hoistGlobalFlags(['config', 'set', 'rpc.tier', '2', '--human'])).toEqual([
      '--human',
      'config',
      'set',
      'rpc.tier',
      '2',
    ])
  })

  it('does not hoist a command-specific flag', () => {
    expect(hoistGlobalFlags(['launch', '--dry-run', '--json'])).toEqual([
      '--json',
      'launch',
      '--dry-run',
    ])
  })

  it('stops at the passthrough separator', () => {
    // Everything after `--` belongs to whatever the command forwards it to.
    expect(hoistGlobalFlags(['run', '--', '--json'])).toEqual(['run', '--', '--json'])
  })

  it('does not swallow a value that looks like the next flag', () => {
    // A value-taking flag at the end of argv is left in place so commander
    // produces its own "option requires argument" message.
    expect(hoistGlobalFlags(['config', 'list', '--rpc'])).toEqual(['--rpc', 'config', 'list'])
  })

  it('leaves a value that happens to equal a flag name attached to its flag', () => {
    expect(hoistGlobalFlags(['config', 'set', 'rpc.url', '--json'])).toEqual([
      '--json',
      'config',
      'set',
      'rpc.url',
    ])
  })
})

describe('overridesFrom', () => {
  it('omits keys the user did not pass', () => {
    expect(overridesFrom({})).toEqual({})
  })

  it('maps flags onto config keys', () => {
    expect(overridesFrom({ rpc: 'https://n.example', slippage: '50' })).toEqual({
      'rpc.url': 'https://n.example',
      'trade.slippageBps': '50',
    })
  })

  it('maps --human to the negation of --json', () => {
    expect(overridesFrom({ human: true })).toEqual({ 'output.json': false })
  })

  it('rejects --json together with --human', () => {
    expect(() => overridesFrom({ json: true, human: true })).toThrow(UsageError)
  })
})
