import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import { universalRouterAbi, v4QuoterAbi, v4StateViewAbi } from '../../abi/index.js'
import { NATIVE_PAIR_TOKEN, addresses } from '../../chain/addresses.js'
import { ExitCode, PonsError } from '../../errors.js'

/**
 * Uniswap V4 execution through the UniversalRouter.
 *
 * The encoding is the native-V4 UniversalRouter path, proved on this chain by
 * `eth_call` against a live graduated pool: the buy succeeds, the same buy with
 * its floor raised above the quote reverts, and the same buy with a past
 * deadline reverts. Three different fields in three different slots, which is
 * what makes the encoding trustworthy rather than merely plausible.
 *
 * Two Robinhood-specific facts drive it:
 *
 *  - **The RH UniversalRouter is a non-standard fork.** Its `V3_SWAP_EXACT_IN`
 *    input carries a sixth field — a trailing `address[]` — and omitting it makes
 *    the router read past the input and revert `SliceOutOfBounds`. The **V4**
 *    command input is stock, which is what the live path uses; this module emits
 *    stock V4 and never touches the V3 command.
 *  - **A Pons graduated pool is native-keyed.** The factory builds its `PoolKey`
 *    from the launch's `pairToken`, which is `address(0)` for a native launch, so
 *    `currency0` is the zero address and the pool holds real ETH. That removes
 *    both the `WRAP_ETH` before the swap and the `UNWRAP_WETH` after it — and
 *    emitting a stray `WRAP_ETH` would leave WETH in the router while the pool
 *    expects ETH, reverting on settle.
 */

/** UniversalRouter command bytes. */
const CMD_V4_SWAP = 0x10
const CMD_PERMIT2_PERMIT = 0x0a

/** v4-periphery `Actions.sol` opcodes. */
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06
const ACTION_SETTLE = 0x0b
const ACTION_SETTLE_ALL = 0x0c
const ACTION_TAKE = 0x0e

/**
 * `Constants.sol` recipient sentinels. address(1) is remapped by the router to
 * msg.sender, address(2) to the router itself.
 */
const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001'

/**
 * `ActionConstants.OPEN_DELTA`. A zero amount in SETTLE or TAKE means "the whole
 * currently-open delta of this currency", which is what lets TAKE pay out an
 * amount nobody knows until the swap has run.
 */
const OPEN_DELTA = 0n

export interface V4PoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const

const EXACT_IN_SINGLE = {
  type: 'tuple',
  components: [
    { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
} as const

/**
 * Sort a pair into a `PoolKey`.
 *
 * `currency0 < currency1` by address, and the zero address always sorts first —
 * which is why a native pool is always the zero-for-one side when spending ETH.
 */
export function sortedPoolKey(
  tokenA: Address,
  tokenB: Address,
  fee: number,
  tickSpacing: number,
  hooks: Address,
): V4PoolKey {
  const [currency0, currency1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]
  return {
    currency0: currency0.toLowerCase() as Address,
    currency1: currency1.toLowerCase() as Address,
    fee,
    tickSpacing,
    hooks,
  }
}

/** `PoolKey.toId()` — the keccak of the abi-encoded key. */
export function poolId(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  )
}

const UINT128_MAX = (1n << 128n) - 1n

function requireUint128(label: string, value: bigint): void {
  if (value < 0n || value > UINT128_MAX) {
    throw new PonsError('V4_AMOUNT_RANGE', `${label} does not fit a uint128`, {
      exitCode: ExitCode.Failure,
      details: { [label]: value.toString() },
    })
  }
}

function encodeExactInSingle(
  key: V4PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMinimum: bigint,
): Hex {
  requireUint128('amountIn', amountIn)
  requireUint128('amountOutMinimum', amountOutMinimum)
  return encodeAbiParameters(
    [EXACT_IN_SINGLE],
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum, hookData: '0x' }],
  )
}

/** SETTLE: `(currency, amount, payerIsUser)`. */
function encodeSettle(currency: Address, amount: bigint, payerIsUser: boolean): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
    [currency, amount, payerIsUser],
  )
}

/** SETTLE_ALL: `(currency, maxAmount)`. */
function encodeSettleAll(currency: Address, maxAmount: bigint): Hex {
  return encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency, maxAmount])
}

/** TAKE: `(currency, recipient, amount)`. */
function encodeTake(currency: Address, recipient: Address, amount: bigint): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [currency, recipient, amount],
  )
}

/** The V4_SWAP command input: `abi.encode(bytes actions, bytes[] params)`. */
function encodeV4SwapCommand(actions: number[], params: Hex[]): Hex {
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [`0x${actions.map((action) => action.toString(16).padStart(2, '0')).join('')}`, params],
  )
}

function commandBytes(commands: number[]): Hex {
  return `0x${commands.map((command) => command.toString(16).padStart(2, '0')).join('')}`
}

export interface V4BuyParams {
  key: V4PoolKey
  token: Address
  amountIn: bigint
  amountOutMinimum: bigint
  deadline: bigint
}

export interface V4Call {
  to: Address
  data: Hex
  value: bigint
}

/**
 * Encode a native-ETH buy: one `V4_SWAP` command.
 *
 * SWAP_EXACT_IN_SINGLE, then SETTLE the native currency from the router's own
 * balance — the value the transaction carried — then TAKE the token to the
 * caller. `payerIsUser` is false because the router already holds the ETH; there
 * is no Permit2 pull and no wrapping.
 */
export function encodeV4Buy(params: V4BuyParams): V4Call {
  const { key, token, amountIn, amountOutMinimum, deadline } = params
  // The zero address always sorts first, so spending native means zeroForOne.
  // Derived from the key rather than assumed: a malformed key then fails the
  // pool lookup instead of swapping the wrong way round.
  const zeroForOne = key.currency0 === NATIVE_PAIR_TOKEN
  const input = encodeV4SwapCommand(
    [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE, ACTION_TAKE],
    [
      encodeExactInSingle(key, zeroForOne, amountIn, amountOutMinimum),
      encodeSettle(NATIVE_PAIR_TOKEN, amountIn, false),
      encodeTake(token, MSG_SENDER, OPEN_DELTA),
    ],
  )
  return {
    to: addresses.universalRouter,
    data: encodeFunctionData({
      abi: universalRouterAbi,
      functionName: 'execute',
      args: [commandBytes([CMD_V4_SWAP]), [input], deadline],
    }),
    value: amountIn,
  }
}

export interface PermitSingle {
  details: { token: Address; amount: bigint; expiration: number; nonce: number }
  spender: Address
  sigDeadline: bigint
}

export interface V4SellParams {
  key: V4PoolKey
  token: Address
  amountIn: bigint
  amountOutMinimum: bigint
  deadline: bigint
  permit: PermitSingle
  signature: Hex
}

/**
 * Encode a native-ETH sell: `PERMIT2_PERMIT`, then `V4_SWAP`.
 *
 * SETTLE_ALL pulls the token from the caller through Permit2 — which is why a
 * sell needs a signature and cannot be produced in `--unsigned` mode — and TAKE
 * pays native ETH straight out, with no router-held WETH to unwrap.
 *
 * A standing `approve(token → Permit2)` is still required: Permit2 moves the
 * token with `transferFrom`, and the signature authorises Permit2, not the ERC-20.
 */
export function encodeV4Sell(params: V4SellParams): V4Call {
  const { key, token, amountIn, amountOutMinimum, deadline, permit, signature } = params
  const zeroForOne = key.currency0 === token.toLowerCase()
  const permitInput = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            name: 'details',
            type: 'tuple',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint160' },
              { name: 'expiration', type: 'uint48' },
              { name: 'nonce', type: 'uint48' },
            ],
          },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      { type: 'bytes' },
    ],
    [permit, signature],
  )
  const swapInput = encodeV4SwapCommand(
    [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE],
    [
      encodeExactInSingle(key, zeroForOne, amountIn, amountOutMinimum),
      encodeSettleAll(token, amountIn),
      encodeTake(NATIVE_PAIR_TOKEN, MSG_SENDER, OPEN_DELTA),
    ],
  )
  return {
    to: addresses.universalRouter,
    data: encodeFunctionData({
      abi: universalRouterAbi,
      functionName: 'execute',
      args: [commandBytes([CMD_PERMIT2_PERMIT, CMD_V4_SWAP]), [permitInput, swapInput], deadline],
    }),
    value: 0n,
  }
}

export interface PoolState {
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
}

/** Read the pool's price and liquidity. Absent liquidity means no pool. */
export async function readPoolState(client: PublicClient, key: V4PoolKey): Promise<PoolState> {
  const id = poolId(key)
  const [slot0, liquidity] = await client.multicall({
    contracts: [
      { address: addresses.v4StateView, abi: v4StateViewAbi, functionName: 'getSlot0', args: [id] },
      { address: addresses.v4StateView, abi: v4StateViewAbi, functionName: 'getLiquidity', args: [id] },
    ],
    allowFailure: false,
  })
  return { sqrtPriceX96: slot0[0], tick: slot0[1], liquidity }
}

/**
 * Quote an exact-in swap through `V4Quoter`.
 *
 * The quoter is `nonpayable` — it swaps inside a call that reverts with the
 * result — so this is an `eth_call`, not a read. It is the only firm number
 * available: the pool's hook can adjust the fee, so reserve arithmetic of our
 * own would be a guess.
 */
export async function quoteV4ExactIn(
  client: PublicClient,
  key: V4PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  account: Address,
): Promise<{ amountOut: bigint; gasEstimate: bigint }> {
  const { result } = await client.simulateContract({
    address: addresses.v4Quoter,
    abi: v4QuoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    account,
  })
  const [amountOut, gasEstimate] = result
  return { amountOut, gasEstimate }
}
