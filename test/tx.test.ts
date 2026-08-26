import { afterEach, describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  numberToHex,
  type Address,
  type Hex,
} from 'viem'

import { v2CurveAbi } from '../src/abi/index.js'
import type { Dispatch } from '../src/chain/pool.js'
import { ExitCode } from '../src/errors.js'
import { run } from '../src/program.js'
import { fakeChain } from './fakeChain.js'
import { BufferSink, createTempHome, type TempHome } from './helpers.js'

const HASH: Hex = `0x${'2e'.repeat(32)}`
const CURVE: Address = '0x60CeF8379Aa278F087074bC60595778985c1bD8E'
const TOKEN: Address = '0x44D6736eB4Bc60c17Fe8220062d8fdE3C28920f4'
const BUYER: Address = '0xCAefbb5e99d0c48a7Aa49936662b174a3c2eaD61'
const NATIVE: Address = '0x0000000000000000000000000000000000000000'

/** The calldata a curve buy actually carries, so the replay path is real. */
const BUY_CALLDATA = encodeFunctionData({
  abi: v2CurveAbi,
  functionName: 'buy',
  args: [5_000_000_000_000_000n, 1n, BUYER],
})

function curveBuyLog(): Record<string, unknown> {
  return {
    address: CURVE,
    topics: encodeEventTopics({
      abi: v2CurveAbi,
      eventName: 'CurveBuy',
      args: { buyer: BUYER, recipient: BUYER },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [5_000_000_000_000_000n, 2_937_772_634_202_795_335_173_150n, 50_000_000_000_000n, 0n],
    ),
    blockNumber: numberToHex(45_676_251),
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: HASH,
    transactionIndex: '0x0',
    logIndex: '0xf',
    removed: false,
  }
}

interface ReceiptOptions {
  reverted?: boolean
  logs?: Record<string, unknown>[]
}

function chainFor(options: ReceiptOptions & { revertData?: Hex } = {}): Dispatch {
  const transaction = {
    hash: HASH,
    blockHash: `0x${'11'.repeat(32)}`,
    blockNumber: numberToHex(45_676_251),
    from: BUYER,
    to: CURVE,
    gas: numberToHex(4_733_811),
    input: BUY_CALLDATA,
    nonce: '0x7',
    value: numberToHex(5_500_000_000_000_000n),
    type: '0x2',
    maxFeePerGas: numberToHex(30_000_000n),
    maxPriorityFeePerGas: numberToHex(0),
    transactionIndex: '0x0',
    chainId: numberToHex(4663),
  }

  const receipt = {
    blockHash: transaction.blockHash,
    blockNumber: transaction.blockNumber,
    contractAddress: null,
    cumulativeGasUsed: numberToHex(3_753_250),
    effectiveGasPrice: numberToHex(23_407_000n),
    from: BUYER,
    gasUsed: numberToHex(3_753_250),
    logs: options.logs ?? [],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: options.reverted === true ? '0x0' : '0x1',
    to: CURVE,
    transactionHash: HASH,
    transactionIndex: '0x0',
    type: '0x2',
  }

  return fakeChain({
    answers: [
      { address: CURVE, abi: v2CurveAbi, functionName: 'token', result: TOKEN },
      { address: CURVE, abi: v2CurveAbi, functionName: 'pairToken', result: NATIVE },
      { address: TOKEN, abi: v2CurveAbi, functionName: 'token', result: TOKEN },
    ],
    ...(options.revertData === undefined
      ? {}
      : { reverts: { [`${CURVE}:${BUY_CALLDATA}`]: options.revertData } }),
    methods: {
      eth_getTransactionByHash: transaction,
      eth_getTransactionReceipt: receipt,
    },
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

interface TxPayload {
  status: string
  gas: { used: string; feeWei: string }
  logs: { name: string | null; source: string | null; args: Record<string, string> }[]
  revert: { name: string | null; selector: string | null; hint?: string; replayed: boolean } | null
}

describe('pons tx', () => {
  it('reports a successful transaction with its logs named', async () => {
    const { code, stdout } = await invoke(
      ['tx', HASH, '--json'],
      chainFor({ logs: [curveBuyLog()] }),
    )
    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<TxPayload>()
    expect(payload.status).toBe('success')
    expect(payload.logs[0]?.name).toBe('CurveBuy')
    expect(payload.logs[0]?.source).toBe('curve')
    // JSON keeps base units: a consumer needs the number it can compute with.
    expect(payload.logs[0]?.args['quoteIn']).toBe('5000000000000000')
    expect(payload.revert).toBeNull()
  })

  it('scales log amounts for a human, each by its own asset', async () => {
    const { stdout } = await invoke(['tx', HASH, '--human'], chainFor({ logs: [curveBuyLog()] }))
    expect(stdout.text).toContain('quoteIn=0.005 ETH')
  })

  it('recovers the revert reason a receipt does not carry', async () => {
    // A receipt says `status: 0` and nothing more. The reason only comes back
    // by replaying the call, which is the whole point of this command.
    const { code, stdout } = await invoke(
      ['tx', HASH, '--json'],
      chainFor({
        reverted: true,
        revertData: encodeErrorResult({ abi: v2CurveAbi, errorName: 'CurveGraduated' }),
      }),
    )
    expect(code).toBe(ExitCode.Ok)
    const payload = stdout.json<TxPayload>()
    expect(payload.status).toBe('reverted')
    expect(payload.revert?.name).toBe('CurveGraduated')
    expect(payload.revert?.replayed).toBe(true)
    expect(payload.revert?.hint).toMatch(/pons graduate/)
  })

  it('says the reason could not be recovered rather than inventing one', async () => {
    // The replay needs state the endpoint may have pruned — at 0.1 s per
    // block, the official node keeps roughly a quarter of an hour of it.
    const { stdout } = await invoke(['tx', HASH, '--human'], chainFor({ reverted: true }))
    expect(stdout.text).toContain('could not be recovered')
  })

  it('rejects an argument that is not a hash', async () => {
    const { code, stderr } = await invoke(['tx', '0x1234', '--json'], chainFor())
    expect(code).toBe(ExitCode.Usage)
    expect(stderr.json<{ error: { code: string } }>().error.code).toBe('USAGE')
  })
})
