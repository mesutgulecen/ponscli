import { describe, expect, it } from 'vitest'
import { encodeErrorResult, toFunctionSelector } from 'viem'

import { v2CurveAbi, v2FactoryAbi, v2TokenAbi } from '../src/abi/index.js'
import { decodeRevert, knownErrorCount } from '../src/core/revert.js'

describe('decodeRevert', () => {
  it('names a curve error and says what to do about it', () => {
    const data = encodeErrorResult({ abi: v2CurveAbi, errorName: 'CurveGraduated' })
    const decoded = decodeRevert(data)
    expect(decoded.name).toBe('CurveGraduated')
    expect(decoded.sources).toContain('PonsV2BondingCurve')
    expect(decoded.hint).toMatch(/pons graduate/)
  })

  it('decodes an error with arguments', () => {
    // The token's allowance shortfall is the real revert behind a sell that
    // was never approved; it comes from the token, not from the curve.
    const data = encodeErrorResult({
      abi: v2TokenAbi,
      errorName: 'ERC20InsufficientAllowance',
      args: ['0x0000000000000000000000000000000000000001', 0n, 42n],
    })
    const decoded = decodeRevert(data)
    expect(decoded.name).toBe('ERC20InsufficientAllowance')
    expect(decoded.args).toEqual(['0x0000000000000000000000000000000000000001', '0', '42'])
  })

  it('carries a factory error through to its command hint', () => {
    const data = encodeErrorResult({ abi: v2FactoryAbi, errorName: 'PairTokenNotApproved' })
    expect(decodeRevert(data).hint).toMatch(/pons pairs/)
  })

  it('reads a plain require message', () => {
    const data = encodeErrorResult({
      abi: [
        { type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] },
      ] as const,
      errorName: 'Error',
      args: ['not enough'],
    })
    const decoded = decodeRevert(data)
    expect(decoded.name).toBe('Error')
    expect(decoded.message).toBe('not enough')
  })

  it('names a Solidity panic code', () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] }] as const,
      errorName: 'Panic',
      args: [17n],
    })
    expect(decodeRevert(data).message).toMatch(/arithmetic overflow/)
  })

  it('says an unknown selector is unknown rather than guessing', () => {
    const decoded = decodeRevert('0xdeadbeef')
    expect(decoded.name).toBeNull()
    expect(decoded.selector).toBe('0xdeadbeef')
    expect(decoded.message).toMatch(/unrecognised/)
  })

  it('handles a revert with no data at all', () => {
    const decoded = decodeRevert('0x')
    expect(decoded.selector).toBeNull()
    expect(decoded.message).toMatch(/without returning a reason/)
  })

  it('lists every contract that declares a shared error', () => {
    // `ZeroAmount` is declared by most of the V2 contracts. The map folds
    // them into one entry rather than letting the last ABI loaded win.
    const selector = toFunctionSelector('ZeroAmount()')
    const decoded = decodeRevert(selector)
    expect(decoded.name).toBe('ZeroAmount')
    expect(decoded.sources.length).toBeGreaterThan(1)
  })

  it('knows the errors of every committed ABI', () => {
    // A drift guard: if an ABI stops being loaded, this collapses.
    expect(knownErrorCount()).toBeGreaterThan(80)
  })
})
