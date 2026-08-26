import { describe, expect, it } from 'vitest'

import {
  highestBlock,
  isWriteMethod,
  logRange,
  logSpan,
  parseBlockTag,
  stateBlock,
} from '../src/chain/request.js'

describe('parseBlockTag', () => {
  it('reads a hex block number', () => {
    expect(parseBlockTag('0x2b6a13c')).toBe(45_523_260n)
  })

  it('treats a named tag as no pin at all', () => {
    // "latest" is a moving target, so it says nothing about retention or skew.
    for (const tag of ['latest', 'pending', 'earliest', 'safe', 'finalized']) {
      expect(parseBlockTag(tag)).toBeUndefined()
    }
  })

  it('rejects a malformed value rather than guessing', () => {
    expect(parseBlockTag('0xzz')).toBeUndefined()
    expect(parseBlockTag(null)).toBeUndefined()
  })
})

describe('stateBlock', () => {
  it('finds the block argument of a state-reading call', () => {
    expect(stateBlock('eth_call', [{ to: '0x0' }, '0x64'])).toBe(100n)
    expect(stateBlock('eth_getStorageAt', ['0x0', '0x0', '0x64'])).toBe(100n)
  })

  it('ignores methods served from block data rather than state', () => {
    // Nodes retain blocks and receipts far longer than the state trie, so these
    // must not be routed away from a pruning endpoint.
    expect(stateBlock('eth_getBlockByNumber', ['0x64', false])).toBeUndefined()
    expect(stateBlock('eth_getTransactionReceipt', ['0xabc'])).toBeUndefined()
  })
})

describe('logRange', () => {
  it('reads both bounds out of the filter object', () => {
    expect(logRange('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0xa' }])).toEqual({
      from: 1n,
      to: 10n,
    })
  })

  it('returns undefined for anything that is not a log query', () => {
    expect(logRange('eth_call', [{}, 'latest'])).toBeUndefined()
  })

  it('computes an inclusive span', () => {
    expect(logSpan({ from: 1n, to: 10n })).toBe(10)
    expect(logSpan({ from: 1n, to: undefined })).toBeUndefined()
  })
})

describe('highestBlock', () => {
  it('uses toBlock for a log query', () => {
    expect(highestBlock('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0xa' }])).toBe(10n)
  })

  it('uses the state block for a call', () => {
    expect(highestBlock('eth_call', [{ to: '0x0' }, '0x64'])).toBe(100n)
  })

  it('uses the block argument when reading a block', () => {
    expect(highestBlock('eth_getBlockByNumber', ['0x64', false])).toBe(100n)
  })
})

describe('isWriteMethod', () => {
  it('recognises the methods that must not be round-robined', () => {
    // A nonce taken from one node and broadcast to another is `nonce too low`.
    expect(isWriteMethod('eth_sendRawTransaction')).toBe(true)
    expect(isWriteMethod('eth_signTransaction')).toBe(true)
  })

  it('leaves reads alone', () => {
    expect(isWriteMethod('eth_call')).toBe(false)
    expect(isWriteMethod('eth_getLogs')).toBe(false)
  })
})
