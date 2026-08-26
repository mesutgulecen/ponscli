import type { AbiError } from 'abitype'
import type { AbiParameter } from 'abitype'
import { decodeErrorResult, toFunctionSelector, type Abi, type Hex } from 'viem'

import {
  buybackVaultAbi,
  erc20ErrorsAbi,
  feeEscrowAbi,
  launchAndBuyAbi,
  launchDeployerAbi,
  memeHookAbi,
  v1LockerAbi,
  v1TokenAbi,
  v3PoolAbi,
  poolManagerAbi,
  universalRouterAbi,
  v1FactoryAbi,
  v2CurveAbi,
  v2FactoryAbi,
  v2TokenAbi,
  v3SwapRouterAbi,
} from '../abi/index.js'

/**
 * Turning revert data into something a person can act on.
 *
 * The contracts define well over a hundred custom errors between them. A bare
 * `0x8f9a780c` tells the user nothing, and looking it up means having the ABI
 * they do not have. The selector-to-name half of this is derived from the
 * committed ABIs, so it can never fall behind a redeployment; only the
 * explanations are written by hand, and only where a name alone is not enough.
 */

/** Every ABI the CLI knows, in the order a collision would be resolved. */
const KNOWN_ABIS: { source: string; abi: Abi }[] = [
  { source: 'PonsV2BondingCurve', abi: v2CurveAbi },
  { source: 'PonsV2LaunchFactory', abi: v2FactoryAbi },
  { source: 'PonsV2LauncherToken', abi: v2TokenAbi },
  { source: 'PonsV2MemeHook', abi: memeHookAbi },
  { source: 'PonsV2FeeEscrow', abi: feeEscrowAbi },
  { source: 'PonsV2BuybackVault', abi: buybackVaultAbi },
  { source: 'PonsV2LaunchDeployer', abi: launchDeployerAbi },
  { source: 'PonsV2LaunchAndBuy', abi: launchAndBuyAbi },
  { source: 'PonsLaunchFactory', abi: v1FactoryAbi },
  { source: 'PonsLauncherToken', abi: v1TokenAbi },
  { source: 'PonsLaunchLocker', abi: v1LockerAbi },
  { source: 'UniswapV3Pool', abi: v3PoolAbi },
  { source: 'PoolManager', abi: poolManagerAbi },
  { source: 'UniversalRouter', abi: universalRouterAbi },
  { source: 'SwapRouter', abi: v3SwapRouterAbi },
  // Last: a quote asset's own error only wins where no Pons contract declares
  // the same selector.
  { source: 'ERC-20', abi: erc20ErrorsAbi },
]

/** Solidity's two built-in errors, which no contract ABI declares. */
const BUILT_INS: AbiError[] = [
  { type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
]

export interface KnownError {
  selector: Hex
  signature: string
  item: AbiError
  /** Contracts declaring this error, first one wins for decoding. */
  sources: string[]
}

/**
 * The canonical form of one parameter type.
 *
 * A tuple's canonical form is its component types in parentheses; the literal
 * word `tuple` hashes to a selector that matches nothing on chain. Arrays keep
 * their suffix, so `tuple[2][]` becomes `(address,uint256)[2][]`.
 */
function canonicalType(input: AbiParameter): string {
  if (!input.type.startsWith('tuple')) return input.type
  const components = (input as { components?: readonly AbiParameter[] }).components ?? []
  return `(${components.map(canonicalType).join(',')})${input.type.slice('tuple'.length)}`
}

function signatureOf(item: AbiError): string {
  return `${item.name}(${item.inputs.map(canonicalType).join(',')})`
}

/**
 * Selector to error, built once from the committed ABIs.
 *
 * Several contracts declare the same error, and `ZeroAmount` appears in most of
 * them, but the decoded result is identical either way, so a repeat only adds
 * to the source list rather than replacing the entry.
 */
const BY_SELECTOR: Map<Hex, KnownError> = (() => {
  const map = new Map<Hex, KnownError>()
  const add = (item: AbiError, source: string): void => {
    const signature = signatureOf(item)
    const selector = toFunctionSelector(signature)
    const existing = map.get(selector)
    if (existing === undefined) {
      map.set(selector, { selector, signature, item, sources: [source] })
      return
    }
    if (!existing.sources.includes(source)) existing.sources.push(source)
  }
  for (const item of BUILT_INS) add(item, 'solidity')
  for (const { source, abi } of KNOWN_ABIS) {
    for (const item of abi) {
      if (item.type === 'error') add(item, source)
    }
  }
  return map
})()

/** Errors whose name does not, on its own, tell the user what to do next. */
const EXPLANATIONS: Record<string, { message: string; hint: string }> = {
  CurveGraduated: {
    message: 'the bonding curve has graduated, or has raised enough to',
    hint: "run 'pons graduate <token>', then trade the V4 pool with --route v4",
  },
  NotReadyToGraduate: {
    message: 'the curve has not raised its graduation threshold yet',
    hint: "'pons info <token>' shows how far along it is",
  },
  AlreadyGraduated: {
    message: 'this curve has already graduated',
    hint: 'trade the V4 pool with --route v4',
  },
  WrongGraduationPhase: {
    message: 'graduation is not at the phase this call expects',
    hint: "'pons info <token>' shows the phase; --phase selects one",
  },
  PairTokenNotApproved: {
    message: 'the quote asset is not on the approved pair token list',
    hint: "'pons pairs' lists every asset a launch may be quoted in",
  },
  ExemptionListTooLong: {
    message: 'more snipe tax exemptions than the contract accepts',
    hint: 'shorten --exempt; the creator and deployer are exempted automatically',
  },
  NotWhitelisted: {
    message: 'launching is restricted and this address is not on the list',
    hint: 'the factory has launchEnabled() off for everyone else',
  },
  LaunchFeeNotPaid: {
    message: 'the value sent is below the launch fee',
    hint: "'pons config list --configs' prints the live launch fee",
  },
  InvalidLaunchConfigId: {
    message: 'there is no launch config with that id',
    hint: "'pons config list --configs' lists the configs that exist",
  },
  LaunchConfigDisabled: {
    message: 'that launch config exists but is disabled',
    hint: "'pons config list --configs' shows which are enabled",
  },
  LaunchEconomicsMismatch: {
    message: 'the launch terms changed between preview and execution',
    hint: 'retry: the guard exists so a config change cannot alter your launch mid-flight',
  },
  PairTokenDecimalsMismatch: {
    message: "the quote asset's decimals are not what the launch declared",
    hint: 'USDG is 6-decimal where every other approved asset is 18',
  },
  TokenNotFound: {
    message: 'this factory has no record of that token',
    hint: 'the token may belong to the other generation of the launchpad',
  },
  VanitySaltNotFound: {
    message: 'no salt in the searched range produced the requested address suffix',
    hint: 'widen the search space',
  },
  SlippageExceeded: {
    message: 'the trade would return less than the minimum you accepted',
    hint: 'raise --slippage, or retry: the reserves moved after the quote',
  },
  MinimumOutputRequired: {
    message: 'the curve refuses a trade with no minimum output set',
    hint: 'pass --slippage rather than accepting any price',
  },
  InsufficientLiquidity: {
    message: 'the curve does not hold enough on one side to price this trade',
    hint: "'pons info <token>' shows the reserves",
  },
  InsufficientOutputAmount: {
    message: 'the trade is too small to return anything at this size',
    hint: 'increase the amount',
  },
  NativeValueMismatch: {
    message: 'the value sent does not match the amount the call declared',
    hint: 'this is a bug in the CLI, not something you can work around',
  },
  UnexpectedNativeValue: {
    message: 'ETH was sent to a launch that is quoted in an ERC-20',
    hint: "'pons info <token>' names the quote asset",
  },
  ERC20InsufficientAllowance: {
    message: 'the spender is not approved to move that many tokens',
    hint: "a curve sell needs an approval first; 'pons sell' does that for you",
  },
  InsufficientAllowance: {
    message: 'the spender is not approved to move that many tokens',
    hint: 'this is the quote asset refusing, not Pons; the approval above has to land first',
  },
  InsufficientBalance: {
    message: 'the wallet holds fewer of that asset than the call needs',
    hint: '',
  },
  ERC20InsufficientBalance: {
    message: 'the wallet holds fewer tokens than the transfer needs',
    hint: "'pons wallet balance --token <addr>' shows what it holds",
  },
  Error: { message: 'the contract reverted with a message', hint: '' },
  Panic: { message: 'the contract hit a Solidity panic', hint: '' },
}

/** Solidity panic codes, from the language documentation. */
const PANIC_CODES: Record<string, string> = {
  '0': 'generic compiler panic',
  '1': 'assertion failed',
  '17': 'arithmetic overflow or underflow',
  '18': 'division or modulo by zero',
  '33': 'invalid enum value',
  '34': 'malformed storage byte array',
  '49': 'pop on an empty array',
  '50': 'array index out of bounds',
  '65': 'out of memory',
  '81': 'call to an uninitialised function pointer',
}

export interface DecodedRevert {
  /** Four-byte selector, or `0x` when the call reverted with no data at all. */
  selector: Hex | null
  /** The error's name, or null when the selector matches nothing we know. */
  name: string | null
  signature: string | null
  /** Contracts that declare this error. Empty for an unknown selector. */
  sources: string[]
  /** Decoded arguments, rendered as strings so they survive JSON. */
  args: string[]
  /** Plain-language description. Always present, even for an unknown selector. */
  message: string
  hint: string | undefined
}

function stringify(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
}

/**
 * Decode revert data into a name, arguments and a next step.
 *
 * An unknown selector is reported as unknown rather than guessed at: the four
 * bytes are printed so the user can look them up, and no explanation is
 * invented for them.
 */
export function decodeRevert(data: Hex | undefined): DecodedRevert {
  if (data === undefined || data === '0x' || data.length < 10) {
    return {
      selector: null,
      name: null,
      signature: null,
      sources: [],
      args: [],
      message: 'the call reverted without returning a reason',
      hint: 'a plain `require` with no message, or a failed transfer, looks like this',
    }
  }

  const selector = data.slice(0, 10).toLowerCase() as Hex
  const known = BY_SELECTOR.get(selector)
  if (known === undefined) {
    return {
      selector,
      name: null,
      signature: null,
      sources: [],
      args: [],
      message: `unrecognised error ${selector}`,
      hint: 'no contract the CLI knows declares this error',
    }
  }

  let args: string[] = []
  try {
    const decoded = decodeErrorResult({ abi: [known.item], data })
    args = (decoded.args ?? []).map(stringify)
  } catch {
    // The selector matched but the payload did not decode. That is worth
    // saying rather than hiding: it usually means two errors share a selector.
    args = []
  }

  const explanation = EXPLANATIONS[known.item.name]
  const message = describe(known.item.name, args, explanation?.message)
  const hint = explanation?.hint === undefined || explanation.hint === '' ? undefined : explanation.hint

  return {
    selector,
    name: known.item.name,
    signature: known.signature,
    sources: known.sources,
    args,
    message,
    hint,
  }
}

/** Fold the decoded arguments into the sentence, where they carry meaning. */
function describe(name: string, args: string[], base: string | undefined): string {
  if (name === 'Error') return args[0] ?? 'the contract reverted with a message'
  if (name === 'Panic') {
    const code = args[0] ?? '0'
    const known = PANIC_CODES[code]
    return `Solidity panic ${code}${known === undefined || known === '' ? '' : `: ${known}`}`
  }
  if (base !== undefined) return base
  // No hand-written explanation: the name is the explanation. Keeping it
  // verbatim is better than paraphrasing an error we have not thought about.
  return name
}

/** Every error the CLI can name. Exposed so a test can prove the map is built. */
export function knownErrorCount(): number {
  return BY_SELECTOR.size
}
