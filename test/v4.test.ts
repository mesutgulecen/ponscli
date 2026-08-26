import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, decodeFunctionData, type Address, type Hex } from 'viem'

import { universalRouterAbi } from '../src/abi/index.js'
import { addresses } from '../src/chain/addresses.js'
import { encodeV4Buy, poolId, sortedPoolKey } from '../src/core/routes/v4.js'

/**
 * The V4 encoder, checked against the shape the live chain accepted.
 *
 * The golden calldata below was executed against the Robinhood UniversalRouter
 * with `eth_call` and a balance override on 2026-08-25: it succeeded, it
 * reverted when the floor was raised above the quote, and it reverted on a past
 * deadline. That is the whole reason the bytes are pinned here: an encoder
 * that silently moves a field would still produce plausible calldata.
 */

const TOKEN: Address = '0x9De83d01BC3D0857435529D931679bA5Dc31Ddf4'
const NATIVE: Address = '0x0000000000000000000000000000000000000000'
const HOOK = addresses.memeHook as Address

/** A graduated Pons pool: native-keyed, zero LP fee, 200 tick spacing. */
const KEY = sortedPoolKey(TOKEN, NATIVE, 0, 200, HOOK)

describe('sortedPoolKey', () => {
  it('sorts the native sentinel first', () => {
    // address(0) always sorts first, which is why spending ETH is zeroForOne.
    expect(KEY.currency0).toBe(NATIVE)
    expect(KEY.currency1).toBe(TOKEN.toLowerCase())
  })

  it('is independent of the order it was given', () => {
    expect(sortedPoolKey(NATIVE, TOKEN, 0, 200, HOOK)).toEqual(KEY)
  })

  it('carries the launch record verbatim', () => {
    expect(KEY.fee).toBe(0)
    expect(KEY.tickSpacing).toBe(200)
    expect(KEY.hooks).toBe(HOOK)
  })
})

describe('poolId', () => {
  it('matches the id the chain answers state for', () => {
    // `StateView.getSlot0` on this id returned a live price and liquidity.
    expect(poolId(KEY)).toBe('0xa574755235687ad40f702e65b2d371a5781fd234dfde12a5b79eef574e7327a6')
  })
})

describe('encodeV4Buy', () => {
  const call = encodeV4Buy({
    key: KEY,
    token: TOKEN,
    amountIn: 10_000_000_000_000_000n,
    amountOutMinimum: 1_000n,
    deadline: 1_800_000_000n,
  })

  it('sends the swap to the UniversalRouter with the input as value', () => {
    expect(call.to).toBe(addresses.universalRouter)
    // A native pool settles from the value the transaction carried; there is
    // no WRAP_ETH, and no WETH left in the router to unwrap afterwards.
    expect(call.value).toBe(10_000_000_000_000_000n)
  })

  it('emits one V4_SWAP command', () => {
    const { functionName, args } = decodeFunctionData({ abi: universalRouterAbi, data: call.data })
    expect(functionName).toBe('execute')
    const [commands, inputs, deadline] = args as readonly [Hex, Hex[], bigint]
    expect(commands).toBe('0x10')
    expect(inputs).toHaveLength(1)
    expect(deadline).toBe(1_800_000_000n)
  })

  it('plans swap, settle and take in that order', () => {
    const { args } = decodeFunctionData({ abi: universalRouterAbi, data: call.data })
    const [, inputs] = args as readonly [Hex, Hex[], bigint]
    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      inputs[0] as Hex,
    )
    // SWAP_EXACT_IN_SINGLE, SETTLE, TAKE.
    expect(actions).toBe('0x060b0e')
    expect(params).toHaveLength(3)
  })

  it('settles the native currency from the router, not from the user', () => {
    const { args } = decodeFunctionData({ abi: universalRouterAbi, data: call.data })
    const [, inputs] = args as readonly [Hex, Hex[], bigint]
    const [, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0] as Hex)
    const [currency, amount, payerIsUser] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
      params[1] as Hex,
    )
    expect(currency.toLowerCase()).toBe(NATIVE)
    expect(amount).toBe(10_000_000_000_000_000n)
    // False: the router already holds the ETH. True would try a Permit2 pull
    // of a currency Permit2 cannot move.
    expect(payerIsUser).toBe(false)
  })

  it('takes the token to msg.sender against the open delta', () => {
    const { args } = decodeFunctionData({ abi: universalRouterAbi, data: call.data })
    const [, inputs] = args as readonly [Hex, Hex[], bigint]
    const [, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0] as Hex)
    const [currency, recipient, amount] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      params[2] as Hex,
    )
    expect(currency.toLowerCase()).toBe(TOKEN.toLowerCase())
    // address(1) is the router's sentinel for msg.sender.
    expect(recipient).toBe('0x0000000000000000000000000000000000000001')
    // Zero means OPEN_DELTA: take everything the swap produced, which nobody
    // knows until it has run.
    expect(amount).toBe(0n)
  })

  it('carries the slippage floor in the swap params', () => {
    const { args } = decodeFunctionData({ abi: universalRouterAbi, data: call.data })
    const [, inputs] = args as readonly [Hex, Hex[], bigint]
    const [, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0] as Hex)
    const [swap] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            {
              name: 'poolKey',
              type: 'tuple',
              components: [
                { name: 'currency0', type: 'address' },
                { name: 'currency1', type: 'address' },
                { name: 'fee', type: 'uint24' },
                { name: 'tickSpacing', type: 'int24' },
                { name: 'hooks', type: 'address' },
              ],
            },
            { name: 'zeroForOne', type: 'bool' },
            { name: 'amountIn', type: 'uint128' },
            { name: 'amountOutMinimum', type: 'uint128' },
            { name: 'hookData', type: 'bytes' },
          ],
        },
      ],
      params[0] as Hex,
    )
    expect(swap.zeroForOne).toBe(true)
    expect(swap.amountIn).toBe(10_000_000_000_000_000n)
    expect(swap.amountOutMinimum).toBe(1_000n)
    expect(swap.hookData).toBe('0x')
  })

  it('refuses an amount that does not fit the uint128 the action takes', () => {
    expect(() =>
      encodeV4Buy({
        key: KEY,
        token: TOKEN,
        amountIn: 1n << 200n,
        amountOutMinimum: 0n,
        deadline: 1n,
      }),
    ).toThrow(/uint128/)
  })
})
