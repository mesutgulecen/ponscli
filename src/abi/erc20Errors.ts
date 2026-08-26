/**
 * Custom errors the common ERC-20 implementations declare.
 *
 * Hand-written, unlike every other file in this directory, and deliberately so.
 * A quote asset is somebody else's token: a launch against USDG reverts through
 * USDG's code, and there is no single ABI to fetch that covers the twenty-three
 * approved assets and whatever is approved next. What can be pinned down is the
 * handful of shapes the three widely used implementations declare, which are
 * fixed by those libraries and cannot drift the way a deployment can.
 *
 * The live case that motivated this: an opening buy denominated in USDG,
 * simulated before its approval had landed, reverted with `0x13be252b`. That is
 * Solady's `InsufficientAllowance()`, since USDG is a Solady-style token behind
 * a diamond proxy. Every ABI the CLI held described a Pons contract, so the
 * most ordinary failure on that path printed as four unexplained bytes.
 *
 * > `toFunctionSelector` must be given the **signature string** for an error,
 * > never the ABI item. Handed the item, viem signs `error Name()` including
 * > the keyword, which hashes to something no chain will ever return:
 * > `InsufficientAllowance()` is `0x13be252b` and viem's item form says
 * > `0x4316db37`. `src/core/revert.ts` builds the string itself for exactly
 * > this reason.
 */
export const erc20ErrorsAbi = [
  // OpenZeppelin v5.
  {
    type: 'error',
    name: 'ERC20InsufficientAllowance',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'allowance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientBalance',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'balance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'ERC20InvalidApprover', inputs: [{ name: 'approver', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidReceiver', inputs: [{ name: 'receiver', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidSender', inputs: [{ name: 'sender', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidSpender', inputs: [{ name: 'spender', type: 'address' }] },

  // Solady. USDG is one of these.
  { type: 'error', name: 'InsufficientAllowance', inputs: [] },
  { type: 'error', name: 'InsufficientBalance', inputs: [] },
  { type: 'error', name: 'TotalSupplyOverflow', inputs: [] },
  { type: 'error', name: 'Permit2AllowanceIsFixedAtInfinity', inputs: [] },

  // Solmate and the `SafeTransferLib` family.
  { type: 'error', name: 'TransferFailed', inputs: [] },
  { type: 'error', name: 'TransferFromFailed', inputs: [] },
  { type: 'error', name: 'ApproveFailed', inputs: [] },
] as const
