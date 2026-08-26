import type { Address } from 'viem'

/**
 * Deployed contract addresses on Robinhood Chain (4663).
 *
 * Every address here was read from the chain on 2026-08-25, either directly
 * from the factory's own getters or by confirming non-empty bytecode. They are
 * addresses, not parameters: protocol *parameters* (fees, tax windows, approved
 * pair tokens) are read live at runtime and never hard-coded, because the
 * on-chain values drift from the contract source. See
 * `docs/architecture/ponscli.md`.
 */
export const addresses = {
  /**
   * `PonsLaunchFactory`: V1, Uniswap V3 based.
   *
   * **Closed to new launches.** `launchEnabled()` is false, set by the owner
   * on 2026-08-12, and that transaction is the last event the factory ever
   * emitted. Its 8,000-plus existing tokens still trade, which is what the V1
   * adapter is for.
   */
  v1Factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
  /** `PonsLaunchLocker`, holding every V1 launch's V3 position and fee routing. */
  v1Locker: '0x736d76699c26d0d966744cae304c000d471f7f35',
  /** `PonsV2LaunchFactory`: V2, a bonding curve graduating to Uniswap V4. */
  v2Factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',

  /** Shared immutable hook attached to every graduated V2 pool. */
  memeHook: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  /** Uniswap V4 `PoolManager`. */
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  /** `IPonsV2FeeEscrow`: creator and protocol fee accrual. */
  feeEscrow: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',
  /** `PonsV2BuybackVault`: five-year linear vesting of bought-back supply. */
  buybackVault: '0x42df2a798f82289e177311362e8f5ccc45c1219c',
  /** Executes the graduation sweep. */
  graduationExecutor: '0xc7819b64a1daecd7ec19856d026cb14efbd89046',
  /**
   * `PonsV2LaunchDeployer`, which CREATE2-deploys the curve/token pair. Its
   * `predictLaunchAddresses` is what makes a V2 address knowable before the
   * launch is sent.
   *
   * Unlike the satellites above, this one is **not immutable**:
   * `setLaunchDeployer` is `onlyOwner`. `readLaunchContext` reads it live and
   * the CLI uses that; this entry records what it was on 2026-08-25, for a
   * reader and for a test fixture.
   */
  launchDeployer: '0x3711cea4feade896c913c68f01eda97cb06d1a42',
  /**
   * `PonsV2LaunchAndBuy`, the factory's trusted `launchForwarder`. The only
   * route to an opening dev buy: the factory itself requires `msg.value` to
   * equal `launchFee()` exactly, so a launch and its first buy cannot share a
   * transaction any other way.
   *
   * Also owner-settable, and read live for the same reason. A rotated
   * forwarder would have `launchTokenFor` reject this CLI's dev buy with
   * `NotLaunchForwarder`.
   */
  launchAndBuy: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',

  /**
   * Uniswap V3 factory. Note this is a chain-local deployment, **not** the
   * canonical `0x1F98431c8aD98523631AE4a59f267346ea31F984`.
   */
  v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  v3PositionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  v3SwapRouter: '0xcaf681a66d020601342297493863e78c959e5cb2',

  /**
   * Uniswap V4 read and quote helpers. Both were confirmed to hold bytecode at
   * these addresses by `eth_getCode`.
   */
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  /** Uniswap V3 `QuoterV2`, the chain-local deploy. */
  v3Quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',

  /**
   * UniversalRouter, a **non-standard fork**. Its `V3_SWAP_EXACT_IN` input
   * carries a sixth field, a trailing `address[]`; omitting it makes the router
   * read past the input and revert `SliceOutOfBounds`. The V4 command input is
   * stock, which is what the live path uses.
   */
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  /** Canonical Permit2, same address as on every other chain. */
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',

  weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
} as const satisfies Record<string, Address>

/**
 * First block carrying a `PonsV2LaunchFactory` log.
 *
 * Used as the lower bound for historical log scans. It is deliberately derived
 * from logs: bisecting `eth_getCode` on a pruned node returns the pruning
 * boundary, roughly ten minutes of history, not the deployment block.
 */
export const V2_FACTORY_FIRST_LOG_BLOCK = 26_841_846n

/** Sentinel used by the protocol to mean "the native asset" rather than an ERC-20. */
export const NATIVE_PAIR_TOKEN: Address = '0x0000000000000000000000000000000000000000'
