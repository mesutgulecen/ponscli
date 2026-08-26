import {
  encodeFunctionData,
  erc20Abi,
  isAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import { launchAndBuyAbi, launchDeployerAbi, memeHookAbi, v2FactoryAbi } from '../../abi/index.js'
import { NATIVE_PAIR_TOKEN, addresses } from '../../chain/addresses.js'
import { ExitCode, PonsError, UsageError } from '../../errors.js'
import { formatBps, formatToken } from '../../output/format.js'
import type { PairToken } from '../pairs.js'
import { createPlan, warn, type Plan, type PlanWarning } from '../plan.js'
import { BASIS_POINTS, quoteBuy, withSlippage, type CurveState } from '../quote.js'

/**
 * Creating a launch.
 *
 * Everything the factory checks before it deploys anything is checked here
 * first, against live state. A launch is the one operation in this CLI that
 * cannot be undone or retried cheaply — it spends the launch fee, it burns a
 * name and a symbol, and a mistake in the creator tax or the quote asset is
 * frozen into an immutable curve — so the failures worth catching are the ones
 * caught before the transaction is built.
 */

/**
 * Metadata length caps, in **bytes**, from `PonsV2LaunchDeployer`.
 *
 * Bytes, not characters: a name of twenty-two emoji is eighty-eight bytes and
 * a launch that measured it in characters would look fine here and revert with
 * `MetadataTooLong` on chain. `Buffer.byteLength` is what the contract counts.
 */
export const METADATA_LIMITS = {
  name: 64,
  symbol: 16,
  logo: 512,
  description: 2048,
  social: 256,
} as const

/**
 * Combined trade fee ceiling, `MAX_TOTAL_TRADE_FEE_BPS` in the factory.
 *
 * Applied twice, against the config's own curve fee and against the hook's fee.
 * Unreachable while both legs cap at 1,000 bps, and checked anyway because the
 * ceilings are owner-settable and the factory checks it too.
 */
const MAX_TOTAL_TRADE_FEE_BPS = 2_000n

/**
 * Exemption list cap, `MAX_SNIPE_TAX_EXEMPTIONS` in the factory.
 *
 * The atomic path spends one entry on the buy recipient, which the router
 * appends whether or not the caller listed them, so a dev buy leaves 31.
 */
export const MAX_SNIPE_TAX_EXEMPTIONS = 32
export const MAX_SNIPE_TAX_EXEMPTIONS_WITH_DEV_BUY = MAX_SNIPE_TAX_EXEMPTIONS - 1

export interface Socials {
  twitter: string
  telegram: string
  discord: string
  website: string
  farcaster: string
}

export const EMPTY_SOCIALS: Socials = {
  twitter: '',
  telegram: '',
  discord: '',
  website: '',
  farcaster: '',
}

export interface FeePolicySnapshot {
  protocolFeeRecipient: Address
  protocolFeeShareBps: number
  buybackBurnBps: number
  hookFeeBps: number
  maxInternalPriceImpactBps: number
}

export interface LaunchConfig {
  supply: bigint
  curveFeeBps: bigint
  phantomQuote: bigint
  graduationThreshold: bigint
  poolFee: number
  tickSpacing: number
  enabled: boolean
}

/** Everything the factory would consult, read in one round trip. */
export interface LaunchContext {
  configId: bigint
  config: LaunchConfig
  policy: FeePolicySnapshot
  launchFee: bigint
  launchEnabled: boolean
  /** Whether this specific account may launch right now. */
  canLaunch: boolean
  maxCreatorTaxBps: bigint
  snipeTaxStartBps: bigint
  snipeTaxSeconds: bigint
  /**
   * The CREATE2 deployer and the atomic launch router, read live.
   *
   * Both are `onlyOwner`-settable rather than immutable, unlike the rest of the
   * factory's satellites. `src/chain/addresses.ts` records what they were, and
   * this is what they are: a rotated forwarder would make `launchTokenFor`
   * reject the CLI's dev buy with `NotLaunchForwarder`, and a rotated deployer
   * would make every predicted address wrong without anything failing.
   */
  launchDeployer: Address
  launchForwarder: Address
  /**
   * The digest that pins every owner-controlled term of a native launch.
   *
   * Read from `previewLaunchEconomics` and passed back verbatim. Computing it
   * here from the ten values would work and would be wrong to do: the point of
   * the pin is that the creator commits to what the contract told them, and a
   * locally derived digest only proves this CLI agrees with itself.
   */
  economics: Hex
}

export async function readLaunchContext(
  client: PublicClient,
  configId: bigint,
  account: Address,
): Promise<LaunchContext> {
  const factory = addresses.v2Factory as Address
  const [
    config,
    policy,
    launchFee,
    launchEnabled,
    canLaunch,
    maxCreatorTaxBps,
    startBps,
    seconds,
    economics,
    launchDeployer,
    launchForwarder,
  ] = await client.multicall({
      contracts: [
        { address: factory, abi: v2FactoryAbi, functionName: 'getLaunchConfig', args: [configId] },
        { address: addresses.memeHook, abi: memeHookAbi, functionName: 'currentFeePolicy' },
        { address: factory, abi: v2FactoryAbi, functionName: 'launchFee' },
        { address: factory, abi: v2FactoryAbi, functionName: 'launchEnabled' },
        { address: factory, abi: v2FactoryAbi, functionName: 'canLaunch', args: [account] },
        { address: factory, abi: v2FactoryAbi, functionName: 'maxCreatorTaxBps' },
        { address: factory, abi: v2FactoryAbi, functionName: 'snipeTaxStartBps' },
        { address: factory, abi: v2FactoryAbi, functionName: 'snipeTaxSeconds' },
        {
          address: factory,
          abi: v2FactoryAbi,
          functionName: 'previewLaunchEconomics',
          args: [configId, NATIVE_PAIR_TOKEN],
        },
        { address: factory, abi: v2FactoryAbi, functionName: 'launchDeployer' },
        { address: factory, abi: v2FactoryAbi, functionName: 'launchForwarder' },
      ],
      allowFailure: false,
    })

  return {
    configId,
    config: { ...config },
    policy: { ...policy },
    launchFee,
    launchEnabled,
    canLaunch,
    maxCreatorTaxBps,
    snipeTaxStartBps: startBps,
    snipeTaxSeconds: seconds,
    economics,
    launchDeployer,
    launchForwarder,
  }
}

/**
 * The economics digest for one quote asset.
 *
 * Read separately from the rest of the context because the quote asset is only
 * known once `--pair` has been resolved against the live approved list, and a
 * digest taken for the wrong asset would pin terms the launch never uses.
 */
export async function readEconomicsGuard(
  client: PublicClient,
  configId: bigint,
  pairToken: Address,
): Promise<Hex> {
  return client.readContract({
    address: addresses.v2Factory,
    abi: v2FactoryAbi,
    functionName: 'previewLaunchEconomics',
    args: [configId, pairToken],
  })
}

export interface LaunchParams {
  name: string
  symbol: string
  logo: string
  description: string
  socials: Socials
  creatorFeeRecipient: Address
  creatorTaxBps: number
  buybackEnabled: boolean
  expectedEconomics: Hex
  salt: Hex
}

export interface LaunchIntent {
  params: LaunchParams
  configId: bigint
  pair: PairToken
  exemptions: readonly Address[]
  /** Quote asset the opening buy spends. Zero means no dev buy. */
  devBuy: bigint
  /** Slippage floor applied to the opening buy, in basis points. */
  slippageBps: bigint
  /** Receives the opening buy. The launcher unless told otherwise. */
  recipient: Address
  /**
   * Where the launch will land, once `predictLaunchAddresses` has said.
   *
   * Carried on the plan's economics rather than reported separately, so a
   * command still emits exactly one payload and an agent reading the JSON gets
   * the token's address without a second call.
   */
  predicted?: { token: Address; curve: Address }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

const ZERO_DIGEST: Hex = `0x${'0'.repeat(64)}`

/**
 * Reject a launch the factory would reject, before it is built.
 *
 * The order matters less than the completeness: each of these corresponds to a
 * specific `revert` in `_launchToken`, `_exemptFromSnipeTax` or
 * `_requireMetadataWithinLimits`, and reaching the chain to be told any of
 * them costs a round trip and, on the atomic path, reads as a failed launch.
 */
export function validateLaunch(intent: LaunchIntent, context: LaunchContext): void {
  const { params } = intent

  if (params.name.trim() === '' || params.symbol.trim() === '') {
    throw new UsageError('a launch needs both --name and --symbol')
  }
  const overlong = (
    [
      ['name', params.name, METADATA_LIMITS.name],
      ['symbol', params.symbol, METADATA_LIMITS.symbol],
      ['logo', params.logo, METADATA_LIMITS.logo],
      ['desc', params.description, METADATA_LIMITS.description],
      ['twitter', params.socials.twitter, METADATA_LIMITS.social],
      ['telegram', params.socials.telegram, METADATA_LIMITS.social],
      ['discord', params.socials.discord, METADATA_LIMITS.social],
      ['website', params.socials.website, METADATA_LIMITS.social],
      ['farcaster', params.socials.farcaster, METADATA_LIMITS.social],
    ] as const
  ).find(([, value, limit]) => byteLength(value) > limit)
  if (overlong !== undefined) {
    const [field, value, limit] = overlong
    throw new UsageError(
      `--${field} is ${String(byteLength(value))} bytes; the contract accepts ${String(limit)}`,
    )
  }

  if (!context.config.enabled) {
    throw new PonsError('LAUNCH_CONFIG_DISABLED', `launch config ${context.configId.toString()} is disabled`, {
      exitCode: ExitCode.Usage,
      hint: "'pons config list --configs' shows which are enabled",
    })
  }
  if (!context.canLaunch) {
    throw new PonsError('NOT_WHITELISTED', 'launching is disabled and this address is not whitelisted', {
      exitCode: ExitCode.Usage,
      details: { launchEnabled: context.launchEnabled },
    })
  }

  const creatorTax = BigInt(params.creatorTaxBps)
  if (creatorTax > context.maxCreatorTaxBps) {
    throw new UsageError(
      `--creator-tax is ${formatBps(creatorTax)}; the factory currently caps it at ${formatBps(context.maxCreatorTaxBps)}`,
    )
  }
  if (context.config.curveFeeBps + creatorTax > MAX_TOTAL_TRADE_FEE_BPS) {
    throw new UsageError(
      `the config's ${formatBps(context.config.curveFeeBps)} curve fee plus a ${formatBps(creatorTax)} creator tax exceeds the ${formatBps(MAX_TOTAL_TRADE_FEE_BPS)} combined ceiling`,
    )
  }
  if (BigInt(context.policy.hookFeeBps) + creatorTax > MAX_TOTAL_TRADE_FEE_BPS) {
    throw new UsageError(
      `the hook's ${formatBps(context.policy.hookFeeBps)} pool fee plus a ${formatBps(creatorTax)} creator tax exceeds the ${formatBps(MAX_TOTAL_TRADE_FEE_BPS)} combined ceiling`,
    )
  }

  const cap = intent.devBuy > 0n ? MAX_SNIPE_TAX_EXEMPTIONS_WITH_DEV_BUY : MAX_SNIPE_TAX_EXEMPTIONS
  if (intent.exemptions.length > cap) {
    const because = intent.devBuy > 0n ? ', since the router appends the buy recipient' : ''
    throw new UsageError(
      `--exempt lists ${String(intent.exemptions.length)} addresses; at most ${String(cap)} are accepted${because}`,
    )
  }
  for (const address of intent.exemptions) {
    if (!isAddress(address, { strict: false })) {
      throw new UsageError(`--exempt ${String(address)} is not an address`)
    }
  }

  // The factory re-reads the quote asset's decimals at launch and reverts on a
  // mismatch. Catching it here says which asset and by how much, rather than
  // leaving a `PairTokenDecimalsMismatch` selector to explain itself.
  if (!intent.pair.native && intent.pair.decimals !== intent.pair.expectedDecimals) {
    throw new PonsError(
      'PAIR_DECIMALS_MISMATCH',
      `${intent.pair.symbol} reports ${String(intent.pair.decimals)} decimals but the factory sized its economics for ${String(intent.pair.expectedDecimals)}`,
      {
        exitCode: ExitCode.Usage,
        hint: 'launches against this asset revert until the protocol owner re-pegs it',
      },
    )
  }

  if (intent.devBuy < 0n) throw new UsageError('--dev-buy cannot be negative')
  if (params.expectedEconomics === ZERO_DIGEST) {
    // Zero waives the check on chain. Nothing in this CLI should ever produce
    // it: the guard is the only thing standing between a launch and an owner
    // re-peg that lands underneath it.
    throw new PonsError('NO_ECONOMICS_GUARD', 'refusing to launch without an economics guard', {
      exitCode: ExitCode.Failure,
      hint: 'this is a bug — previewLaunchEconomics should have supplied one',
    })
  }
}

/** The curve as it stands the instant it is created. */
export function openingCurveState(
  config: LaunchConfig,
  pair: PairToken,
  creatorTaxBps: number,
): CurveState {
  const phantomQuote = pair.native ? config.phantomQuote : pair.phantomQuote
  const threshold = pair.native ? config.graduationThreshold : pair.graduationThreshold
  return {
    quoteReserve: phantomQuote,
    tokenReserve: config.supply,
    // `initialize` sets exactly this: supply * phantom / (phantom + threshold).
    reservedTokens: (config.supply * phantomQuote) / (phantomQuote + threshold),
    curveFeeBps: config.curveFeeBps,
    creatorTaxBps: BigInt(creatorTaxBps),
  }
}

/**
 * A salt nobody else can have taken.
 *
 * The deployer namespaces it as `keccak256(deployer, salt)`, so it only has to
 * be unique among one account's own launches. Deriving it from the launch's own
 * metadata makes a repeat of the same launch collide — which is the useful
 * behaviour, since that collision is a second launch of a token that already
 * exists — while two different launches never do.
 */
export function saltFor(params: Pick<LaunchParams, 'name' | 'symbol'>, nonce: string): Hex {
  return keccak256(toHex(`${params.name} ${params.symbol} ${nonce}`))
}

interface LaunchDeployment {
  pairToken: Address
  creatorFeeRecipient: Address
  originalDeployer: Address
  feePolicy: Address
  policy: FeePolicySnapshot
  feeEscrow: Address
  buybackVault: Address
  phantomQuote: bigint
  curveFeeBps: bigint
  creatorTaxBps: bigint
  buybackEnabled: boolean
  graduationThreshold: bigint
  supply: bigint
  salt: Hex
  name: string
  symbol: string
  logo: string
  description: string
  socials: Socials
}

/** The struct `PonsV2LaunchDeployer` hashes into a CREATE2 address. */
function deploymentStruct(
  intent: LaunchIntent,
  context: LaunchContext,
  deployer: Address,
): LaunchDeployment {
  const { params, pair } = intent
  return {
    pairToken: pair.address,
    // The factory substitutes the deployer for a zero recipient before it
    // reaches the CREATE2 preimage, so the prediction has to do the same or it
    // computes an address the launch will not land at.
    creatorFeeRecipient:
      params.creatorFeeRecipient === NATIVE_PAIR_TOKEN ? deployer : params.creatorFeeRecipient,
    originalDeployer: deployer,
    feePolicy: addresses.memeHook,
    policy: context.policy,
    feeEscrow: addresses.feeEscrow,
    buybackVault: addresses.buybackVault,
    phantomQuote: pair.native ? context.config.phantomQuote : pair.phantomQuote,
    curveFeeBps: context.config.curveFeeBps,
    creatorTaxBps: BigInt(params.creatorTaxBps),
    buybackEnabled: params.buybackEnabled,
    graduationThreshold: pair.native ? context.config.graduationThreshold : pair.graduationThreshold,
    supply: context.config.supply,
    salt: params.salt,
    name: params.name,
    symbol: params.symbol,
    logo: params.logo,
    description: params.description,
    socials: params.socials,
  }
}

/**
 * Where this launch will land, before it is sent.
 *
 * V2 deploys its curve and token with CREATE2 from a salt the creator chooses,
 * so both addresses are knowable in advance and cannot be taken by a launch
 * that confirms first. This is also the check for a reused salt: the same
 * creator relaunching on identical terms reverts inside `Create2`, and a
 * predicted address that already holds code is that revert, seen early.
 */
export async function predictLaunchAddresses(
  client: PublicClient,
  intent: LaunchIntent,
  context: LaunchContext,
  deployer: Address,
): Promise<{ token: Address; curve: Address; taken: boolean }> {
  const [token, curve] = await client.readContract({
    address: context.launchDeployer,
    abi: launchDeployerAbi,
    functionName: 'predictLaunchAddresses',
    args: [deploymentStruct(intent, context, deployer)],
  })
  const code = await client.getCode({ address: curve })
  return { token, curve, taken: code !== undefined && code !== '0x' }
}

export interface LaunchEconomics {
  /** What the launch itself costs, before any opening buy. */
  launchFee: bigint
  /** Quote actually spent on the opening buy, zero when there is none. */
  devBuy: bigint
  /** Native value the transaction must carry. */
  value: bigint
  /** Tokens the opening buy receives, and the floor it is held to. */
  tokensOut: bigint
  minTokensOut: bigint
  /** Share of the whole supply the opening buy takes. */
  supplyShareBps: bigint
  /** Tokens the curve will never sell, handed to the V4 pool at graduation. */
  reservedTokens: bigint
  sellableTokens: bigint
}

export function previewEconomics(intent: LaunchIntent, context: LaunchContext): LaunchEconomics {
  const state = openingCurveState(context.config, intent.pair, intent.params.creatorTaxBps)
  const sellable = state.tokenReserve - state.reservedTokens

  if (intent.devBuy === 0n) {
    return {
      launchFee: context.launchFee,
      devBuy: 0n,
      value: context.launchFee,
      tokensOut: 0n,
      minTokensOut: 0n,
      supplyShareBps: 0n,
      reservedTokens: state.reservedTokens,
      sellableTokens: sellable,
    }
  }

  // No snipe tax: the router appends the buy's recipient to the exemption list
  // precisely because the dev buy lands in the launch second, when the tax is
  // at its 99% peak.
  const quote = quoteBuy(state, intent.devBuy, 0n)
  return {
    launchFee: context.launchFee,
    devBuy: quote.spent,
    value: intent.pair.native ? context.launchFee + intent.devBuy : context.launchFee,
    tokensOut: quote.tokensOut,
    minTokensOut: withSlippage(quote.tokensOut, intent.slippageBps),
    supplyShareBps: (quote.tokensOut * BASIS_POINTS) / context.config.supply,
    reservedTokens: state.reservedTokens,
    sellableTokens: sellable,
  }
}

function launchWarnings(
  intent: LaunchIntent,
  context: LaunchContext,
  economics: LaunchEconomics,
): PlanWarning[] {
  const warnings: PlanWarning[] = []
  const { params, pair } = intent

  if (params.buybackEnabled) {
    warnings.push(
      warn(
        'buyback',
        `the buyback vault is funded entirely from your creator fee share and releases over five years, of which ${formatBps(context.policy.protocolFeeShareBps)} goes to the protocol — it is not a holder distribution`,
        'warn',
      ),
    )
  }
  if (params.creatorTaxBps === 0) {
    warnings.push(warn('no-creator-tax', 'this launch charges no creator tax and cannot add one later', 'info'))
  }
  if (intent.exemptions.length > 0) {
    warnings.push(
      warn(
        'exemptions-final',
        'snipe-tax exemptions are written in the launch transaction and can never be added afterwards',
        'info',
      ),
    )
  }
  if (!pair.native) {
    warnings.push(
      warn(
        'quote-asset',
        `this launch collects ${pair.symbol} rather than ETH, and graduates into a ${pair.symbol}-keyed pool`,
        'info',
      ),
    )
  }
  if (economics.devBuy > 0n && economics.supplyShareBps >= 2_000n) {
    warnings.push(
      warn(
        'large-dev-buy',
        `the opening buy takes ${formatBps(economics.supplyShareBps)} of the total supply`,
        economics.supplyShareBps >= 5_000n ? 'danger' : 'warn',
      ),
    )
  }
  if (economics.devBuy > 0n && economics.devBuy < intent.devBuy) {
    warnings.push(
      warn(
        'partial-fill',
        `only ${formatToken(economics.devBuy, pair.decimals, pair.symbol)} of the opening buy fits before the curve reaches its reserved allocation; the rest is refunded in the same transaction`,
        'warn',
      ),
    )
  }
  return warnings
}

function predictedFields(intent: LaunchIntent): Record<string, string> {
  if (intent.predicted === undefined) return {}
  return { token: intent.predicted.token, curve: intent.predicted.curve }
}

function tokenParamsOf(params: LaunchParams): {
  name: string
  symbol: string
  logo: string
  description: string
  socials: Socials
  creatorFeeRecipient: Address
  creatorTaxBps: number
  buybackEnabled: boolean
  expectedEconomics: Hex
  salt: Hex
} {
  return {
    name: params.name,
    symbol: params.symbol,
    logo: params.logo,
    description: params.description,
    socials: params.socials,
    creatorFeeRecipient: params.creatorFeeRecipient,
    creatorTaxBps: params.creatorTaxBps,
    buybackEnabled: params.buybackEnabled,
    expectedEconomics: params.expectedEconomics,
    salt: params.salt,
  }
}

/**
 * A launch with no opening buy, straight at the factory.
 *
 * `msg.value` must **equal** `launchFee()`, not merely cover it: the factory
 * checks `msg.value != launchFee` and reverts on anything else, so there is no
 * such thing as folding a dev buy into this call by overpaying.
 */
export function buildLaunchPlan(intent: LaunchIntent, context: LaunchContext): Plan {
  const economics = previewEconomics(intent, context)
  const { params } = intent
  const threshold = intent.pair.native
    ? context.config.graduationThreshold
    : intent.pair.graduationThreshold
  return createPlan({
    kind: 'launch',
    route: 'factory',
    to: addresses.v2Factory,
    data: encodeFunctionData({
      abi: v2FactoryAbi,
      functionName: 'launchToken',
      args: [tokenParamsOf(params), intent.configId, intent.pair.address, [...intent.exemptions]],
    }),
    value: context.launchFee,
    gasLimit: undefined,
    summary: `launch ${params.symbol} (${params.name}) against ${intent.pair.symbol}`,
    warnings: launchWarnings(intent, context, economics),
    economics: {
      ...predictedFields(intent),
      launchFee: economics.launchFee.toString(),
      supply: context.config.supply.toString(),
      reservedTokens: economics.reservedTokens.toString(),
      sellableTokens: economics.sellableTokens.toString(),
      graduationThreshold: threshold.toString(),
      curveFeeBps: context.config.curveFeeBps.toString(),
      creatorTaxBps: params.creatorTaxBps.toString(),
      expectedEconomics: params.expectedEconomics,
      salt: params.salt,
    },
  })
}

/**
 * A launch and its opening buy in one transaction.
 *
 * Routed through `PonsV2LaunchAndBuy`, the factory's trusted `launchForwarder`,
 * because the factory itself cannot do it: `launchToken` demands exact payment
 * of the launch fee, so a first buy has to be a second transaction against a
 * curve that is already public. The gap is not theoretical — the router's own
 * documentation records a launch bought out by twenty-two addresses within two
 * blocks of opening, leaving the creator with nothing.
 */
export function buildLaunchAndBuyPlan(intent: LaunchIntent, context: LaunchContext): Plan {
  const economics = previewEconomics(intent, context)
  const { params, pair } = intent
  return createPlan({
    kind: 'launch',
    route: 'factory',
    to: context.launchForwarder,
    data: encodeFunctionData({
      abi: launchAndBuyAbi,
      functionName: 'launchAndBuy',
      args: [
        tokenParamsOf(params),
        intent.configId,
        pair.address,
        intent.devBuy,
        economics.minTokensOut,
        intent.recipient,
        [...intent.exemptions],
      ],
    }),
    // Native: the fee and the buy travel together, and the router checks the
    // sum exactly. ERC-20: the fee only, with the buy pulled by transferFrom.
    value: economics.value,
    gasLimit: undefined,
    summary: `launch ${params.symbol} and open with ${formatToken(intent.devBuy, pair.decimals, pair.symbol)} for ${formatToken(economics.tokensOut, 18, params.symbol)}`,
    warnings: launchWarnings(intent, context, economics),
    economics: {
      ...predictedFields(intent),
      launchFee: economics.launchFee.toString(),
      devBuy: intent.devBuy.toString(),
      value: economics.value.toString(),
      tokensOut: economics.tokensOut.toString(),
      minTokensOut: economics.minTokensOut.toString(),
      supplyShareBps: economics.supplyShareBps.toString(),
      supply: context.config.supply.toString(),
      reservedTokens: economics.reservedTokens.toString(),
      sellableTokens: economics.sellableTokens.toString(),
      expectedEconomics: params.expectedEconomics,
      salt: params.salt,
    },
  })
}

/**
 * Approve the router to pull an ERC-20 opening buy.
 *
 * Only for a non-native quote asset: the router takes the buy with
 * `transferFrom` and carries the launch fee as native value in the same call.
 */
export function buildLaunchApprovalPlan(pair: PairToken, amount: bigint, router: Address): Plan {
  return createPlan({
    kind: 'approve',
    route: 'erc20',
    to: pair.address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [router, amount],
    }),
    value: 0n,
    gasLimit: undefined,
    summary: `approve the launch router to pull ${formatToken(amount, pair.decimals, pair.symbol)}`,
    warnings: [],
    economics: { spender: router, amount: amount.toString() },
  })
}
