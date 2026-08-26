import { afterEach, describe, expect, it } from 'vitest'
import type { Address } from 'viem'

import { v2FactoryAbi } from '../src/abi/index.js'
import { addresses } from '../src/chain/addresses.js'
import type { Dispatch } from '../src/chain/pool.js'
import { ExitCode } from '../src/errors.js'
import { run } from '../src/program.js'
import { fakeChain } from './fakeChain.js'
import { BufferSink, createTempHome, type TempHome } from './helpers.js'

const FACTORY = addresses.v2Factory as Address

/**
 * The factory's live policy on 2026-08-25. `snipeTaxSeconds` is 3 here and 15
 * in the contract source: the value is owner-mutable and has been moved, which
 * is the reason this command reads it rather than printing a constant.
 */
function chainFor(configCount = 1): Dispatch {
  return fakeChain({
    answers: [
      { address: FACTORY, abi: v2FactoryAbi, functionName: 'launchEnabled', result: true },
      { address: FACTORY, abi: v2FactoryAbi, functionName: 'launchFee', result: 500_000_000_000_000n },
      { address: FACTORY, abi: v2FactoryAbi, functionName: 'maxCreatorTaxBps', result: 1000n },
      { address: FACTORY, abi: v2FactoryAbi, functionName: 'snipeTaxStartBps', result: 9900n },
      { address: FACTORY, abi: v2FactoryAbi, functionName: 'snipeTaxSeconds', result: 3n },
      {
        address: FACTORY,
        abi: v2FactoryAbi,
        functionName: 'launchConfigCount',
        result: BigInt(configCount),
      },
      {
        address: FACTORY,
        abi: v2FactoryAbi,
        functionName: 'getLaunchConfig',
        args: [0n],
        result: {
          supply: 10n ** 27n,
          curveFeeBps: 100n,
          phantomQuote: 1_680_000_000_000_000_000n,
          graduationThreshold: 4_200_000_000_000_000_000n,
          poolFee: 0,
          tickSpacing: 200,
          enabled: true,
        },
      },
    ],
  })
}

let temp: TempHome | undefined

afterEach(() => {
  temp?.cleanup()
  temp = undefined
})

async function invoke(
  argv: string[],
  dispatch: Dispatch,
): Promise<{ code: number; stdout: BufferSink; stderr: BufferSink }> {
  temp ??= createTempHome()
  const stdout = new BufferSink()
  const stderr = new BufferSink()
  const code = await run({ argv, env: temp.env, home: temp.home, isTTY: false, stdout, stderr, dispatch })
  return { code, stdout, stderr }
}

interface ListPayload {
  entries: { key: string }[]
  factory?: {
    launchEnabled: boolean
    launchFeeWei: string
    maxCreatorTaxBps: number
    snipeTaxSeconds: number
    configs: { id: number; curveFeeBps: number; tickSpacing: number; enabled: boolean }[]
  }
}

describe('pons config list --configs', () => {
  it('reads the launch policy from the chain, not from the source', async () => {
    const { code, stdout } = await invoke(['config', 'list', '--configs', '--json'], chainFor())
    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<ListPayload>()
    expect(payload.factory?.launchFeeWei).toBe('500000000000000')
    expect(payload.factory?.maxCreatorTaxBps).toBe(1000)
    // 3, not the 15 the contract declares.
    expect(payload.factory?.snipeTaxSeconds).toBe(3)
  })

  it('lists every config the factory holds', async () => {
    const { stdout } = await invoke(['config', 'list', '--configs', '--json'], chainFor())
    const payload = stdout.json<ListPayload>()
    expect(payload.factory?.configs).toHaveLength(1)
    expect(payload.factory?.configs[0]).toMatchObject({ id: 0, curveFeeBps: 100, tickSpacing: 200, enabled: true })
  })

  it('still prints the local configuration alongside it', async () => {
    const { stdout } = await invoke(['config', 'list', '--configs', '--json'], chainFor())
    const payload = stdout.json<ListPayload>()
    expect(payload.entries.some((entry) => entry.key === 'rpc.endpoints')).toBe(true)
  })

  it('touches the network only when asked to', async () => {
    // Without the flag this command is offline, and a broken endpoint list
    // must not stop somebody reading their own configuration.
    const refuse: Dispatch = () => Promise.reject(new Error('the network was used'))
    const { code, stdout } = await invoke(['config', 'list', '--json'], refuse)
    expect(code).toBe(ExitCode.Ok)
    expect(stdout.json<ListPayload>().factory).toBeUndefined()
  })

  it('renders the human table with scaled values', async () => {
    const { stdout } = await invoke(['config', 'list', '--configs', '--human'], chainFor())
    expect(stdout.text).toContain('0.0005 ETH')
    expect(stdout.text).toContain('1,000,000,000')
    expect(stdout.text).toContain('99% decaying over 3s')
  })
})
