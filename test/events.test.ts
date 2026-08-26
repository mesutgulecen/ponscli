import { describe, expect, it } from 'vitest'
import { encodeEventTopics, encodeAbiParameters, type Address, type Log } from 'viem'

import { v2CurveAbi } from '../src/abi/index.js'
import { decodeLogs, displayArgs, knownEventCount } from '../src/core/events.js'
import { emptyUnits, type Units } from '../src/core/units.js'

const CURVE: Address = '0x60CeF8379Aa278F087074bC60595778985c1bD8E'
const BUYER: Address = '0xCAefbb5e99d0c48a7Aa49936662b174a3c2eaD61'
const TOKEN: Address = '0x44D6736eB4Bc60c17Fe8220062d8fdE3C28920f4'

/** One `CurveBuy` log as a node would return it. */
function curveBuyLog(index: number): Log {
  const topics = encodeEventTopics({
    abi: v2CurveAbi,
    eventName: 'CurveBuy',
    args: { buyer: BUYER, recipient: BUYER },
  })
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [5_000_000_000_000_000n, 2_937_772_634_202_795_335_173_150n, 50_000_000_000_000n, 0n],
  )
  return {
    address: CURVE,
    topics,
    data,
    blockNumber: 1n,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    transactionIndex: 0,
    logIndex: index,
    removed: false,
  } as Log
}

function unknownLog(index: number): Log {
  return {
    address: '0x000000000000000000000000000000000000dEaD',
    topics: [`0x${'ab'.repeat(32)}`],
    data: '0x',
    blockNumber: 1n,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    transactionIndex: 0,
    logIndex: index,
    removed: false,
  }
}

describe('decodeLogs', () => {
  it('names an event and its arguments from the committed ABI', () => {
    const [log] = decodeLogs([curveBuyLog(3)])
    expect(log?.name).toBe('CurveBuy')
    expect(log?.source).toBe('curve')
    expect(log?.args['quoteIn']).toBe('5000000000000000')
    expect(log?.index).toBe(3)
  })

  it('keeps a log no ABI matches instead of dropping it', () => {
    // A receipt that silently hides the events it does not recognise reads as
    // "the transaction did not emit that".
    const decoded = decodeLogs([curveBuyLog(0), unknownLog(1)])
    expect(decoded).toHaveLength(2)
    expect(decoded[1]?.name).toBeNull()
    expect(decoded[1]?.topic0).toMatch(/^0xabab/)
  })

  it('covers every event of every committed ABI', () => {
    expect(knownEventCount()).toBeGreaterThan(40)
  })
})

describe('displayArgs', () => {
  const units: Units = {
    assets: new Map([[TOKEN.toLowerCase(), { symbol: 'DMAO', decimals: 18 }]]),
    curves: new Map([
      [CURVE.toLowerCase(), { token: TOKEN, quote: '0x0000000000000000000000000000000000000000' }],
    ]),
  }

  it('scales each side of a trade by its own asset', () => {
    const [log] = decodeLogs([curveBuyLog(0)])
    const shown = displayArgs(log!, units)
    expect(shown['quoteIn']).toBe('0.005 ETH')
    expect(shown['tokensOut']).toBe('2,937,772 DMAO')
    expect(shown['fee']).toBe('0.00005 ETH')
  })

  it('leaves amounts raw when the units are unknown', () => {
    // Better an unscaled number than a wrongly scaled one.
    const [log] = decodeLogs([curveBuyLog(0)])
    expect(displayArgs(log!, emptyUnits())['quoteIn']).toBe('5000000000000000')
  })

  it('leaves addresses alone', () => {
    const [log] = decodeLogs([curveBuyLog(0)])
    expect(displayArgs(log!, units)['buyer']).toBe(BUYER)
  })
})
