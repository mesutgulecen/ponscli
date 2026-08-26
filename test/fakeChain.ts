import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  numberToHex,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from 'viem'

import { addresses } from '../src/chain/addresses.js'
import type { Dispatch } from '../src/chain/pool.js'

/**
 * A chain that answers from a table.
 *
 * Command tests need a node, and the alternative to this is either hitting the
 * live chain — which makes the suite depend on somebody else's uptime and on
 * whatever token happened to launch today — or asserting on hand-encoded hex,
 * which tests the fixture rather than the code. This encodes real ABI-encoded
 * replies, so everything from viem's decoding down is exercised for real.
 *
 * Multicall3 is served too, because the client aggregates through it: with
 * `batch.multicall` on, even a single `readContract` arrives as an `aggregate3`.
 */

/** Multicall3's `aggregate3` and the `Result` tuple it returns. */
const MULTICALL3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const

export interface Answer {
  address: Address
  abi: Abi | readonly unknown[]
  functionName: string
  args?: readonly unknown[]
  /**
   * Match on the selector alone, whatever the arguments.
   *
   * For a call whose arguments a test cannot reproduce without duplicating the
   * code under test — `predictLaunchAddresses` takes the whole nineteen-field
   * deployment struct the command assembles, and pinning it here would assert
   * on the fixture rather than on the command.
   */
  anyArgs?: boolean
  /** Whatever the function returns, in viem's decoded shape. */
  result: unknown
}

/**
 * A call that should succeed whatever its arguments are.
 *
 * A simulated `buy` carries a min-out the test cannot know in advance, and
 * pinning it would test the fixture rather than the code. Matching on the
 * selector alone says "this call goes through" without asserting anything
 * about the numbers inside it.
 */
export interface Executable {
  address: Address
  /** Either an ABI plus a name, or the four-byte selector directly. */
  abi?: Abi | readonly unknown[]
  functionName?: string
  /**
   * The selector, when the name is ambiguous.
   *
   * `launchToken` is overloaded — three arguments or four — and picking by
   * name alone takes whichever the ABI happens to list first.
   */
  selector?: Hex
}

/** One log `eth_getLogs` may serve. Block numbers are plain numbers here. */
export interface FakeLog {
  address: Address
  topics: Hex[]
  data?: Hex
  blockNumber: number
  logIndex?: number
  transactionHash?: Hex
  blockHash?: Hex
}

export interface FakeChainOptions {
  answers: readonly Answer[]
  /** Calls that succeed on selector alone, returning no data. */
  succeed?: readonly Executable[]
  /** Replies for methods other than `eth_call`, keyed by method name. */
  methods?: Record<string, unknown>
  /** Calls that should revert, keyed `<address>:<calldata>` → revert data. */
  reverts?: Record<string, Hex>
  /** Logs served by `eth_getLogs`, filtered by range, address and topic0. */
  logs?: readonly FakeLog[]
  /**
   * Widest span `eth_getLogs` will answer.
   *
   * A narrower request than this succeeds; a wider one fails the way this
   * chain does, with `-32000 log query timed out`. It is what lets a test
   * watch the scanner subdivide.
   */
  logRangeLimit?: number
}

function key(address: string, calldata: string): string {
  return `${address.toLowerCase()}:${calldata.toLowerCase()}`
}

const DEFAULT_METHODS: Record<string, unknown> = {
  eth_chainId: numberToHex(4663),
  eth_blockNumber: numberToHex(45_676_251),
}

/**
 * Build a `Dispatch` that serves the given answers.
 *
 * Anything not in the table answers as a failed call rather than throwing:
 * that is what a real node does for a call to an address with no code, and it
 * is the case the adapter's `required` check exists to report.
 */
export function fakeChain(options: FakeChainOptions): Dispatch {
  const table = new Map<string, Hex>()
  const bySelector = new Map<string, Hex>()
  for (const answer of options.answers) {
    const returnData = encodeFunctionResult({
      abi: answer.abi as Abi,
      functionName: answer.functionName,
      result: answer.result,
    })
    if (answer.anyArgs === true) {
      const selector = toFunctionSelector(
        (answer.abi as Abi).find(
          (item) => item.type === 'function' && item.name === answer.functionName,
        ) as never,
      )
      bySelector.set(key(answer.address, selector), returnData)
      continue
    }
    const calldata = encodeFunctionData({
      abi: answer.abi as Abi,
      functionName: answer.functionName,
      ...(answer.args === undefined ? {} : { args: answer.args }),
    })
    table.set(key(answer.address, calldata), returnData)
  }

  // Keys arrive already joined as `<address>:<calldata>`, so lowercasing the
  // whole string matches what `key()` builds on the way in.
  const executable = new Set(
    (options.succeed ?? []).map((entry) =>
      key(
        entry.address,
        entry.selector ??
          toFunctionSelector(
            (entry.abi as Abi).find(
              (item) => item.type === 'function' && item.name === entry.functionName,
            ) as never,
          ),
      ),
    ),
  )

  const reverts = new Map(
    Object.entries(options.reverts ?? {}).map(([call, data]) => [call.toLowerCase(), data]),
  )

  const answerCall = (to: string, data: Hex): { success: boolean; returnData: Hex } => {
    const reverted = reverts.get(key(to, data))
    if (reverted !== undefined) return { success: false, returnData: reverted }
    const found = table.get(key(to, data))
    if (found !== undefined) return { success: true, returnData: found }
    const loose = bySelector.get(key(to, data.slice(0, 10)))
    if (loose !== undefined) return { success: true, returnData: loose }
    if (executable.has(key(to, data.slice(0, 10)))) return { success: true, returnData: '0x' }
    return { success: false, returnData: '0x' }
  }

  const logs = options.logs ?? []
  const serveLogs = (filter: {
    fromBlock?: Hex
    toBlock?: Hex
    address?: Address | Address[]
    topics?: (Hex | Hex[] | null)[]
  }): unknown[] => {
    const from = Number(BigInt(filter.fromBlock ?? '0x0'))
    const to = Number(BigInt(filter.toBlock ?? '0x0'))
    const wantedAddresses = new Set(
      (Array.isArray(filter.address) ? filter.address : filter.address === undefined ? [] : [filter.address]).map(
        (entry) => entry.toLowerCase(),
      ),
    )
    const first = filter.topics?.[0]
    const wantedTopics = new Set(
      (first === null || first === undefined ? [] : Array.isArray(first) ? first : [first]).map((entry) =>
        entry.toLowerCase(),
      ),
    )

    return logs
      .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
      .filter((log) => wantedAddresses.size === 0 || wantedAddresses.has(log.address.toLowerCase()))
      .filter((log) => wantedTopics.size === 0 || wantedTopics.has((log.topics[0] ?? '0x').toLowerCase()))
      .map((log, position) => ({
        address: log.address,
        topics: log.topics,
        data: log.data ?? '0x',
        blockNumber: numberToHex(log.blockNumber),
        blockHash: log.blockHash ?? numberToHex(log.blockNumber, { size: 32 }),
        transactionHash: log.transactionHash ?? numberToHex(position + 1, { size: 32 }),
        transactionIndex: numberToHex(0),
        logIndex: numberToHex(log.logIndex ?? position),
        removed: false,
      }))
  }

  return (_endpoint, method, params) => {
    if (method === 'eth_getLogs') {
      const filter = params[0] as Parameters<typeof serveLogs>[0]
      const span = Number(BigInt(filter.toBlock ?? '0x0') - BigInt(filter.fromBlock ?? '0x0')) + 1
      if (options.logRangeLimit !== undefined && span > options.logRangeLimit) {
        return Promise.reject(
          Object.assign(new Error('log query timed out'), { code: -32000 }),
        )
      }
      return Promise.resolve(serveLogs(filter))
    }

    // `eth_estimateGas` takes the same request shape, so it is answered by
    // running the call and returning a fixed figure: the tests are about what
    // the plan does, not about what it costs.
    if (method === 'eth_estimateGas') {
      const request = params[0] as { to: Address; data: Hex }
      const outcome = answerCall(request.to, request.data)
      if (!outcome.success && request.data !== '0x') {
        return Promise.reject(Object.assign(new Error('execution reverted'), { code: 3 }))
      }
      return Promise.resolve(numberToHex(100_000))
    }
    if (method === 'eth_call') {
      const request = params[0] as { to: Address; data: Hex }
      if (request.to.toLowerCase() === addresses.multicall3.toLowerCase()) {
        const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data: request.data })
        const calls = args[0] as readonly { target: Address; callData: Hex }[]
        const results = calls.map((call) => answerCall(call.target, call.callData))
        return Promise.resolve(
          encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: results }),
        )
      }
      const direct = answerCall(request.to, request.data)
      if (!direct.success) {
        return Promise.reject(
          Object.assign(new Error('execution reverted'), {
            code: 3,
            data: direct.returnData,
          }),
        )
      }
      return Promise.resolve(direct.returnData)
    }

    const answer = options.methods?.[method] ?? DEFAULT_METHODS[method]
    if (answer === undefined) {
      return Promise.reject(
        Object.assign(new Error(`the method ${method} does not exist`), { code: -32601 }),
      )
    }
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(answer)
  }
}
