import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem'

import { v1FactoryAbi } from '../../abi/index.js'
import { addresses } from '../../chain/addresses.js'
import { ExitCode, PonsError, UsageError } from '../../errors.js'
import { formatToken } from '../../output/format.js'
import { createPlan, warn, type Plan, type PlanWarning } from '../plan.js'
import type { Socials } from './v2launch.js'

/**
 * Creating a V1 launch.
 *
 * **Closed.** `launchEnabled()` is false — the owner set it on 2026-08-12 and
 * that transaction is the last log the factory ever emitted — so
 * `launchToken` reverts `NotWhitelisted` for everybody except an address on
 * the factory's whitelist. Confirmed by simulation against mainnet state.
 *
 * The path is built anyway, and gated rather than removed. `launchEnabled` is
 * one `onlyOwner` call away from being true again, and a CLI that has to be
 * rewritten the day that happens is worse than one that refuses today with a
 * reason. What the gate must not do is let somebody spend gas discovering it.
 */

/**
 * How V1 differs from V2, in the three places it matters for a launch.
 *
 * | | V1 | V2 |
 * |---|---|---|
 * | `msg.value` | `>= launchFee`; the excess **is** the opening buy | `== launchFee` exactly |
 * | Opening buy | folded into `launchToken` itself | needs `PonsV2LaunchAndBuy` |
 * | Salt namespace | not namespaced; the deployer is in the creation code | `keccak256(deployer, salt)` |
 *
 * The first is the one that has been got wrong before: V1 really does take a
 * dev buy as overpayment, and V2 really does not, and the two were conflated
 * in this project's own architecture document until each was read from source.
 */

export interface V1LaunchConfig {
  pairToken: Address
  graduationThreshold: bigint
  initialTick: number
  supply: bigint
  maxWalletBps: number
  maxTxBps: number
  restrictionBlocks: number
  reservedFee: number
  enabled: boolean
  routerRequiresDeadline: boolean
}

export interface V1DexConfig {
  name: string
  factory: Address
  positionManager: Address
  swapRouter: Address
  poolFee: number
  tickSpacing: number
  enabled: boolean
}

export interface V1LaunchContext {
  launchConfigId: bigint
  dexId: bigint
  config: V1LaunchConfig
  dex: V1DexConfig
  launchFee: bigint
  launchEnabled: boolean
  /** Whether this specific address is on the factory's whitelist. */
  whitelisted: boolean
}

export async function readV1LaunchContext(
  client: PublicClient,
  launchConfigId: bigint,
  dexId: bigint,
  account: Address,
): Promise<V1LaunchContext> {
  const factory = addresses.v1Factory
  const [config, dex, launchFee, launchEnabled, whitelisted] = await client.multicall({
    contracts: [
      { address: factory, abi: v1FactoryAbi, functionName: 'getLaunchConfig', args: [launchConfigId] },
      { address: factory, abi: v1FactoryAbi, functionName: 'getDexConfig', args: [dexId] },
      { address: factory, abi: v1FactoryAbi, functionName: 'launchFee' },
      { address: factory, abi: v1FactoryAbi, functionName: 'launchEnabled' },
      { address: factory, abi: v1FactoryAbi, functionName: 'whitelistedLaunchers', args: [account] },
    ],
    allowFailure: false,
  })
  return { launchConfigId, dexId, config: { ...config }, dex: { ...dex }, launchFee, launchEnabled, whitelisted }
}

export interface V1LaunchParams {
  name: string
  symbol: string
  logo: string
  description: string
  socials: Socials
  /** Earns the launch's position fees. Zero means the launcher. */
  feeWallet: Address
}

export interface V1LaunchIntent {
  params: V1LaunchParams
  launchConfigId: bigint
  dexId: bigint
  salt: Hex
  /** Native value above the launch fee. Spent on the opening buy. */
  devBuy: bigint
}

function tokenParamsOf(params: V1LaunchParams): {
  name: string
  symbol: string
  logo: string
  description: string
  socials: Socials
  feeWallet: Address
} {
  return {
    name: params.name,
    symbol: params.symbol,
    logo: params.logo,
    description: params.description,
    socials: params.socials,
    feeWallet: params.feeWallet,
  }
}

/**
 * Refuse a launch the factory would refuse.
 *
 * The whitelist check comes first because it is the one that is true today for
 * everybody, and being told about a name-length problem before being told the
 * factory is closed wastes the reader's attention on the wrong thing.
 */
export function validateV1Launch(intent: V1LaunchIntent, context: V1LaunchContext): void {
  if (!context.launchEnabled && !context.whitelisted) {
    throw new PonsError('V1_LAUNCHES_CLOSED', 'the V1 factory is closed to new launches', {
      exitCode: ExitCode.Usage,
      details: { launchEnabled: context.launchEnabled, whitelisted: context.whitelisted },
      hint: "launchEnabled() has been false since 2026-08-12 — 'pons launch' without --generation v1 uses V2",
    })
  }
  if (intent.params.name.trim() === '' || intent.params.symbol.trim() === '') {
    throw new UsageError('a launch needs both --name and --symbol')
  }
  if (!context.config.enabled) {
    throw new PonsError('LAUNCH_CONFIG_DISABLED', `V1 launch config ${intent.launchConfigId.toString()} is disabled`, {
      exitCode: ExitCode.Usage,
    })
  }
  if (!context.dex.enabled) {
    throw new PonsError('DEX_DISABLED', `V1 dex ${intent.dexId.toString()} (${context.dex.name}) is disabled`, {
      exitCode: ExitCode.Usage,
    })
  }
  if (intent.devBuy > 0n && context.dex.swapRouter === '0x0000000000000000000000000000000000000000') {
    throw new PonsError('ROUTER_NOT_SET', 'this dex has no swap router, so it cannot serve an opening buy', {
      exitCode: ExitCode.Usage,
    })
  }
}

/**
 * Where a V1 launch will land.
 *
 * Unlike V2 the salt is not namespaced by the launcher — `_computeCreate2Address`
 * hashes the raw salt against the factory's own address. The launcher still
 * decides the outcome, because they are one of the constructor arguments baked
 * into the creation code, which is why `predictTokenAddress` asks for the
 * deployer explicitly rather than inferring it from `msg.sender`.
 */
export async function predictV1TokenAddress(
  client: PublicClient,
  intent: V1LaunchIntent,
  deployer: Address,
): Promise<{ token: Address; taken: boolean }> {
  const token: Address = await client.readContract({
    address: addresses.v1Factory,
    abi: v1FactoryAbi,
    functionName: 'predictTokenAddress',
    args: [tokenParamsOf(intent.params), intent.launchConfigId, intent.dexId, intent.salt, deployer],
  })
  const code = await client.getCode({ address: token })
  return { token, taken: code !== undefined && code !== '0x' }
}

export function buildV1LaunchPlan(intent: V1LaunchIntent, context: V1LaunchContext): Plan {
  const { params } = intent
  const warnings: PlanWarning[] = [
    warn(
      'v1-legacy',
      'V1 is the older generation: no bonding curve, no snipe tax, and its liquidity position is locked forever rather than graduating',
      'info',
    ),
  ]
  if (context.config.restrictionBlocks > 0) {
    warnings.push(
      warn(
        'launch-restrictions',
        `for ${String(context.config.restrictionBlocks)} blocks after launch, buys are capped at ${String(context.config.maxTxBps / 100)}% of supply and wallets at ${String(context.config.maxWalletBps / 100)}%`,
        'info',
      ),
    )
  }
  if (intent.devBuy > 0n) {
    warnings.push(
      warn(
        'unbounded-dev-buy',
        "the factory's own opening buy sets no minimum output — it accepts whatever the fresh pool gives it",
        'warn',
      ),
    )
  }

  return createPlan({
    kind: 'launch',
    route: 'factory',
    to: addresses.v1Factory,
    data: encodeFunctionData({
      abi: v1FactoryAbi,
      functionName: 'launchToken',
      args: [tokenParamsOf(params), intent.launchConfigId, intent.dexId, intent.salt],
    }),
    // A floor, not an equality: V1 reads the excess as the opening buy.
    value: context.launchFee + intent.devBuy,
    gasLimit: undefined,
    summary:
      intent.devBuy > 0n
        ? `launch ${params.symbol} on V1 and open with ${formatToken(intent.devBuy, 18, 'ETH')}`
        : `launch ${params.symbol} (${params.name}) on V1`,
    warnings,
    economics: {
      launchFee: context.launchFee.toString(),
      devBuy: intent.devBuy.toString(),
      value: (context.launchFee + intent.devBuy).toString(),
      supply: context.config.supply.toString(),
      graduationThreshold: context.config.graduationThreshold.toString(),
      pairToken: context.config.pairToken,
      poolFee: context.dex.poolFee.toString(),
      salt: intent.salt,
    },
  })
}
