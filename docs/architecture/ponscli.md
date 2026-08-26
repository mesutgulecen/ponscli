# ponscli: architecture and development plan

**TL;DR.** `ponscli` is a TypeScript + viem CLI for the **Pons** launchpad on Robinhood Chain (4663), designed for developers and agents alike. No source is copied from any repository: the command surface is derived from a behavioural map of `chainstacklabs/pumpfun-cli`, and the RPC policy from measurements taken against this chain's own endpoints. The default mode is **read-only**: the CLI runs without ever seeing a key, and signing is an explicit opt-in. RPC is a two-tier waterfall: round-robin across free endpoints in Tier 1, paid Alchemy in Tier 2 only once Tier 1 is fully exhausted. Both Pons **V1 and V2** are supported. V1's factory is **retired**, in that `launchEnabled()` is false and the last log it ever emitted is the owner switching it off ([see](#v1-was-switched-off-and-its-tokens-still-trade)). Its thousands of tokens still hold liquidity and still trade, so V1 support is a read-and-trade adapter with a gated launch path.

This document is the single reference for `ponscli`: architectural decisions, measured protocol facts, command surface and phase plan.

## Contents

- [Decisions](#decisions)
- [Chain facts](#chain-facts)
- [Protocol facts](#protocol-facts)
- [Layer architecture](#layer-architecture)
- [RPC layer](#rpc-layer)
- [Command surface](#command-surface)
- [Swap path and self-routing](#swap-path-and-self-routing)
- [Security model](#security-model)
- [Error decoding](#error-decoding)
- [Indexing and cache](#indexing-and-cache)
- [Test strategy](#test-strategy)
- [Agent surface](#agent-surface)
- [Development plan](#development-plan)
- [Facts most likely to be re-derived wrongly](#facts-most-likely-to-be-re-derived-wrongly)
- [Open questions](#open-questions)

---

## Decisions

| Topic | Decision | Rationale |
|---|---|---|
| Stack | **TypeScript + viem** | Fallback transport, Multicall3 and ABI type inference come from the library. Pons's own docs use viem in their examples. |
| Package | `ponscli` → binary `pons` | Free on npm (checked 2026-08-25). Matches the directory name. |
| Origin | Written from scratch | The reference repo is Apache-2.0; since no code is taken, no attribution obligation arises and we choose our own licence. |
| Protocol scope | **V1 + V2, full support** | Done. V1's launch path is gated: the factory is closed. |
| Signing | **Read-only default**, signing opt-in | So an agent cannot sign by accident. Three tiers: read-only → `--unsigned` → `--keystore`. |
| ERC-20 discovery | Tracked list + auto-add | EVM has no `getTokenAccountsByOwner`. `pons buy` adds the purchased token to the list automatically. |
| RPC | Two-tier waterfall | Tier 1 round-robin (free), Tier 2 Alchemy only once Tier 1 is exhausted. |
| Discovery commands | Out of v1 scope | Pons has no frontend API; these require our own index. |
| Swap path | Self-routing **selector no**, encoder yes | One canonical pool per token; the contract hands you the PoolKey. There is no venue to select. |
| V4 swap path | End of Phase 3 | Being unable to sell a graduated token is a real gap: the user is stuck in a position. |
| Permit2 | Signed permit on every sell | Leaves no standing allowance, needs no extra approval transaction or gas. |
| Aggregator fallback | **None** | Only one pool exists; an aggregator would route to the same pool. No gain for the added dependency. |
| Licence | **MIT** | The code is ours, so no obligation is inherited. MIT is the lowest-friction choice for the developer and agent audience. |
| Repository layout | **Single package** | The waterfall lives in `src/chain/` and knows nothing about Pons, but it is not extracted into a package of its own. A monorepo's build and versioning overhead buys nothing at this size. |
| Argument parsing | **commander** | Zero transitive dependencies and `exitOverride()` plus `configureOutput()` give complete control over exit codes and error rendering, which is what `--json` structured errors require. |
| Configuration | **Flat JSON, XDG path** | `$XDG_CONFIG_HOME/ponscli/config.json`, mode 0600. Flat dotted keys mean `config set` has no merge semantics to get wrong and an agent editing the file sees exactly the keys `config list` prints. |

---

## Chain facts

All measured directly on **2026-08-25**.

| | |
|---|---|
| Chain ID | **4663** (`eth_chainId` → `0x1237`); testnet 46630 |
| Type | Arbitrum **Nitro** Orbit L2, EVM, native gas **ETH** |
| Block time | **~0.1 s** (200 blocks / 20 s) → ~864,000 blocks per day |
| RPC (official) | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `robinhoodchain.blockscout.com` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11`, **deployed** (7,618 hex bytecode) |
| Batch JSON-RPC | **Supported** (verified with a 3-method batch) |
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |
| Uniswap V3 Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, RH-local, **not** the canonical `0x1F98…` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904`, deployed (49,094 hex) |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3`, canonical, deployed (18,306 hex) |

### The official RPC is not an archive node

State older than roughly **6,000–10,000 blocks (~10–17 minutes)** is pruned:

```
eth_getCode(V2Factory, head-6200)    → 48356 hex  OK
eth_getCode(V2Factory, head-10000)   → -32000 "metadata is not found, 45538722"
eth_getCode(V2Factory, head-1000000) → -32000 "metadata is not found, 44548722"
```

**Logs go back far further than state does.** `eth_getLogs` served results from 26.8M blocks ago on the same endpoint. So historical *events* are available on the free tier; historical *state* is not.

Consequences for the CLI:

- Never pass a historical `blockTag` to a read on Tier 1. Anything not `latest` needs Tier 2.
- A binary search for a contract's deployment block via `eth_getCode` finds **the pruning boundary, not the deployment**. Derive deployment from the first log instead.
- Any feature needing point-in-time state (historical balance, price at block N) is a Tier 2 feature by construction. Say so in its help text rather than failing obscurely.

### `eth_getLogs` limits

There is **no** hard block-range cap, but there is a query timeout:

```
span=  500,000 blocks -> 2,561 logs,  ~1 s   OK
span=1,000,000 blocks -> 3,626 logs,  ~1 s   OK
span=5,000,000 blocks -> -32000 "log query timed out"
```

The same timeout reappeared on the **11th consecutive** 1M-block query: the limit is not per-query but a cumulative budget on the node. Safe chunk: **500k blocks**, with pacing between consecutive scans.

There is a second, separate ceiling on the **result set**: a query matching more than 10,000 logs is refused with `-32000 "logs matched by query exceeds limit of 10000"` (measured 2026-08-25 on an unfiltered 2,000-block window). A scan therefore has to bound both how many blocks it asks for and how many logs those blocks can contain. A topic filter is what usually keeps it under, and an unfiltered scan needs far smaller chunks than a filtered one.

### The Nitro gas trap

**A native ETH transfer must not be signed with a 21000 gas limit.** Nitro's `GasChargingHook` charges the L1 poster cost **out of the transaction's own gas limit**: after the 21000 intrinsic is deducted, `gasRemaining < posterCostInL2Gas` → `intrinsic gas too low`. OP-stack (Base) charges its L1 fee *outside* the limit, which is why an "EVM == Base" assumption leaks here.

Measured on 2026-07-24: every plain EOA→EOA transfer landing on RH burned `gasUsed` **21086–21145** (= 21000 + 86..145 poster gas). **`eth_estimateGas` does not protect you**, because the node answers `0x5208` for the same transfer, excluding the poster component. The only fix is fixed headroom on the signed limit; `ponscli` signs every native transfer at a fixed **100,000**.

It fails **intermittently**: when L1 is cheap the poster cost rounds to zero and 21000 works, so the path can look healthy for weeks. `pons wallet transfer` and `pons wallet sweep` must use this constant.

---

## Protocol facts

### Factories

| Generation | Contract | Address |
|---|---|---|
| V1 | `PonsLaunchFactory` | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` |
| V2 | `PonsV2LaunchFactory` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |

V2 is verified on Sourcify (solc 0.8.35, viaIR, cancun). The ABI is fetched from Sourcify **once** and committed to the repo; there is no runtime dependency on it.

The V2 factory's first emitted log is at block **26,841,846**, roughly 21.6 days of history at 0.1 s per block.

### V2 satellite contracts

Read live from the factory (2026-08-25). All are `immutable`, so derive them from the factory address rather than hardcoding.

| Role | Address |
|---|---|
| `memeHook()` | `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` |
| `poolManager()` (Uniswap V4) | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| `feeEscrow()` | `0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e` |
| `buybackVault()` | `0x42df2a798f82289e177311362e8f5ccc45c1219c` |
| `graduationExecutor()` | `0xc7819b64a1daecd7ec19856d026cb14efbd89046` |
| `launchDeployer()` | `0x3711cea4feade896c913c68f01eda97cb06d1a42` |
| `launchForwarder()` | `0xe33e9e479df8802cb0866d5d05258bec4cf62948` |
| `graduationGuard()` | `0xf5695117b99b6f6401e67d4195bd653628176c6c` |

`launchDeployer` and `launchForwarder` are **settable, not immutable**: `setLaunchDeployer` and `setLaunchForwarder` are both `onlyOwner`. They are read from the factory rather than trusted from this table; the addresses here are what it answered on 2026-08-25. Both are Sourcify `exact_match`: `PonsV2LaunchDeployer` and `PonsV2LaunchAndBuy`. `graduationGuard` is verified nowhere.

`poolManager()` matches the RH V4 PoolManager address confirmed by `eth_getCode` [below](#verified-execution-addresses), which is a cross-confirmation.

**Live `memeHook.currentFeePolicy()`:**

| Field | Value |
|---|---|
| `protocolFeeShareBps` | 3000 (30%) |
| `buybackBurnBps` | 5000 (50%) |
| `hookFeeBps` | 100 (1%) |
| `maxInternalPriceImpactBps` | 300 (3%) |

These are **snapshotted at launch** (`FeePolicySnapshot`), so a later policy change never affects existing launches. When `pons info` shows the effective fee before a trade it must read the token's **own** snapshot, not the current global policy.

### Two contracts are deployed per launch and verified nowhere

The bonding curve and the launch token are deployed once per launch. **No instance of either is verified**: Sourcify has no record and Blockscout answers `Not found`, so there is no ABI to fetch for the contract every trade goes through.

Their sources are nonetheless published: `PonsV2BondingCurve.sol` and `PonsV2LauncherToken.sol` are two of the **87 files** inside the V2 factory's verified compilation, and Sourcify serves that compilation's full standard-JSON input. Compiling it locally with the pinned compiler (0.8.35+commit.47b9dedd, viaIR, cancun) and requesting only the target contract takes about **two seconds**, and the result matches a live instance's runtime bytecode **exactly, outside its 14 immutables**.

That is a stronger provenance claim than a verifier record, and `scripts/fetch-abis.mjs` performs the whole chain on every run: fetch the input, compile, find the newest launch's instance through a `TokenLaunched` log, and compare. A curve rebuilt from newer source stops matching and the generator fails rather than emitting an ABI that no longer describes what is deployed.

> The launch token's ABI matters more than it looks. A `sell` that was never approved reverts with **`ERC20InsufficientAllowance`**, which is declared by the token, not by the curve. Without the token's ABI that is an unrecognised selector.

### Live-read values (2026-08-25)

None of these may be hardcoded, because all are owner-mutable.

| Field | V1 | V2 |
|---|---|---|
| `launchFee()` | 0.0005 ETH | 0.0005 ETH |
| `launchConfigCount()` | 1 | 1 |
| `maxCreatorTaxBps()` | n/a | 1000 (10%) |
| `snipeTaxStartBps()` | n/a | 9900 (99%) |
| `snipeTaxSeconds()` | n/a | **3** |

> **`snipeTaxSeconds` is 15 in the source and 3 on chain.** The contract's `uint256 public snipeTaxSeconds = 15` is an *initial* value; the owner has since lowered it to 3. This is live proof of the rule: read values from the chain, never from the source.

**V2 `getLaunchConfig(0)`:**

| Field | Value |
|---|---|
| `supply` | 1,000,000,000 tokens (1e27 wei) |
| `curveFeeBps` | 100 (1%) |
| `phantomQuote` | 1.68 ETH |
| `graduationThreshold` | 4.2 ETH |
| `poolFee` | **0**, a V4 dynamic fee governed by the meme hook |
| `tickSpacing` | 200 |

**V1 `getLaunchConfig(0)`:**

| Field | Value |
|---|---|
| `pairToken` | WETH `0x0bd7…ad73` |
| `graduationThreshold` | 4.2 ETH |
| `initialTick` | -204,200 |
| `supply` | 1,000,000,000 tokens |
| `maxWalletBps` / `maxTxBps` | 500 / 550 |
| `restrictionBlocks` | 2 |
| `routerRequiresDeadline` | false |

**V1 `getDexConfig(0)`**, "uniswap v3":

| Field | Value |
|---|---|
| `factory` | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| `positionManager` | `0x73991a25c818bf1f1128deaab1492d45638de0d3` |
| `swapRouter` | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| `poolFee` | 10000 (1%) |
| `tickSpacing` | 200 |

### Pair token (quote asset)

The launch's quote asset is chosen by the creator and is **restricted to an approved list**:

```solidity
if (pairToken != address(0) && !approvedPairTokens[pairToken]) revert PairTokenNotApproved();
```

`address(0)` means native ETH. Everything else must pass the `approvedPairTokens` mapping.

**The list is read live, never hardcoded.** Method: scan the full history of `PairTokenApprovalUpdated(address indexed pairToken, bool approved)` (topic0 `0x060d1992…0703b6`), fold to final state, then confirm each with `approvedPairTokens(addr)`.

> **Scan the whole history, not a recent window.** At 0.1 s per block a 12M-block window is only ~14 days and returned **6 of 23** approved tokens. The first approval log sits at block 26,841,846; the scan must start there or at 0.

**Approved pair tokens (2026-08-25): 23 of 24, tokenized equities plus one stablecoin.** Order is the approval-event order, which is also the order the Pons client renders.

| # | Symbol | Dec | Address | phantomQuote / graduationThreshold | Name |
|---|---|---|---|---|---|
| n/a | ETH | 18 | `0x0000…0000` | 1.68 / 4.2 | Native ETH |
| 1 | NVDA | 18 | `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec` | 16.64 / 41.6 | NVIDIA |
| 2 | SPCX | 18 | `0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea` | 28.88 / 72.2 | SpaceX Class A |
| 3 | GOOGL | 18 | `0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3` | 9.68 / 24.2 | Alphabet Class A |
| 4 | TSLA | 18 | `0x322f0929c4625ed5bad873c95208d54e1c003b2d` | 10.4 / 26 | Tesla |
| 5 | GME | 18 | `0x1b0e319c6a659f002271b69db8a7df2f911c153e` | 147.6 / 369 | GameStop |
| 6 | AAPL | 18 | `0xaf3d76f1834a1d425780943c99ea8a608f8a93f9` | 9.68 / 24.2 | Apple |
| 7 | SPY | 18 | `0x117cc2133c37b721f49de2a7a74833232b3b4c0c` | 4.36 / 10.9 | SPDR S&P 500 ETF |
| 8 | USDG | **6** | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` | 3236 / 8090 | Global Dollar |
| 9 | SNDK | 18 | `0xb90a19ff0af67f7779aff50a882a9cff42446400` | 2.652 / 6.63 | SanDisk |
| 10 | AMD | 18 | `0x86923f96303d656e4aa86d9d42d1e57ad2023fdc` | 6.666 / 16.67 | Advanced Micro Devices |
| 11 | AMZN | 18 | `0x12f190a9f9d7d37a250758b26824b97ce941bf54` | 11.73 / 29.33 | Amazon |
| 12 | MSFT | 18 | `0xe93237c50d904957cf27e7b1133b510c669c2e74` | 6.431 / 16.08 | Microsoft |
| 13 | META | 18 | `0xc0d6457c16cc70d6790dd43521c899c87ce02f35` | 5.427 / 13.57 | Meta Platforms |
| 14 | CRCL | 18 | `0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5` | 47.96 / 119.9 | Circle Internet Group |
| 15 | COIN | 18 | `0x6330d8c3178a418788df01a47479c0ce7ccf450b` | 20.99 / 52.47 | Coinbase |
| 16 | MU | 18 | `0xff080c8ce2e5feadaca0da81314ae59d232d4afd` | 3.671 / 9.178 | Micron Technology |
| 17 | PLTR | 18 | `0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a` | 18.83 / 47.07 | Palantir Technologies |
| 18 | TTWO | 18 | `0x5e81213613b6b86eab4c6c50d718d34359459786` | 10.66 / 26.64 | Take-Two Interactive |
| n/a | ~~RIVN~~ | 18 | `0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114b` | 209.3 / 523.3 | Rivian, **approval revoked** |
| 19 | COST | 18 | `0x4ea005168d7f09a7a0ba9d1def21a479950e44c2` | 3.388 / 8.47 | Costco |
| 20 | DJT | 18 | `0x1d11f0496982706c5e14a514d4e79f2e6bde4516` | 366.9 / 917.2 | Trump Media & Technology Group |
| 21 | MSTR | 18 | `0xec262a75e413fafd0df80480274532c79d42da09` | 31.99 / 79.98 | Strategy Inc. |
| 22 | QQQ | 18 | `0xd5f3879160bc7c32ebb4dc785f8a4f505888de68` | 4.459 / 11.15 | Invesco QQQ |
| 23 | RDDT | 18 | `0x05b37fb53a299a1b874a619e1c4c404d52c36f4c` | 16.94 / 42.35 | Reddit |

Cross-checked against the `ponsfamily.com/launchpad/create` dropdown: **content and ordering match exactly**, and RIVN is correctly absent. The client renders the list in approval-event order, so `pons pairs` should preserve that order rather than sorting alphabetically, so the two views agree row for row.

**`pairTokenEconomics(address(0))` returns zeros**, because the native asset is not in that mapping. ETH's phantom quote and threshold come from the launch config, and for an existing launch from the curve's own snapshot. Reading the mapping for a native launch and believing the answer would report a graduation threshold of zero.

Each pair token's economics are denominated in its own unit (`pairTokenEconomics(addr)` → `phantomQuote`, `graduationThreshold`, `decimals`). The ratio is constant across every asset: `threshold / (threshold + phantomQuote) = 0.7143`, the same for ETH as for DJT. A launch with a custom quote asset therefore trades on an **identically shaped curve** to a native launch of the same size.

> **Decimals validation is mandatory.** The contract checks the pair token's decimals against the expected value via `_requireDecimals`. USDG is the live reason: it is **6-decimal**, and applying a wei-denominated phantom reserve to it would misprice the curve by twelve orders of magnitude. The CLI must read and display this before launch.

### The graduated pool is native-keyed

The factory builds its `PoolKey` from the launch record and nothing else:

```solidity
(Currency currency0, Currency currency1,) = _sortCurrencies(token, launch.pairToken);
PoolKey memory key = PoolKey({
    currency0: currency0, currency1: currency1,
    fee: launch.poolFee, tickSpacing: launch.tickSpacing,
    hooks: IHooks(address(memeHook))
});
```

For a native launch `pairToken` is `address(0)`, which always sorts first, so **`currency0` is the zero address and the pool holds real ETH**, not WETH. Read live from a graduated token on 2026-08-25:

| Field | Value |
|---|---|
| `currency0` | `0x0000…0000` (native) |
| `currency1` | the launch token |
| `fee` | **0**, a static zero LP fee, *not* `LPFeeLibrary.DYNAMIC_FEE_FLAG` (`0x800000`) |
| `tickSpacing` | 200 |
| `hooks` | `memeHook` |

> This **contradicts a July 2026 survey** of RH V4 liquidity, which found 95 pools keyed on WETH, 30 on USDC and **zero** on native. That audit predates Pons V2 graduations; every Pons native launch adds a native-keyed pool. A router encoder that assumes WETH would emit a `WRAP_ETH` the pool does not want, leave WETH in the router, and revert on settle.

The consequence for execution is that a Pons V4 swap is the *short* form: no wrap before it, no unwrap after it. `SETTLE` pays the native currency straight out of the value the transaction carried.

### Two generations, two economies

Collapsing these into one code path is the easiest mistake to make.

| | V1 | V2 |
|---|---|---|
| Launch | CREATE2 → direct Uniswap **V3** pool | Bonding curve → Uniswap **V4** at graduation |
| Trading | V3 `swapRouter.exactInputSingle` | `curve.buy()` / `curve.sell()` |
| Opening protection | `maxWalletBps` / `maxTxBps` / `restrictionBlocks` | Snipe tax (99% → 0 over 3 s) |
| Graduation | `graduationStatus()`, computed from the V3 position | Two-phase: `graduate()` → `createGraduatedPool()` |
| Creator fee | `TokenParams.feeWallet` | `creatorFeeRecipient` + `creatorTaxBps` + fee escrow |
| Vanity address | **Yes**, via `salt`; addresses end in `bbbb` | **Yes**, via `TokenParams.salt`, see below |

### Both generations can name a launch's address before it exists

An earlier reading of this document said pre-launch address preview was V1-only. That is wrong, and the correction came from the factory's own verified source: `TokenParams` carries a `bytes32 salt`, `PonsV2LaunchDeployer` deploys both contracts with CREATE2, and `predictLaunchAddresses` returns the pair without deploying anything.

```solidity
function _launchSalt(LaunchDeployment calldata params) private pure returns (bytes32) {
    return keccak256(abi.encode(params.originalDeployer, params.salt));
}
```

Three consequences:

- **The salt is namespaced per launcher.** It only has to be unique among one account's own launches, so an unused value is all a caller needs and nobody can squat another creator's address.
- **The creation code carries every constructor argument,** so a predicted address can only ever hold the exact launch it was computed from. Under plain `CREATE` the Nth launch simply took the Nth address and a prediction committed to nothing.
- **Reusing a salt on identical terms reverts inside `Create2`.** The CLI checks for code at the predicted curve instead, which turns that revert into a message before anything is spent.

**Verified against mainnet state on 2026-08-25**, by `eth_call` with a balance override: `predictLaunchAddresses` and the addresses `launchToken` actually returned matched exactly, on a native launch, an atomic launch-and-buy, and a USDG-quoted launch.

**`predictVanityTokenAddress` and `hasVanitySuffix` do not exist.** An earlier reading of this document listed them as V1 capabilities; the deployed factory's ABI and its verified source both hold exactly one prediction function, `predictTokenAddress`. Neither generation ships a vanity *search*; both give the primitive and leave the mining to the caller.

The two prediction paths differ in one respect. V2 namespaces the salt as `keccak256(deployer, salt)`, so it only has to be unique among one account's own launches. V1 hashes the raw salt against the factory's address and puts the deployer inside the token's creation code instead, which is why `predictTokenAddress` takes `tokenDeployer` as an explicit argument rather than inferring it. The protection is the same; the mechanism is not.

> **Mining a vanity salt locally is out of reach today, for both generations.** Each candidate needs `keccak256(creationCode)`, and the creation code is only obtainable by compiling the factory's sources: V1 with solc 0.8.30, V2 with 0.8.35. Shipping both compiled creation codes and keeping them in step is a large, drifting cost for a cosmetic feature, and asking the chain per candidate is one round trip per attempt. So `--salt` accepts a value mined elsewhere, and no miner is shipped.

### Curve trade mechanics

Both directions were transcribed from the verified source and then checked against `buy.staticCall` on a live curve: the local quote matched the chain **to the wei**, including the clamped fill.

**A buy takes its fees off the input.**

```
fee   = spent * feeBps / 10_000
tax   = spent * creatorTaxBps / 10_000
snipe = spent * snipeTaxBps / 10_000
tokensOut = getAmountOut(spent - fee - tax - snipe, quoteReserve, tokenReserve, 0)
```

**A sell takes its fees off the output.** The swap happens first and the legs come off the proceeds. Getting the order backwards overstates a sell by roughly the fee.

Three further details that are easy to get wrong:

- **A buy that would cross the reserved allocation is clamped, not rejected.** The fill is capped at the sellable balance, priced from the token side with `getAmountIn`, grossed back up so the fee legs still come out of the input, and the difference is refunded in the same transaction (`CurveBuyRefunded`).
- **The buy's slippage check is a price bound, not a quantity bound**: `if (spent * minTokensOut > received * tokensOut) revert`. A partially filled buy is therefore held to the same *price* rather than failing on quantity, which is why `minTokensOut` is computed against the amount offered, not against the amount finally spent.
- **The snipe tax is capped** at `10_000 - feeBps - creatorTaxBps - 100`, so a taxed buyer always keeps at least 1% and the gross-up above never divides by zero.

### Verified event topic0s

Computed hashes were checked against real on-chain logs (last 400k blocks, V2 factory, 1,553 logs):

| Event | topic0 | Observed |
|---|---|---|
| `TokenLaunched(address,address,address,address,uint256,uint256)` | `0x8d4aad49…a89607` | 1,472 |
| `LaunchSwept(address,uint256,uint256)` | `0xcdb72f15…c4b6b4` | 18 |
| `PoolGraduated(address,uint256,uint256,uint256)` | `0x0a44ef75…58c259` | 18 |

In the same window: **1,472 launches against 18 graduations**, a graduation rate of ~1.2%. `pons info` should keep that base rate in mind when presenting graduation progress.

> V1's factory event signatures **differ** from V2's (`TokenDeployed` plus a differently-parameterised `TokenLaunched`). The V1 adapter needs its own topic0 set; it cannot share V2's.

### V1 was switched off, and its tokens still trade

The earlier reading of this, "V1 has been completely dormant for at least 11.6 days", was right about the factory and wrong about what follows from it. Re-measured on 2026-08-25 before entering Phase 5:

| | measurement |
|---|---|
| Newest V1 factory log | block **34,788,845**, 2026-08-12T19:42:55Z, **12.7 days** ago |
| What that log was | `LaunchEnabledUpdated(false)` |
| `launchEnabled()` today | **false** |
| `WhitelistedLauncherUpdated` events, ever | **0** |
| V1 `TokenLaunched` in blocks 30.8M–34.8M | **7,603** |
| Newest V1 launch | block 34,788,618, 227 blocks before the switch |
| Of the 40 newest pools, still holding liquidity | **40** |
| Swaps on those 40 pools in the last 5,000,000 blocks (~5.8 days) | **223** |

So the factory is not dormant, it is **retired**: the last thing that ever happened on it was the owner closing it, minutes after the final launch. Simulated against mainnet state, `launchToken` from an ordinary address reverts `NotWhitelisted`, and no address has ever been whitelisted.

The tokens are a different story. Thousands of them hold their liquidity and people are still trading them: 223 swaps across a forty-pool sample in under six days. **That inverts the phase's priorities.** The valuable half of a V1 adapter is `info`, `buy` and `sell`, so that somebody holding one of those tokens can see it and get out. The launch half is code nobody can reach.

It is built anyway, and gated rather than omitted. `launchEnabled` is one `onlyOwner` call from being true again, and a CLI that has to be rewritten the day that happens is worse than one that refuses today with a reason. The refusal is checked locally, so nobody spends gas discovering it.

### V1 trades on WETH, through a stock SwapRouter02

Three facts that decide the whole V1 trade path, each read from the deployed contracts:

**The pair token is WETH, not native ETH.** `getLaunchConfig(0).pairToken` is `0x0Bd7…AD73`. A holder wanting ETH and a buyer holding ETH each need a conversion, and the router does them asymmetrically:

- **Buying**, the router wraps. `pay()` deposits into WETH9 when the token being paid is WETH9 and the call carries the value, so a buy is one `exactInputSingle` with `msg.value` attached. The V1 factory's own atomic opening buy does exactly this.
- **Selling**, it does not. The output has to be left at the router and unwrapped in a second call, so a sell is `multicall([exactInputSingle(recipient: ADDRESS_THIS), unwrapWETH9(floor, seller)])`. Encoded the obvious way, a sell succeeds and hands the seller WETH.

**The router is SwapRouter02, and unlike the UniversalRouter it is stock.** `exactInputSingle`'s parameters carry no `deadline`; that moved out to `multicall(uint256 deadline, bytes[] data)`, which is what `routerRequiresDeadline: false` in the launch config records. Its `Constants` library gives `MSG_SENDER = address(1)` and `ADDRESS_THIS = address(2)`; the second is what makes the unwrap reachable.

**Verified against mainnet state on 2026-08-25**, by `eth_call` with balance and storage overrides:

| case | result |
|---|---|
| buy 0.01 ETH | succeeds |
| same buy, floor at 2x the quote | reverts `Too little received` |
| sell with balance and allowance | succeeds, returning the swap's output |
| same sell without the allowance | reverts `STF` |
| same sell, floor at 2x the quote | reverts `Too little received` |

### V1's launch-window caps expire after two blocks

`PonsLauncherToken` enforces `maxWalletBps` (500) and `maxTxBps` (550), but only while `block.number <= restrictionEndBlock`, and `restrictionBlocks` is **2**. Every V1 token that can be traded today is millions of blocks past its window. `pons info` reports the caps only while they still bind; printing them unconditionally reads as a live restriction on a token that has none.

### The locked position, and who gets its fees

V1 mints the whole supply into one single-sided V3 position and hands it to `PonsLaunchLocker`. The liquidity never comes back out, but the position's trading fees do, through `collectFees(token)`, which is **not permissionless**: the locker accepts only the protocol owner, the launch's deployer, its fee-redirect recipient, or a whitelisted collector.

> The protocol's cut is `tokenProtocolFeeShares[token]`, divided by **100**. It is a percent, not basis points, and reading it as bps understates the protocol's share by a hundredfold. It is 30 on the launches sampled.

### The buyback vault is not holder fee sharing

`PonsV2BuybackVault` is easy to misread. The source comment is explicit:

> *"Holds every launch's bought-back memecoin supply and releases it linearly over five years instead of burning it immediately, **splitting every release between the creator and the protocol** on the launch's recorded fee shares."*

Bought-back supply is **not distributed to holders**. It is split between the creator and the protocol over five years. Pons has **no** mechanism that pays fees directly to holders. Holders benefit only indirectly: the locked supply is out of circulation.

The second easily-missed point is the source's own warning:

> *"the split applies to the release, not to the funding. Both the curve and the hook carve the buyback slice out of the **creator's share of the fees alone**, so the creator funds the entire lock and then receives only their fee share of it back. Enabling a buyback therefore **moves value from the creator to the protocol**, by an amount that grows with `buybackBurnBps`."*

`buybackBurnBps` is currently 5000 (50%). `pons launch --buyback` must not enable this silently; it has to show the creator what it costs.

The vault's read surface is exposed in the CLI: `totalLocked`, `totalReleased`, `vestedAmount`, `releasable`, `vestingStart`, `vestingTerms`. `release(token)` is permissionless.

---

## Layer architecture

Three layers, one direction: `commands/` → `core/` → `chain/`. A lower layer never imports a higher one.

```
ponscli/
├─ src/
│  ├─ chain/
│  │  ├─ definition.ts      # viem chain 4663, Multicall3, explorer
│  │  ├─ transport.ts       # two-tier waterfall (see RPC layer)
│  │  ├─ health.ts          # health state, cooldown, round-robin cursor
│  │  ├─ classify.ts        # three-axis error classification
│  │  └─ headSkew.ts        # memo for endpoints that are behind
│  ├─ abi/                  # fetched from Sourcify once, then committed
│  │  ├─ v2Factory.ts  v2Curve.ts  v2Token.ts  feeEscrow.ts  buybackVault.ts
│  │  ├─ launchAndBuy.ts  launchDeployer.ts  memeHook.ts  poolManager.ts
│  │  ├─ v1Factory.ts  v1Token.ts  v1Locker.ts  v3SwapRouter.ts
│  │  ├─ v3Pool.ts  v3Quoter.ts  universalRouter.ts  permit2.ts
│  │  └─ erc20Errors.ts     # hand-written: third-party quote assets' errors
│  ├─ core/                 # framework-free business logic
│  │  ├─ adapters/
│  │  │  ├─ index.ts        # adapter selection: token address -> v1 | v2
│  │  │  ├─ v2.ts           # curve state, reserves, fee snapshot
│  │  │  ├─ v2trade.ts      # buy/sell/graduate/claim/vault plans
│  │  │  ├─ v2launch.ts     # economics guard, validation, CREATE2 prediction
│  │  │  ├─ detect.ts       # token address -> which factory
│  │  │  ├─ v1.ts           # V1 record, V3 pool, locker fee routing
│  │  │  ├─ v1trade.ts      # V3 buy/sell plans, collectFees
│  │  │  └─ v1launch.ts     # predictTokenAddress, the gated launch path
│  │  │  └─ v1.ts           # V3 router swap, launch+salt, graduationStatus
│  │  ├─ plan.ts            # every write produces a Plan first
│  │  ├─ simulate.ts        # simulateContract + error decoding
│  │  ├─ revert.ts          # selector -> error name, from the committed ABIs
│  │  ├─ events.ts          # topic0 -> event name, unmatched logs kept
│  │  ├─ units.ts           # decimals for the amounts inside a log
│  │  ├─ quote.ts           # curve math, slippage, snipe-tax calculation
│  │  ├─ amount.ts          # 0.05, 50%, all
│  │  ├─ routes/v3.ts       # SwapRouter02 encoder, QuoterV2, sqrtPrice math
│  │  ├─ routes/v4.ts       # UniversalRouter V4 encoder + Permit2
│  │  ├─ routes/v4trade.ts  # V4 plans, quoted through V4Quoter
│  │  ├─ pairs.ts           # approved pair token enumeration + symbol resolution
│  │  ├─ index/scanner.ts   # adaptive eth_getLogs chunking
│  │  ├─ index/store.ts     # cursor + fold cache, atomic JSON
│  │  └─ config.ts          # flag > env > file resolution ladder
│  ├─ wallet/
│  │  ├─ keystore.ts        # scrypt + AES-256-GCM (not EIP-2335, see Phase 3)
│  │  ├─ prompt.ts          # hidden password entry; never a flag
│  │  └─ signer.ts          # unlock, sign, broadcast once, poll one endpoint
│  ├─ output/
│  │  ├─ json.ts            # --json and non-TTY output
│  │  ├─ format.ts          # amounts, bps, ratios, durations
│  │  ├─ table.ts           # column-width aware, including wide glyphs
│  │  └─ color.ts           # painter, NO_COLOR, terminal column widths
│  ├─ commands/             # thin CLI wiring, no business logic
│  │  └─ execute.ts         # the one path plan/unsigned/dry-run/confirm share
│  ├─ mcp/
│  │  ├─ server.ts          # the McpServer, over the same core/
│  │  ├─ tools.ts           # six tools, none of which can sign
│  │  └─ context.ts         # one config resolve and one RPC pool per process
│  ├─ cli.ts                # bin: pons
│  └─ mcp.ts                # bin: pons-mcp
├─ docs/architecture/ponscli.md   # this document
├─ scripts/mainnet-e2e.sh   # spends real money, gated behind PONS_E2E
├─ CLAUDE.md                # AGENTS.md is a symlink to it
└─ .claude/                 # block-secrets, warn-broadcast, the verify skill
```

### The Plan object

Every write operation (`buy`, `sell`, `launch`, `graduate`, `claim`, `transfer`, `sweep`) **produces a `Plan` first**, then proceeds through it:

```ts
type Plan = {
  id: string            // content hash; the id changes when the plan changes
  adapter: 'v1' | 'v2'
  to: Address
  data: Hex
  value: bigint
  gasLimit: bigint
  warnings: Warning[]   // snipe tax, thin liquidity, proximity to graduation
  economics: {...}      // expected outcome from simulation
}
```

This lets all three modes share one code path: read-only prints the plan, `--unsigned` emits its calldata, `--keystore` signs it. Simulation is not a mode: every path but `--unsigned` runs it, so `--dry-run` does the same work as the default and only names the intent.

**The plan is rebuilt from live state immediately before sending.** Reserves may have moved between the user reading the plan and approving it; sending the stale plan is silently accepting a worse price.

---

## RPC layer

Every rule in this layer comes from a measurement against this chain's own endpoints rather than from a general-purpose retry policy. What follows records **the measurement behind each decision**, so a rule that stops making sense can be re-measured rather than argued about.

### Tiers

**Tier 1: free endpoints, round-robin, default**

| Endpoint | Role |
|---|---|
| `PONS_RPC_URL` | The user's own node. Always first when present. |
| `rpc.mainnet.chain.robinhood.com` | Official. Most capable in measurement; `eth_getLogs` is routed here. |
| `rpc.nodeflare.app/robinhood/public` | Metered at **1 request / 10 s per IP**, but otherwise fully capable, including archive state. |

Round-robin with a cursor over healthy endpoints. Unhealthy ones are skipped and return on their own once the cooldown expires.

**Tier 2: Alchemy, paid, last resort**

`https://robinhood-mainnet.g.alchemy.com/v2/<key>`. Only after **every** Tier 1 endpoint has been tried. Without a key this is `NO_PAID_FALLBACK`, not an error but a valid configuration: bulk work degrades rather than turning an outage into an invoice. A visible warning goes to stderr when it engages.

Tier 2 is *not* the only tier that can serve historical state; see the corrected measurements below.

### Measured endpoint behaviour (2026-08-25)

| Endpoint | `eth_chainId` | `eth_call` / `blockNumber` | `eth_getLogs` | Archive state | Rate |
|---|---|---|---|---|---|
| official RH | 348 ms | works | 1M blocks ~1 s | **no**, pruned past ~6-10k blocks | token bucket |
| nodeflare | 974 ms | works | **1M blocks, 3,599 logs** | **yes**, answered at head-50,000 | **1 req / 10 s per IP** |
| drpc | 266 ms | **fails** `-32601` | fails | n/a | n/a |
| arrowrpc | **fails** CF 1033 | n/a | n/a | n/a | n/a |
| blockscout eth-rpc | **fails** 429 | n/a | n/a | n/a | n/a |

**Three corrections from Phase 1 implementation, all re-measured 2026-08-25:**

**A missing User-Agent is a 403.** The public endpoints sit behind a WAF that rejects any request without one. `curl` sends a User-Agent and succeeds; Node's `fetch` sends none and is refused outright, which is why an earlier probe reported nodeflare as entirely dead. Every request the CLI makes now carries `ponscli/<version>`. Without this header the free tier looks like an outage.

**nodeflare's constraint is pacing, not capability.** The earlier reading of `rate_limited` on a 10,000-block `eth_getLogs` was the per-IP rate limit, not a range cap. With a User-Agent set and requests spaced ten seconds apart, the same endpoint serves a **1,000,000-block** query returning 3,599 logs. It is modelled as `minIntervalMs: 10_000` rather than as a weak endpoint.

**nodeflare is an archive node; the official endpoint is not.** `eth_getBalance` 50,000 blocks back succeeds there and answers `metadata is not found` on the official endpoint. Historical state therefore routes to Tier 1 first, slowly, before the paid tier is considered at all.

**The health-check trap:** drpc answers `eth_chainId` fastest of all, but without an API key returns `-32601` for `eth_call` and `eth_blockNumber`. A waterfall that measures health with `eth_chainId` will consider this endpoint **healthy**. Probes must use real calls, which is exactly why `pons doctor` exists.

**The official endpoint is not unlimited.** 60 concurrent requests drew no 429, but sustained load at **16 rps** does draw them; refill measured at **p50 0.10 s, worst 20.8 s**, with no `Retry-After`. It is a token bucket, and our burst test only shows the bucket covers a short burst.

### The node honours state overrides

`eth_call` with a `stateOverride` giving an address a balance is accepted by the official endpoint. That is what makes a dry run useful: a buy can be simulated for an account that holds nothing, so the answer describes the contract rather than the wallet. The CLI says when it has done this, with "the sender was given a balance for the simulation", because *it would succeed* means something different once the funds were handed over for the duration of the call.

### The rules, and what measured each

| Rule | Measured rationale |
|---|---|
| **Three-axis error classification** | Durable (rejected credential) · exhausted quota · momentary 429, each needing different handling. Durable → 1 hour park, quota → 1 hour, bare 429 → 30 s. |
| **Short park for 429** | Free endpoints are token buckets. Parking one for an hour cost **~50%** of pool availability. |
| **Do not walk past a deterministic reply** | 12 providers, 11,280 observations, **zero** cases of one node reverting where another succeeded. A reverting `eth_call` walked ~26 providers and spent **~13 seconds sleeping** before returning the same answer. `execution reverted` → return immediately, do not escalate to Tier 2. |
| **A JSON-RPC error is not a health signal** | HTTP 200 with an error body means the server answered. Treating it as unhealthy cascades a whole tier out on benign tip skew. Only transport/HTTP errors call `markFailed`. |
| **No retry on a replied error** | Waiting 500 ms and re-sending the same request returns the same body, which is pure latency. Retry only on transport errors. |
| **Head-skew memo** | 1,073 x `-32602 "beyond current head block"` in three hours. The provider is not faulty, it is **behind**. Each (requested, head) pair repeated 8 times → a 2 s note removes 7 of every 8. |
| **Never clamp `toBlock`** | Lowering the range to the provider's head and returning success advances the caller's cursor past blocks nothing ever scanned, which is silent data loss. Skip that endpoint; never rewrite the request. |
| **Reset the shared response object** | One provider's error field poisons the next provider's success; the good answer was being discarded and escalated to the paid tier. |
| **Route `getLogs` separately** | Free Alchemy is ~3x faster for light reads but caps `getLogs` at **10 blocks**, so a wide query returns a guaranteed 400 and wastes a round-trip. |
| **Activation counters** | "A zero with traffic flowing proves the branch is inert." Every optimisation carries its own proof; surfaced via `pons doctor --stats`. |
| **Redact URLs in logs** | The HTTP client embeds the request URL in transport errors, and structured-field redaction does not reach there. The Alchemy key lives in the URL, so the risk is the same. |

### Two things the waterfall breaks

**Writes pin to a single endpoint.** Taking a nonce from A and sending the transaction to B produces `nonce too low`. The waterfall applies to reads only.

**An indexing session sticks to one endpoint.** In measurement the official endpoint returned 45,517,504 while nodeflare returned 45,517,528, a **24-block, ~2.4 s** gap. A round-robining scanner would move its cursor backwards, duplicating or skipping logs.

### Three things that cut cost

These earn far more than adding endpoints, and all three are verified on this chain:

- **Multicall3 is deployed** → `batch: { multicall: true }`. Reading 50 tokens' state becomes **1** call instead of 200.
- **Batch JSON-RPC is supported** → different methods ride one HTTP request.
- **Disk cache** → `getLaunchConfig`, a token's `TokenLaunched` record, `decimals`/`symbol` never change. Write to `~/.cache/ponscli/` and never ask again.

---

## Command surface

```
Info (no key required):
  pons info <token>                     Price, reserves, graduation phase, live snipe tax
  pons tx <hash>                        Receipt + custom error decoding
  pons doctor [--stats]                 RPC endpoint capability table, waterfall state
  pons config list [--configs]          Configuration + factory launch configs
  pons config set|get <key> [<value>]
  pons pairs [--config <id>] [--refresh] Approved pair tokens (ETH + tokenized equities)
  pons vault <token>                    Buyback vault: locked / released / vested
  pons watch <token> [--since <blocks>] [--interval <s>] [--once]
                                        Curve event stream (CurveBuy/CurveSell/BuybackLocked)

Trading (RPC + signing):
  pons buy  <token> <amount> [--slippage N] [--route curve|v4|v3] [--dry-run] [--confirm]
  pons sell <token> <amount|all|N%>     same flags
  pons graduate <token> [--phase sweep|pool|both] [--confirm]
  pons claim [--token <addr>] [--confirm]      V2: fees held in the escrow
  pons collect <token> [--confirm]             V1: the locked position's fees
  pons vault release <token> [--confirm]   Release vested buyback supply (permissionless)

Launch:
  pons launch --name X --symbol Y --desc Z --config <id>
              --pair <ETH|NVDA|TSLA|USDG|...|0x...>
              [--logo <url>]
              [--twitter @x] [--telegram t] [--discord d] [--website w] [--farcaster f]
              [--creator-tax <bps>]     0-1000, bounded by live maxCreatorTaxBps
              [--buyback]               enables the buyback vault; cost to creator is shown
              [--dev-buy <amount>]      atomic opening buy, via PonsV2LaunchAndBuy
              [--slippage <bps>]        floor on the opening buy
              [--exempt <addr,addr>]    snipe-tax exemption, cannot be added later
              [--recipient <address>]   who receives the opening buy
              [--fee-recipient <addr>]  who earns the creator fees
              [--salt <hex|text>]       CREATE2 salt; the address is predicted before sending
              [--from <address>]        launch without a keystore
              [--generation <v1|v2>]    which factory. V2 by default; V1 is closed
              [--dex <id>]              V1 only: which dex config
              [--dry-run] [--unsigned] [--confirm]

Wallet:
  pons wallet create|import|show|export
  pons wallet balance [--token <addr>...]
  pons wallet track|untrack <token>
  pons wallet transfer <to> <amount> [--token <addr>] [--confirm]
  pons wallet sweep <recipient> [--confirm]

Global:
  --json                  Machine-readable output (automatic when not a TTY)
  --unsigned              Does not sign; emits calldata + value
  --keystore <path>       Enables signing
  --rpc <url>             Prepended to the waterfall
  --rpc-tier <1|2>        Pins the tier
  --priority-fee <gwei>   EIP-1559 maxPriorityFeePerGas
  --gas-limit <n>
  --version
```

### Launch feature matrix

| Feature | Contract surface | CLI |
|---|---|---|
| Social profiles | `TokenParams.socials`: twitter, telegram, discord, website, farcaster | One flag each. Stored on chain as strings; URL validation happens in the CLI. |
| Pair token selection | `pairToken` + `approvedPairTokens` | `--pair` accepts a symbol or an address. `pons pairs` prints the live list; symbol→address resolution comes from it. |
| Tokenized equity quote | `pairTokenEconomics(addr)` | The chosen asset's `phantomQuote` / `graduationThreshold` / `decimals` are shown before launch. USDG is 6-decimal, so the check is not theoretical. |
| Dev buy | **`PonsV2LaunchAndBuy.launchAndBuy`**, never the factory | `--dev-buy`. See [below](#the-factory-cannot-fold-in-a-dev-buy); the factory refuses any value but the fee exactly. |
| Creator tax | `TokenParams.creatorTaxBps` | `--creator-tax`, validated up front against live `maxCreatorTaxBps()`. Paid entirely to the creator, never split with the protocol. |
| Snipe-tax exemption | `launchToken(..., address[] snipeTaxExemptions)` | `--exempt`. `MAX_SNIPE_TAX_EXEMPTIONS` checked up front. **Cannot be added after launch**, and the CLI warns about this. |
| Buyback | `TokenParams.buybackEnabled` → `PonsV2BuybackVault` | `--buyback`. **Not** a holder distribution; funded from the creator's fee share and split between creator and protocol over five years. Cost is shown explicitly. |

The creator and deployer addresses are exempted from the snipe tax **automatically** (inside `_launchToken`). `--exempt` is only for further addresses of your own choosing, and adding yourself wastes quota.

### The factory cannot fold in a dev buy

An earlier reading of this document said the opening buy was `msg.value` above `launchFee`. The factory says otherwise:

```solidity
if (msg.value != launchFee) revert LaunchFeeNotPaid();
```

**Equality, not a floor.** Overpaying reverts. Confirmed against mainnet state: the same call that succeeds at exactly 0.0005 ETH reverts at 0.1005 ETH.

The opening buy therefore goes through **`PonsV2LaunchAndBuy` at `0xe33E…2948`**, which is the factory's configured `launchForwarder` and the only address `launchTokenFor` accepts. It is Sourcify-verified, and its own header records why it exists: *"a launch on this factory had its curve bought out by twenty-two addresses in the two blocks after it opened, leaving the creator with nothing."*

What routing through it changes:

| | direct `launchToken` | `launchAndBuy` |
|---|---|---|
| `msg.value`, native quote | `launchFee` exactly | `launchFee + quoteIn` exactly |
| `msg.value`, ERC-20 quote | `launchFee` | `launchFee`; the buy is pulled by `transferFrom`, so the router needs an approval first |
| `creatorFeeRecipient` | zero means "the deployer" | zero **reverts**; the router insists the creator names one |
| Exemption list | up to 32 | up to **31**: the router appends the buy's recipient itself |
| Failure | the launch stands, the buy is a second transaction | either both legs land or neither does |

The router's `onlyPermittedLauncher` applies the factory's own `canLaunch` to *its* caller, so being the trusted forwarder extends launch rights to nobody.

**Verified on mainnet state:** an atomic launch plus a 0.25 ETH opening buy returns `tokensOut = 125,569,290,826,284,970,722,186,076`, matching `quoteBuy` against the opening curve state to the wei.

### What the launch validator checks before building anything

Each of these is a specific `revert` in `_launchToken`, `_exemptFromSnipeTax` or `_requireMetadataWithinLimits`, and each is cheaper to answer locally than to be told over a round trip.

| Check | Source of truth |
|---|---|
| Metadata length | `MAX_NAME_LENGTH` 64, `MAX_SYMBOL_LENGTH` 16, `MAX_LOGO_LENGTH` 512, `MAX_DESCRIPTION_LENGTH` 2048, `MAX_SOCIAL_LENGTH` 256, all in **bytes** |
| Creator tax | live `maxCreatorTaxBps()`, currently 1000 |
| Combined fee | `curveFeeBps + creatorTaxBps <= 2000`, and `hookFeeBps + creatorTaxBps <= 2000` |
| Exemptions | `MAX_SNIPE_TAX_EXEMPTIONS` 32, minus one when there is a dev buy |
| Config | `enabled`, and `canLaunch(account)` rather than `launchEnabled` alone |
| Quote asset | on the approved list, and its live `decimals()` equal to the factory's recorded scale |
| Economics | `previewLaunchEconomics(configId, pairToken)`, read for **the resolved asset** |

> **Bytes, not characters.** A name of seventeen cat emoji is seventeen characters and sixty-eight bytes; measured the wrong way it looks well inside a 64-character limit and reverts `MetadataTooLong`. Token names on this chain are routinely non-ASCII.

> **The guard is per quote asset.** `previewLaunchEconomics(0, address(0))` and `previewLaunchEconomics(0, USDG)` return different digests, because the phantom reserve and threshold in the preimage come from the asset. Pinning a USDG launch to ETH's digest reverts `LaunchEconomicsMismatch`.

### Behavioural rules

**`buy` always computes the snipe tax.** In V2 `snipeTaxStartBps` decays from 99% to zero over `snipeTaxSeconds` (currently 3). The CLI reads the launch timestamp, shows the effective tax at that moment, and refuses to proceed above a threshold without `--confirm`.

**`sell` checks the graduation threshold up front.** The curve's `sell()` reverts once `readyToGraduate()` is true. Rather than surfacing the raw error, the CLI redirects: *"this token is ready to graduate. Run `pons graduate <token>` first, then sell on the V4 pool."*

**`launch` does not run without `economicsGuard`.** `previewLaunchEconomics(configId, pairToken)` → the returned `bytes32` → `TokenParams`. Never computed by hand. Leaving it empty means that if the owner changes the config mid-flight, the launch executes on terms the user never saw.

**The factory's `swept*` fields are cleared once the pool exists.** `graduate()` records `sweptQuote`, `sweptTokens` and `sweptAt` on the launch, and `createGraduatedPool()` zeroes all three after spending them. They are readable only in the `Swept` phase; in `PoolCreated` the seeded amounts live in the `PoolGraduated` event and nowhere else. A command that reports them from the record after graduation prints zeros.

**`graduate` is two-phase and permissionless.** `graduate()` drains the curve (`Swept`), `createGraduatedPool()` creates the V4 pool (`PoolCreated`). Default is `both`; the phase is visible in `info`.

---

## Swap path and self-routing

The usual shape for an EVM trading client is **Uniswap self-routing (best-of-N) with an aggregator fallback**. That shape was evaluated for `ponscli`. Conclusion: **the selector half is unnecessary here, the encoder half is required.**

### Why there is no venue to select

Self-routing exists to pick the best venue among many (V2/V3/V4 fee tiers, Aerodrome…). In Pons there is **nothing to pick**, because the contract tells you exactly which pool to use:

| Case | Venue | Source |
|---|---|---|
| V2, pre-graduation (**~98.8%**) | Bonding curve | `getLaunchedToken(token).curve` |
| V2, post-graduation (**~1.2%**) | A single V4 pool | PoolKey = `sort(token, pairToken)` + `poolFee` + `tickSpacing` + `memeHook` |
| V1 (**closed to new launches**) | A single V3 pool | `getLaunchedToken(token)` + `getDexConfig(dexId).swapRouter` |

V2's PoolKey is fully determined: `_poolIdFor` builds all four components from the `LaunchedToken` record and the `immutable memeHook`. No discovery, no best-of-N, no quoter race.

### Why a generic selector would actively hurt

A self-routing selector **skips hooked V4 pools** by design, because a hook can impose bespoke tax and slippage, and a generic router has no way to price either.

**Every graduated Pons V2 pool is hooked.** `PonsV2MemeHook` is immutable and shared; the fee policy, creator tax, fee escrow and buyback vault all live inside the hook. A generic selector would filter out precisely the pools we need.

### What is required anyway

**1. The calldata encoder.** `--route v4` has to produce a real V4 swap: UniversalRouter `execute()` plus Permit2 on sells. The V1 side is simpler in the swap and trickier in the wrapping: `exactInputSingle` on the configured `swapRouter`, with `routerRequiresDeadline` distinguishing SwapRouter02 from SwapRouter, and a second `unwrapWETH9` call on every sell.

**2. Firm min-out.** `minOut` is computed from a real on-chain quote (`eth_call` to `V4Quoter`), **not** from a cached price estimate: `minOut = AmountOut x (1 - slippage)`. A price heuristic is only ever worth reaching for when no firm quote is available; here one always is.

**3. The dust-floor sell veto.** A dust route arising from a collapsed pool is rejected before broadcast.

**4. Hook fee transparency.** The generic form of this check caps the static LP fee. Pons pools have `poolFee = 0` with the fee arriving dynamically from the hook, so that check does not apply directly. Instead: read the token's **own** `FeePolicySnapshot` plus `creatorTaxBps` before the trade and show the true all-in cost.

### The RH UniversalRouter is a fork, and only its V3 command differs

Proved here by `eth_call`:

- **`V3_SWAP_EXACT_IN` on this router takes a sixth field**, a trailing `address[]` (a Robinhood hook / fee-recipient list). Omitting it makes the fork read past the input and revert `SliceOutOfBounds` (`0x3b99b53d`). An empty array is accepted, and the stock router ignores the extra field, so including it is backward-compatible.
- **`V4_SWAP` is stock.** The live RH V4 path sends the standard `abi.encode(bytes actions, bytes[] params)` with no trailing extension.

`ponscli` emits V4 only, so it never touches the V3 command, but the fork is recorded here because the next person to add a V3 leg will otherwise lose an afternoon to `SliceOutOfBounds`.

**The V4 buy encoding was proved on chain on 2026-08-25**, against a live graduated pool with a balance override and no funds moved:

| Probe | Result |
|---|---|
| Encoded buy through the router | succeeds |
| Same buy with the floor raised above the quote | reverts |
| Same buy with a past deadline | reverts |

Each of the three is a different field in a different slot; all three behaving correctly is what makes the encoding trustworthy rather than merely plausible.

### Verified execution addresses

Confirmed with `eth_getCode` on 2026-08-25, all live:

| Contract | Address | Bytecode |
|---|---|---|
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` | 49,094 hex |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` | 18,306 hex |
| V4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | 48,020 hex |
| V1 swapRouter | `0xcaf681a66d020601342297493863e78c959e5cb2` | 48,996 hex |
| `PonsV2MemeHook` | `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` | 30,336 hex |

### Reads and quotes on V4

| Role | Address | Provenance |
|---|---|---|
| `V4Quoter` | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | bytecode confirmed here by `eth_getCode` |
| `StateView` | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | same |
| `QuoterV2` (V3) | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` | same |

The quote comes from `V4Quoter`, never from arithmetic of our own. The pool is hooked and the hook can move the effective fee, so a locally computed figure would be a guess presented as a bound. `V4Quoter.quoteExactInputSingle` is `nonpayable`, swapping inside a call that reverts with the answer, so it is an `eth_call` rather than a read.

### Permit2

V4 sells require Permit2 for UniversalRouter to pull the token. **An EIP-712 signature is produced on every sell** and embedded in the `PERMIT2_PERMIT` command.

**Two authorisations stand between a holder and a V4 sell**, and it is easy to plan for only one:

1. The token must approve **Permit2** with an ordinary ERC-20 `approve`, unbounded, because that is the only form Permit2 accepts. It is a real transaction and it costs gas.
2. Permit2 must authorise **the router**, for this amount and this window, through an EIP-712 signature carried in the `PERMIT2_PERMIT` command. This one costs nothing and expires.

So the signature replaces the *per-trade* allowance, not the approval underneath it. `ponscli` scopes what it can: the permit is signed for the exact amount and expires in thirty minutes, so a stolen signature is worth one trade for half an hour rather than the wallet's whole balance forever. The unbounded ERC-20 approval to Permit2 is unavoidable and the CLI warns about it rather than slipping it past.

Consequence: **V4 sells are not possible in `--unsigned` mode**, because a signature is required and only the holder can make it, so there is no calldata to hand to somebody else. `--unsigned` works for V4 buys and all curve operations. Read-only and `--dry-run` modes report the quote and say why they stop there.

### No aggregator fallback

A multi-venue router needs an aggregator fallback because it faces a routing choice. We have one pool per token and the contract names it, so if UniversalRouter fails an aggregator would route to the same pool. 0x has also been observed going 403-DEAD on both `/quote` and `/price`; the external dependency buys nothing here.

### Scale note

1,472 launches against 18 graduations in the last 400k blocks. So **~98.8% of tokens never reach a pool at all**; the V4 swap path serves the ~1.2% slice. It is required for correctness, since you must be able to sell a graduated token, but it must not drive the architecture. Hence it lands at the end of Phase 3, once the curve path works.

---

## Security model

| Rule | Implementation |
|---|---|
| Read-only by default | With no key, `info`/`tx`/`doctor`/`watch`/`config`/`pairs` work fully |
| Never a key in argv | There is **no** `--private-key`. It would land in shell history. |
| Encrypted at rest | scrypt + AES-256-GCM, EIP-2335 compatible keystore |
| Password from env | `PONS_PASSWORD`, otherwise a TTY prompt |
| Keys never leak to output | Not to stdout, stderr or logs. `wallet export` refuses without an explicit `--yes`. |
| URL redaction | The Alchemy key lives in the URL; transport errors embed the URL in the message |
| Simulation mandatory | Every write runs `simulateContract` first; the revert reason is decoded and shown |
| Confirmation threshold | A transaction above the amount/warning threshold is not sent without `--confirm` |

---

## Error decoding

The contracts define dozens of custom errors. Printing a raw `0x…` selector leaves the user stuck; each is translated to plain language and, where possible, a next step.

| Error | Meaning | Suggestion |
|---|---|---|
| `CurveGraduated` | The curve graduated or is ready to | `pons graduate`, then `--route v4` |
| `PairTokenNotApproved` | Quote asset is not on the approved list | `pons pairs` |
| `ExemptionListTooLong` | Exemption list exceeded the cap | Shorten the list |
| `NotWhitelisted` | Launch is disabled and the address is not whitelisted | Show `launchEnabled()` state |
| `LaunchFeeNotPaid` | `msg.value < launchFee` | Print the live `launchFee()` |
| `InvalidLaunchConfigId` / `LaunchConfigDisabled` | Invalid or disabled config | `pons config list --configs` |
| `VanitySaltNotFound` | V1 vanity salt search failed | Widen the search space |
| `TokenNotFound` | Address is not registered with this factory | Try the other generation |
| `ERC20InsufficientAllowance` | The curve was never approved to move the tokens | `pons sell` approves first; a hand-built calldata must too |
| `intrinsic gas too low` | Nitro poster-gas trap | Raise the gas limit (see [the Nitro gas trap](#the-nitro-gas-trap)) |

Two error codes are the CLI's own rather than a contract's, and both mean "stop
and look" rather than "try again":

| code | meaning |
|---|---|
| `BROADCAST_UNCERTAIN` | The send failed but the account's nonce moved: the node may already hold the transaction. The hash is in `details`. **Do not retry**; `pons tx <hash>` settles it. |
| `ACCOUNT_MISMATCH` | `--from` names one account and the unlocked keystore holds another. |

The selector → name mapping is built from the committed ABIs when the module loads, across all nine of them plus Solidity's own `Error(string)` and `Panic(uint256)`; there is no hand-maintained list of selectors and none can fall behind a redeployment. Only the *explanations* above are written by hand, and only where the name alone does not tell the user what to do. Everything else prints its name, which is better than a paraphrase of an error nobody has thought about.

An error several contracts declare, and `ZeroAmount` is in most of them, folds into one entry that lists every declarer, rather than letting whichever ABI loaded last win. An unknown selector is reported as unknown: the four bytes are printed and no explanation is invented.

---

## Indexing and cache

Discovery commands are out of v1 scope, but the scanner infrastructure is built in Phase 4 for `watch`, `pairs` and future `tokens` commands.

### There is no chunk size, because there are two limits and neither is a range

Measured on 2026-08-25 against `rpc.mainnet.chain.robinhood.com`:

| query | result |
|---|---|
| `PairTokenApprovalUpdated`, block 0 → head | 25 logs in 0.27 s |
| `TokenLaunched`, 3,000,000 blocks | 7,154 logs in 3.5 s |
| `TokenLaunched`, 5,000,000 blocks | `-32000 log query timed out` |
| factory address, no topic, 2,500,000 blocks | 6,984 logs in 2.2 s |
| `Transfer` chain-wide, 500 blocks | **11,690 logs** in 1.3 s |
| `Transfer` chain-wide, 1,000 blocks | `-32000 logs matched by query exceeds limit of 10000` |

Two independent refusals. One is a **query timeout**, meaning how long the node spends scanning, which is why a selective filter answers over the whole history and a loose one dies inside five million blocks. The other is the **ten-thousand-result cap**, and it is enforced by estimate rather than by count: the query that returned 11,690 logs is already past the stated limit and was served anyway, while twice the range was refused outright.

So the answerable span is a function of the filter, not a number. `core/index/scanner.ts` **adapts**: start where the caller says, halve on either refusal, grow by half again on success. The plan's flat 500,000-block chunk survives only as the default for a filter nothing is known about.

- **The head is resolved once, to a number.** Every chunk then carries absolute bounds and can go to any endpoint, which keeps the waterfall's failover instead of pinning one endpoint against head skew. Skew is only a hazard for a range that ends at `latest`.
- **Both refusal wordings must be matched.** `logs matched by query exceeds limit of 10000` contains none of the usual "too many results" phrases; unrecognised, it is re-thrown as a hard failure on exactly the queries subdividing would fix.
- **`watch` does not poll per block.** At 10 blocks/s that is ten requests a second to learn nothing happened; a cursored `eth_getLogs` at 2-3 s costs one request and misses nothing between.
- **Pair token enumeration scans from block 0** (or the factory's first log at 26,841,846), never a recent window; a 12M-block window returned 6 of 23. With the topic filter present the whole history is **one call**: 25 logs, 0.27 s.
- **Immutable data is cached permanently:** `getLaunchConfig`, the `TokenLaunched` record, `decimals`, `symbol`, and resolved pair-token metadata. Owner-settable data, meaning the economics and the approval flags, is read live every time.

### The cache is a JSON file, not SQLite

The plan said `~/.cache/ponscli/index.db`. It is `~/.cache/ponscli/<name>.json`, and the reason is that neither SQLite option is worth its price here:

- **`node:sqlite`** does not exist before Node 22.5, while the package declares `>=20.11`, and on the 22.x line it prints an experimental warning to stderr, in the middle of the CLI's own output.
- **`better-sqlite3`** is a native module that compiles at install time, for a CLI whose entire dependency list is `commander` and `viem`.

What is actually stored is a cursor and a fold: the approved pair list is 23 entries and `watch` keeps one block number. Writes go through a temporary file and a rename, so two processes leave one whole cursor rather than half of each, and every failure, whether missing, corrupt, wrong chain or unwritable directory, degrades to a rescan rather than an error. `IndexStore` is narrow enough that a real database can replace it if a command ever needs to hold a table of logs.

---

## Test strategy

| Layer | Tool | Scope |
|---|---|---|
| Unit | `vitest` | Curve math (`getAmountOut`, fee bps, slippage), snipe-tax calculation, plan construction, config ladder. No external dependencies. |
| Waterfall | `vitest` + fake transport | One test per classification branch: durable failure, quota, 429 short park, deterministic revert, head-skew skip, response reset. |
| Sequence | `eth_simulateV1` | Several blocks of several calls, state carrying across all of them, against live mainnet state. `npm run test:sequence`. **Without sending a single real transaction, and without a local node.** |
| E2E | `scripts/mainnet-e2e.sh` | Spends real ETH. Off by default, requires explicit confirmation. |

Each waterfall test corresponds to a **measurement**; the test name should name it (`test('429 short park, because an hour-long park cost 50% of pool availability')`).

---

## Agent surface

The CLI is designed for agents from the start, not retrofitted.

- **`--json`** on every command; enabled automatically when stdout is not a TTY.
- **Read-only default**: an agent cannot sign by accident.
- **`--unsigned`**: the agent produces the plan, a human signs it.
- **`pons-mcp`** as a second binary from the same package. `core/` was already framework-free, so this is a wrapper rather than a reimplementation. The one thing it needed was lifting `commands/tx.ts`'s receipt reader into `core/receipt.ts`, which had been left in the command layer.
- **`.claude/`**: our own hooks and skill: `block-secrets.sh` refuses a command line carrying a key or an inline password, `warn-broadcast.sh` says out loud when `--confirm` or `pons launch` is about to spend, and the `verify` skill runs the checks this repo gates on and explains what each failure usually means here. `CLAUDE.md` with `AGENTS.md` as a symlink.
- **The MCP server signs nothing.** See [below](#the-mcp-server-cannot-sign-and-that-is-the-design).

---

## Development plan

Each phase is independently shippable and testable.

### Phase 0: Skeleton *(complete)*

- `package.json` (`ponscli` → bin `pons`), TypeScript strict, tsup, vitest, eslint
- `chain/definition.ts`: chain 4663, Multicall3, explorer, `NATIVE_TRANSFER_GAS_LIMIT`
- `chain/addresses.ts`: every deployed address, with the V2 factory's first log block
- `config/`: flag > env > file > default ladder, `PONS_*` env, flat JSON at the XDG path, mode 0600
- `output/`: `Reporter` with strict channel discipline, bigint-safe JSON, width-aware tables
- `errors.ts`: `PonsError` taxonomy and stable exit codes
- `globals.ts`: global flags accepted anywhere on the line, mapped onto config keys
- ABIs fetched from Sourcify (Blockscout fallback) and committed, with a `--check` drift gate

**Output:** `pons --version`, `pons config list|get|set|unset|path`. 66 unit tests, no network access required.

### Phase 1: RPC waterfall *(complete)*

- `classify.ts`: three-axis failure classification plus the deterministic-reply rule
- `endpoint.ts`: per-endpoint health, park windows, and runtime capability learning
- `pool.ts`: Tier 1 round-robin, Tier 2 escalation, `NoPaidFallbackError`, `lease()` for pinned sessions
- `headSkew.ts`: the two-second note, generalised from a disclosed head
- `request.ts`: routing facts read out of `params` without ever rewriting them
- `redact.ts`: URL masking, including in-place inside thrown error objects
- `transport.ts`: viem `http` per endpoint with its retry disabled, pool exposed as a viem transport
- `probe.ts` + `pons doctor [--stats] [--wait]`: capability probing with real calls

**Output:** `pons doctor` prints the endpoint table and, with `--stats`, the activation counters. 78 unit tests cover the RPC layer; the full suite is 144.

Three things were added beyond the plan, each earned by a measurement:

- **Per-method capability learning.** `-32601` marks the method unsupported on that endpoint rather than parking the endpoint. drpc rejects `eth_call` and would still serve other methods; a blanket park is a self-inflicted outage.
- **Metered endpoints.** `minIntervalMs` deprioritises an endpoint inside its own rate window instead of spending a round trip discovering a 429. It is a soft skip: if nothing else is available the request still goes there, because a probable 429 beats a certain failure.
- **Learned pruning and range boundaries.** A `pruned` reply records the block; a rejected log range records the ceiling. Both are monotone, so the endpoint self-heals as its retention window moves forward.

### Phase 2: Read path (V2) *(complete)*

- `core/adapters/v2.ts` read side: `getLaunchedToken`, `getReserves`, `realQuoteReserve`, the launch's own fee snapshot, and the factory's launch policy
- Aggregation through Multicall3: the whole curve and token state arrives in one `aggregate3`
- `core/revert.ts`: selector → error name from the committed ABIs, plus a plain-language explanation and a next step
- `core/events.ts`: topic0 → event name, with unmatched logs kept rather than dropped
- `core/units.ts`: the decimals that turn a log's `uint256` into an amount
- `output/format.ts`: amounts, basis points, ratios and durations, all in integer arithmetic
- `pons info <token>`: price, reserves, `GraduationPhase`, live snipe tax
- `pons tx <hash>`: receipt, decoded logs, and the revert reason recovered by replay
- `pons config list --configs`

**Output:** every information command that needs no key. 62 more unit tests; the full suite is 206, and still no network access required.

Five things came out of building it, each earned by a measurement:

- **The curve and the token had no fetchable ABI.** Both are deployed per launch and verified nowhere. They are compiled from the factory's verified standard-JSON input instead and proved against a live instance's bytecode; see [the section above](#two-contracts-are-deployed-per-launch-and-verified-nowhere). Without the token's ABI, the most common failed trade reverts with an unrecognised selector.

- **A receipt carries no revert reason.** Recovering one means replaying the call, and the replay needs state the official endpoint prunes after roughly a quarter of an hour. `pons tx` reports "could not be recovered" rather than "no reason". The two are different, and only one of them is the user's problem. viem nests the payload three errors deep, so the extraction walks the cause chain rather than matching a wrapper class.

- **A graduated token cannot be priced off its curve.** Once drained the curve holds only its phantom reserve, so spot price, market cap and graduation progress are all zero. `info` reports them as `null` and says where the token trades now, because printing that zero is worse than printing nothing.

- **Terminal width is not string length.** A live launch is named 蛋猫: two code units, four columns. Emoji are the reverse. Every table in the CLI misaligned on the first non-ASCII token name until `visibleWidth` started measuring columns.

- **Log amounts need units the logs do not carry.** `quoteIn=5000000000000000` is exact and unreadable; `0.005 ETH` needs `decimals()` from a contract. `pons tx` resolves the emitters' units in one aggregate and only in human mode; the JSON payload keeps base units, which is the form a caller can compute with. An address that will not answer `decimals()` keeps its raw number: a wrongly scaled amount is worse than an unscaled one.

### Phase 3: Write path (V2) *(complete)*

- `core/plan.ts` + `core/simulate.ts`: the Plan object, rebuild-before-send
- `core/quote.ts`: curve pricing, transcribed from the verified source and checked against the chain
- `wallet/keystore.ts`: scrypt + AES-256-GCM; `wallet/signer.ts`: the one place a transaction leaves the machine
- `commands/execute.ts`: the single path all four modes share
- `pons buy` and `pons sell`: snipe-tax warning, `readyToGraduate` redirect, automatic venue selection
- `pons graduate`: two-phase, and it does the phase that is actually left
- `pons claim`: fee escrow; `pons vault` and `pons vault release`: the buyback vault
- `pons wallet`: create/import/show/export/balance/track/untrack/transfer/sweep
- **The Nitro gas constant** in transfer and sweep
- `core/routes/v4.ts`: UniversalRouter encoder + Permit2, firm min-out from `V4Quoter`

**Output:** full trading on V2, both the curve and the graduated V4 pool. 60 more unit tests; the full suite is 266.

**The gap this phase left, sequences, is closed, and not by anvil.** Every path here was exercised against **mainnet state** by `eth_call` with a balance override, which proves the calldata against the contracts actually deployed rather than against a fork of them. What that could not prove is a *sequence*: an approval landing and then a sell succeeding in the next block. See [proving sequences without a local node](#proving-sequences-without-a-local-node).

Six things came out of building it:

- **The curve's pricing was reproduced exactly, so no quote needs a wallet.** `quoteBuy` matched `buy.staticCall` to the wei at 0.001, 0.05, 1, 4.5 and 10 ETH, including the clamped fill and its gross-up. Pricing locally is what lets `--dry-run` work with no funds and lets a quote describe the second the transaction will land rather than the second it was built.

- **The slippage floor is fixed when the user accepts it, not when the transaction is sent.** The plan is rebuilt from live state immediately before broadcasting, but the floor is *not* recomputed from the new price, because that would silently accept whatever the market had become. The rebuild only decides whether the trade still clears the floor already agreed; if it does not, nothing is sent.

- **Broadcast happens exactly once.** Once a hash exists the transaction may land at any moment, so a retry, or a fallback to another endpoint, risks a second transaction spending the user's money again. A missing receipt is reported as a hash to look up, not retried.

- **The keystore is not EIP-2335, and saying so matters.** That standard describes BLS keys for the consensus layer and specifies aes-128-ctr; it does not apply to a secp256k1 signing key. The format here is scrypt + AES-256-GCM with a version field. GCM authenticates, so there is no separate MAC and a wrong password never produces plaintext.

- **A sell blocked by a pending approval is not a failed sell.** Simulating one before its approval has landed reverts on the allowance every time. Reporting that as the plan's own fault sends the user hunting for a problem that is about to fix itself, so the runner distinguishes the two.

- **The canonical form of a tuple parameter is its components, not the word `tuple`.** Joining `input.type` produces a plausible signature that hashes to a selector matching nothing on chain. It silently broke eight of Permit2's fifteen selectors and would have broken any custom error carrying a struct.

### Phase 4: Launch (V2) + indexing *(complete)*

- `core/index/scanner.ts`: adaptive `eth_getLogs` chunking; halves on either refusal, grows on success
- `core/index/store.ts`: the cursor and fold cache, atomic writes, every failure degrading to a rescan
- `core/pairs.ts`: full-history `PairTokenApprovalUpdated` scan, `approvedPairTokens` confirmation, symbol resolution
- `core/adapters/v2launch.ts`: `previewLaunchEconomics` guard, the full validator, CREATE2 address prediction, both launch paths
- `pons pairs`: the live list in approval order, matching the web client row for row
- `pons launch`: the full flag set, including `--dev-buy` through the atomic router and `--salt` for a chosen address
- `pons watch <token>`: cursored event stream, curve and factory, denominated correctly
- `src/abi/launchAndBuy.ts`, `src/abi/launchDeployer.ts` fetched from Sourcify; `src/abi/erc20Errors.ts` written by hand

**Output:** the V2 surface is complete. 318 tests.

`pons vault` and `pons vault release` were pulled forward into Phase 3, where they sat beside `claim`.

Five things were found here that the plan had wrong, each recorded in its own section above: the factory [cannot fold in a dev buy](#the-factory-cannot-fold-in-a-dev-buy); V2 [can predict its addresses](#both-generations-can-name-a-launchs-address-before-it-exists); `eth_getLogs` has [two limits and no usable chunk size](#there-is-no-chunk-size-because-there-are-two-limits-and-neither-is-a-range); [the cache is not SQLite](#the-cache-is-a-json-file-not-sqlite); and viem's `toFunctionSelector` [signs an error ABI item wrongly](#viems-tofunctionselector-must-be-given-a-string-for-an-error).

Two bugs in already-shipped code surfaced while building on it:

- **`decodeLogs` keyed its matches on `logIndex` alone.** Within one receipt that is unique and the bug is invisible; over a historical scan every block has a `logIndex` of zero and most logs took the wrong decode. Now keyed on block hash and index together.
- **`IndexStore` resolved its directory from `process.env`,** not from the environment the command resolved against. A test with its own home directory silently shared the developer's real cache, which is how it was caught, by a fixture answering with a token no fixture had defined.

### viem's `toFunctionSelector` must be given a string for an error

Handed an ABI item whose `type` is `error`, viem signs `error InsufficientAllowance()`, keyword included, and hashes that:

| input | selector |
|---|---|
| `'InsufficientAllowance()'` | `0x13be252b` (correct; what the chain returns) |
| `{ type: 'error', name: 'InsufficientAllowance', inputs: [] }` | `0x4316db37` (matches nothing) |

`src/core/revert.ts` builds the signature string itself, which is why it decodes correctly; `scripts/fetch-abis.mjs` filters to `type === 'function'` before taking selectors, where the item form is fine. Anything new that takes an error's selector has to do one or the other. This is the same class of failure as the `tuple` pitfall: a plausible-looking selector that silently matches nothing.

### One hand-written ABI: third-party ERC-20 errors

A quote asset is somebody else's token. An opening buy in USDG, simulated before its approval had landed, reverted `0x13be252b`, Solady's `InsufficientAllowance()`, since USDG is a Solady-style token behind a diamond proxy. Every ABI the CLI held described a Pons contract, so the most ordinary failure on that path printed as four unexplained bytes.

`src/abi/erc20Errors.ts` is the one file in that directory not generated: the error shapes OpenZeppelin v5, Solady and the `SafeTransferLib` family declare. Fetching all twenty-three approved assets' ABIs would be the alternative, and the list changes. These signatures are fixed by their libraries and cannot drift the way a deployment can.

### Phase 5: V1 adapter *(complete)*

- `core/adapters/detect.ts`: token address → which factory, both registries asked in one multicall
- `core/adapters/v1.ts`: the launch record, `graduationStatus`, the V3 pool, the locker's fee routing
- `core/routes/v3.ts`: SwapRouter02 encoding, QuoterV2 pricing, `sqrtPriceX96` → spot price
- `core/adapters/v1trade.ts`: buy, sell and `collectFees` plans
- `core/adapters/v1launch.ts`: `predictTokenAddress`, validation, the gated launch path
- `pons info`, `pons buy`, `pons sell`, `pons watch` all route by generation
- `pons collect <token>`: a V1 launch's accrued position fees
- `pons launch --generation v1 [--dex <id>]`
- `src/abi/v1Token.ts`, `v1Locker.ts`, `v3Pool.ts`, `v3Quoter.ts`

**Output:** V1 + V2 full support. 339 tests.

The re-measurement the plan asked for changed what this phase should be. [V1 is retired, not dormant](#v1-was-switched-off-and-its-tokens-still-trade): `launchEnabled()` is false and the last log the factory ever emitted is the owner setting it, while its tokens still trade. Trading is therefore the valuable half and launching is unreachable, so the launch path is built and gated rather than built and shipped as usable.

**One item was deliberately not built: a vanity salt miner.** The plan listed `predictVanityTokenAddress` and `hasVanitySuffix`; [neither exists](#both-generations-can-name-a-launchs-address-before-it-exists), on either factory. Mining locally needs the creation-code hash and therefore both compilers; `--salt` takes a value mined elsewhere instead.

Two things found while building on earlier phases:

- **`resolveUnits` only understood curves.** A V3 pool reports its two sides as `token0`/`token1` rather than `token`/`pairToken`, so every V1 swap in `pons watch` and `pons tx` printed unscaled wei. Both shapes now land in the same map.
- **`TOKEN_NOT_FOUND` exited 1, not 2.** An address that is not a Pons launch is a bad argument, not an unclassified failure, and now that both registries are consulted the distinction is worth making.

### One more ABI provenance category: a verified instance

Two contracts needed here are deployed many times over, with no canonical address: the Uniswap V3 pool and V1's launch token. Each has instances a verifier has matched against deployed bytecode, but "this instance's ABI describes the others" is an assertion, so `INSTANCE` in the generator proves it the way `CROSS_CHAIN` proves Permit2: every function selector must also appear in a **second, independently chosen** instance, and both runtimes must be the same length.

| generated file | verified at | proven against | runtime |
|---|---|---|---|
| `v3Pool.ts` | `0x2D0e…4a7c` | `0x4783…2Aa4D` | both 22,142 bytes |
| `v1Token.ts` | `0x9713…C7EC` | `0x8859…6aBDf` | both 5,274 bytes |

The instances are not byte-identical and cannot be: a V3 pool holds `factory`, `token0`, `token1`, `fee` and `tickSpacing` as immutables, which live inside the runtime code.

> **V1's token is not derived from source the way V2's is.** It could be, since its source is inside the V1 factory's verified compilation, except that the V1 factory was compiled with **solc 0.8.30** and V2 with **0.8.35**, and the `solc` package installs one version. Pulling a second compiler over the network at generate time is a worse dependency than taking the ABI from an instance a verifier has already matched.

### Phase 6: Agent surface and release *(complete, except the publish)*

- `src/mcp/`: six tools over the same `core/`, plus `src/mcp.ts` as the stdio binary
- `core/receipt.ts`: the transaction reader lifted out of `commands/tx.ts`, so both front ends share it
- `.claude/`: two hooks and the `verify` skill; `CLAUDE.md` with `AGENTS.md` symlinked
- `scripts/mainnet-e2e.sh`: the sequence a simulation cannot prove, gated behind `PONS_E2E`
- `src/index.ts`: the two generations namespaced rather than flattened
- README rewritten for the finished surface

**Output:** feature-complete. 346 tests. **Not published**, because putting a package
on a public registry is irreversible and outward-facing, so it is a separate,
deliberate step rather than something a green build does on its own.

### The MCP server cannot sign, and that is the design

`pons-mcp` never loads a keystore, never prompts for a password and never
broadcasts. It reads the chain and it returns unsigned calldata; a person sends
it. There is no flag that changes this and no tool that bypasses it, and a test
asserts that no tool is named for sending and that every one of them carries
`readOnlyHint`.

The reasoning is the same one that made read-only the CLI's default, taken one
step further. A CLI is driven by somebody who typed the command; an MCP server
is driven by a model that a prompt can steer. The worst a confused agent should
be able to do through this server is quote a bad price.

Two consequences worth stating:

- **An approval is reported, not encoded.** When a sell needs one, the tool says
  which spender needs how much and stops there. Handing a model a second piece
  of signable calldata for a step it did not ask about is how an approval ends
  up sent on its own, to a spender nobody re-read.
- **stdout is the JSON-RPC channel.** Nothing in that process may `console.log`;
  one stray line desynchronises the client's parser. The RPC layer's warnings
  are routed to stderr for exactly this reason, which is a thing the CLI never
  had to care about.

Answers are base units, with no human formatting. The consumer can do exact
arithmetic on `50000000000000000` and cannot on `0.05`.

### Why the MCP SDK, at 94 extra packages

The CLI's whole character is a short dependency list of `commander` and `viem`,
both load-bearing. The MCP server broke that, and the number is worth writing
down rather than discovering later:

| production install | packages | `node_modules` |
|---|---|---|
| `commander` + `viem` | **14** | 74 MB |
| plus `@modelcontextprotocol/sdk` | **108** | 98 MB |

The additions include `express`, `cors`, `body-parser`, `ws`, `jose`, `ajv` and
`hono`. That is an HTTP server stack, pulled in because the SDK ships HTTP and SSE
transports beside the stdio one. **We use only stdio and touch none of it.**

`zod` is not part of that cost. It was already in the tree through
`viem → abitype`, so declaring it directly adds nothing; it is declared because
the SDK's `registerTool` accepts only zod schemas (`AnySchema = z3.ZodTypeAny |
z4.$ZodType`, not raw JSON Schema), and importing a package we do not own would
be worse than naming it.

**Bundling it away was tried and does not work.** With tsup's `noExternal`,
`dist/mcp.js` grows from 15 KB to 855 KB and contains no Express at all, so the
tree-shaking is fine. The binary then dies on startup:

```
TypeError: Cannot read properties of undefined (reading 'code')
    at addFormats (ajv-formats/dist/index.js:30)
```

`ajv` loads its formats plugin through a runtime `require()` that an ESM bundle
cannot satisfy. Marking `ajv` external would put it back in `dependencies`,
which is the thing being avoided.

So the SDK stays, deliberately. MCP is a moving specification and this is a
server other people's clients connect to; hand-rolling the framing, the
`initialize` negotiation and the content types would put protocol compliance on
us for the life of the project. The install cost buys that, and it is a cost
paid once at install rather than on every command, since `pons` itself never loads
any of it.

### Proving sequences without a local node

The plan assumed the only way to prove a sequence was a forked local node, and
recorded the absence of one as an open gap from Phase 3 onward. That was wrong.
Robinhood Chain answers **`eth_simulateV1`**, which runs a list of blocks, each
holding a list of calls, **carrying state across all of them**, with state
overrides, against live mainnet state.

Probed on 2026-08-25:

| method | official endpoint |
|---|---|
| `eth_simulateV1` | **supported** |
| `eth_getProof` | supported |
| `debug_traceCall` | `-32601` |
| `debug_traceTransaction` | `-32601` |
| `eth_createAccessList` | `-32601` |

So no `anvil`, no Docker, no second toolchain: `npm run test:sequence` proves in
one RPC call what the plan reserved a local fork for. Six sequences run today,
including the whole life of a launch: created, traded, taken past its
graduation threshold, and seeded into a Uniswap V4 pool, five blocks, all of it
free.

**Two rules make the results mean anything.**

**Every sequence has a control that must fail.** A V1 sell needs its tokens, and
those arrive by storage override; if the sell also succeeds *without* its
approval, the override was doing the work and the passing run proved nothing.
The control is what separates the two.

**Status alone is not success.** A call to an address holding no code returns
`status: 0x1` and no output, so it does not revert. The "buy the launch's curve
without launching it" control passes on status and fails only on output, which
is how that mistake was caught while writing the harness. Every step that is
meant to reach real code asserts that something came back.

### The buy that crosses the threshold sweeps the curve

Found by the lifecycle sequence, and not visible to any single-call simulation:
after a buy takes the curve past its graduation threshold, `graduate()` reverts
`WrongGraduationPhase`. The sweep already happened **inside that buy**, so the
launch is in `Swept` before anyone calls the factory, and only
`createGraduatedPool()` is left.

`pons graduate` was already right about this, since `--phase both` computes
`needsSweep` from the phase and does whichever steps remain, but it was right
on the strength of a reading of the source. It is now right on the strength of a
test that fails if the behaviour changes.

### What `mainnet-e2e.sh` is for

Everything else in this repository is free to run. The suite is offline, and
`--dry-run` simulates against live state with a balance override, which proves
a call works without holding funds, and is how most of the claims in this
document were verified.

What it cannot prove is a **sequence**. A simulation is one call against one
block. It cannot show that an approval confirms and the sell in the next block
then succeeds, that a launch lands and the curve it created is buyable a block
later, or that a receipt decodes the way the decoder says it will. Those are the
failures that reach a user.

[`eth_simulateV1` now covers that](#proving-sequences-without-a-local-node), for
free and repeatably, which is where the sequence proof should come from. What
this script still adds is the one thing a simulation cannot: a **real**
transaction, signed by a real key, accepted by the real mempool, with a real
receipt to decode. Simulation proves the calldata; this proves the pipeline
around it. It is off unless
`PONS_E2E=i-understand` is set, asks before every transaction rather than once
at the start, and must never run in CI.

---

## Audit, 2026-08-25

A code and security review of the finished CLI. Six findings, each reproduced
before it was fixed and each covered by a regression test that names the defect
rather than the current shape. Two hypotheses were investigated and **refuted**;
they are recorded too, because a negative result is the part of an audit that
stops the same ground being covered twice.

### The rebuilt plan could be signed below the floor its user accepted

The worst of the six, and invisible from reading either half on its own.

`runPlan` rebuilds a plan from live state immediately before broadcasting.
The rebuilt plan carried **its own** slippage floor, computed from the new
price, while `floorCheck` only asked whether the new *quote* still cleared the
old floor. Both halves look right. Together they mean: whenever the price moves
adversely at all, the signed floor is lower than the accepted one, and the trade
proceeds as long as the move is inside the tolerance.

Measured, with `--slippage 100` on a 0.05 ETH buy:

| interfering trade | gate | signed floor |
|---|---|---|
| 0.001 ETH | proceeds | 3.47e21 units lower |
| 0.010 ETH | proceeds | 3.47e22 units lower |
| 0.020 ETH | proceeds | 6.91e22 units lower |
| 0.030 ETH | refuses | n/a |

At the worst point the gate still allows, an interfering trade of 0.0253 ETH,
the user could receive **0.99% below the floor they approved**. A 1% tolerance
was in practice a band of nearly 2%.

This also contradicted what this project had written down. The README's claim
that "the slippage floor is not recomputed" described the intent, not the code.

**Fixed** by carrying the accepted floor into the rebuild. `rebuild` now
receives the plan the user approved, every builder takes an optional `minOut`,
and `floorAtLeast` takes the higher of the computed and accepted floors, so a
favourable move is not given back either. `floorCheck` stays as the pre-flight
refusal, which still saves the gas of a doomed send.

### `BROADCAST_FAILED` asserted something it could not know

Every failure out of `sendTransaction` was reported with `nothing was sent; the
nonce is unchanged`. But `eth_sendRawTransaction` can fail *after* the node has
the bytes, whether a dropped socket or a timeout on the response, and the client cannot
tell that from a rejection. Reproduced against a stub node that took the
transaction and then dropped the connection: the raw transaction demonstrably
arrived, and the CLI told the user nothing had been sent.

That is an invitation to retry, and a retry makes the same trade twice. It is
the exact failure this module's own "broadcast exactly once" rule exists to
prevent, sitting inside its error message.

**Fixed** in two parts. The transaction is now signed *before* it is sent, so a
hash always exists and can be reported however the send goes. On failure the
account's pending nonce is read from the same pinned endpoint: if it moved, the
node has the transaction and the error is `BROADCAST_UNCERTAIN` with the hash
and "do not retry blindly"; if it did not, `BROADCAST_FAILED` says so and names
the unchanged nonce. An endpoint that cannot answer leaves the question open,
which is reported as uncertain rather than resolved conveniently.

### A poisoned pair cache could quote a launch in the wrong asset

`pons pairs` folds the approval history once and caches it. The addresses are
re-confirmed against `approvedPairTokens` on every run, but the **symbols**
were taken from the cache and never checked. Swapping two approved assets'
symbols in `~/.cache/ponscli/pairs.json` therefore survives every on-chain
check, including the decimals guard, because the decimals stay attached to their
own address:

```
0xd0601ce1…9eec  symbol=USDG  decimals=18     really NVDA
0x5fc5360d…d168  symbol=NVDA  decimals=6      really USDG
```

`pons launch --pair NVDA` then quotes an irreversible launch in USDG.

**Fixed** by re-reading the resolved asset's `symbol()` from its own contract
before a launch: one call, on the one path where the answer cannot be undone.
A trade names its token by address and never consults this list, so it pays
nothing. The cache directory is also created `0o700` now: it decides which asset
a launch is quoted in, which is not the inert scratch space the name suggests.

### A malformed keystore crashed instead of explaining

Fields read straight out of the file reached crypto primitives that raise their
own errors:

| tampering | what the user saw |
|---|---|
| `address` truncated | `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` |
| `address` a number | `TypeError: keystore.address.toLowerCase is not a function` |
| `dklen: 16` | `ERR_CRYPTO_INVALID_KEYLEN` |

The realistic way to arrive here is not an attacker but a half-written file
after an interrupted write, and none of those messages tells its owner that.

**Fixed** with a shape check in `readKeystoreFile` covering the address, the hex
fields and the scrypt parameters, all reported as `WALLET_UNREADABLE` with the
reason. `decryptKeystore` compares buffer lengths before `timingSafeEqual`, so
it is safe called on its own.

### `--from` and the unlocked key were never compared

`from = signer?.address ?? options.account` silently preferred the signer.
`pons sell TOKEN all --from A --confirm` with keystore B sized the sell against
**A's** balance and took it out of **B's** tokens.

**Fixed**: two ways of naming an account that disagree is a `ACCOUNT_MISMATCH`
usage error, not a preference to resolve quietly.

### `pons watch` died on the first transient failure

The follow loop had no error handling, so one moment of both free endpoints
answering 429, an ordinary minute on this chain, ended a command whose whole
purpose is to keep running.

**Fixed** with exponential backoff and a five-failure ceiling, reporting each
retry. The cursor is already on disk, so the only cost of waiting is the wait.

### What was investigated and refuted

- **scrypt parameter DoS.** A keystore naming `n = 2^22` would need about 4 GB.
  It does not allocate: `SCRYPT_MAXMEM` refuses in 2 ms. The constant works.
- **A window where a force-overwritten keystore is world-readable.** The mode
  ends at `0600` in every case tested, because `chmodSync` follows the write.

### What was checked and found clean

Unlimited approvals (only Permit2, as that protocol requires, and warned about);
keystore file mode and the absence of the raw key on disk; `wallet export`
refusing without `--yes`; the MCP server's inability to sign; URL redaction of
credential-shaped path segments and query parameters.

## Facts most likely to be re-derived wrongly

This section exists so that a future reader, human or agent, does not fall into a plausible-looking but wrong assumption.

1. **`snipeTaxSeconds` is 3, not 15.** The source says 15; the chain says 3. Protocol parameters come **from the chain, not the source**.
2. **A native transfer must not be signed at 21000 gas.** Nitro takes the poster cost out of the transaction's own limit and `eth_estimateGas` does not reveal it. It works while L1 is cheap, so it breaks intermittently.
3. **RH's Uniswap V3 factory is not the canonical address.** It is `0x1f7d…2efa`, not `0x1F98…`.
4. **`poolFee = 0` in the V2 launch config is not a bug.** It is a V4 dynamic fee, governed by the meme hook.
5. **`eth_chainId` is not a health check.** drpc answers it and rejects `eth_call`.
6. **`eth_getLogs` has no block-range cap, it has a timeout.** And the limit is cumulative across consecutive queries, not per query.
7. **The official RPC is not an archive node.** State older than ~6-10k blocks returns `metadata is not found`. Logs go back much further than state does; do not infer a deployment block from `eth_getCode`.
8. **V1 and V2 event signatures differ.** V2's topic0s cannot be used for V1.
9. **Never clamp `toBlock`.** If a provider is behind, skip it; do not rewrite the request.
10. **A JSON-RPC error reply is not unhealthiness.** The server answered with HTTP 200; it merely declined the request.
11. **Pons has no REST API.** `ponsfamily.com/api/*` returns 404. Everything is read from contracts.
12. **The buyback is not holder fee sharing.** Bought-back supply is not distributed to holders; it is split between creator and protocol over five years. Pons has no direct holder fee distribution.
13. **`--buyback` is not free for the creator.** The lock is funded from the creator's own fee share and only their share comes back, so the net effect transfers value from creator to protocol.
14. **The approved pair token list is not static and not short.** RIVN was approved and then revoked. A 12M-block window returned **6 of 23**, so scan the full history.
15. **USDG is 6-decimal.** Every other approved pair token is 18. A wei-denominated phantom reserve applied to it misprices the curve by twelve orders of magnitude.
16. **Creator and deployer are already snipe-tax exempt.** `--exempt` is only for further addresses of your own choosing; adding yourself wastes the quota.
17. **Not every contract is on Sourcify.** All five Pons contracts verify there as `exact_match`; the chain-local Uniswap deployments (`swapRouter`, `UniversalRouter`, `PoolManager`) are only on Blockscout. The generated ABI files record which verifier answered, because the two make different claims.
18. **A request with no User-Agent gets a 403.** The public RPC endpoints reject it at the WAF. Node's `fetch` sends none by default, so an endpoint can look completely dead when it is merely unidentified.
19. **nodeflare is metered, not weak.** One request per ten seconds per IP. Given that spacing it serves 1M-block log queries and archive state. Probing it at full speed reports a healthy node as broken, which is the doctor's own version of the health-check trap.
20. **The official endpoint is not the archive one.** Of the two Tier 1 endpoints, the *slower, metered* one retains history and the fast one prunes. Historical reads route to Tier 1 before Tier 2.
21. **The curve and the launch token are verified nowhere.** They are deployed per launch. Their ABIs come from compiling the factory's verified standard-JSON input and matching the result against a live instance's runtime bytecode, outside its immutables.
22. **A failed sell usually reverts from the token, not the curve.** `ERC20InsufficientAllowance` is declared by `PonsV2LauncherToken`; a decoder holding only the curve's ABI reports it as an unknown selector.
23. **`eth_getLogs` also caps the result set at 10,000 logs**, and enforces it by estimate rather than by count. A query returned **11,690** logs; twice the range was refused with `logs matched by query exceeds limit of 10000`. Separate from the timeout, with separate wording, and both have to be recognised.
24. **`pairTokenEconomics(address(0))` returns zeros.** Native economics are not in that mapping; they come from the launch config or the curve's own snapshot.
25. **The factory's `swept*` fields are cleared by `createGraduatedPool`.** They read as zero in the `PoolCreated` phase, which is most of the time.
26. **The snipe tax reaches one basis point inside the window, not zero.** Fourteen halvings of 9,900 leave 1; the exact zero comes from the `elapsed >= window` branch, not from the decay.
27. **Terminal column width is not string length.** A CJK ideograph is one code unit and two columns; an emoji is two units and two columns. Token names are user-supplied and routinely both.
28. **A Pons graduated pool is keyed on native ETH, not WETH.** `pairToken` is `address(0)` for a native launch and always sorts first. A V4 encoder that wraps first leaves WETH in a router whose pool wants ETH.
29. **`poolFee = 0` is a static zero, not the dynamic-fee flag.** `LPFeeLibrary.DYNAMIC_FEE_FLAG` is `0x800000`; the launch config's zero is literal. The hook takes its cut through the swap delta instead.
30. **The RH UniversalRouter's `V3_SWAP_EXACT_IN` needs a trailing `address[]`.** Without it the fork reads past the input and reverts `SliceOutOfBounds`. Its `V4_SWAP` is stock, so the difference is per command rather than per router.
31. **A curve buy takes its fees off the input; a sell takes them off the output.** The two directions are not mirror images, and swapping the order overstates a sell by the fee.
32. **The buy's slippage check is a price bound.** `spent * minOut > received * tokensOut`. A clamped fill is held to the price, not to the quantity, which is why the floor is computed against the amount offered.
33. **Permit2 still needs an unbounded ERC-20 approval underneath it.** The signature replaces the per-trade allowance, not the approval to Permit2 itself.
34. **The canonical signature of a tuple parameter is its component types in parentheses.** The literal word `tuple` hashes to a selector that matches nothing, failing silently on exactly the functions and errors that carry structs.
35. **A private key must never arrive as a command-line argument.** argv is in the process table and in shell history. `PONS_PRIVATE_KEY` for import, a hidden prompt or `PONS_PASSWORD` for unlocking.
36. **The factory refuses any `msg.value` but the launch fee exactly.** `msg.value != launchFee`, not `<`. There is no overpaying a dev buy into `launchToken`; the atomic path is `PonsV2LaunchAndBuy`, and it is the factory's `launchForwarder`.
37. **V2 can name a launch's address before it exists.** `TokenParams.salt` plus `PonsV2LaunchDeployer.predictLaunchAddresses`. Pre-launch address preview is not a V1-only capability.
38. **Launch metadata limits are in bytes.** 64 / 16 / 512 / 2048 / 256. Seventeen cat emoji are seventeen characters and sixty-eight bytes.
39. **A dev buy costs an exemption slot.** The router appends the buy's recipient whether or not the caller listed them, so the creator's own list stops at 31 rather than 32.
40. **The economics guard is per quote asset.** `previewLaunchEconomics(configId, pairToken)`: the digest for USDG is not the digest for ETH, and pinning the wrong one reverts.
41. **`toFunctionSelector` given an *error* ABI item signs `error Name()`.** Keyword included, so the selector matches nothing. Build the signature string by hand for errors; the item form is only safe for functions.
42. **viem's `getLogs` has no raw `topics` parameter.** Pass `event`/`events`; a `topics` array is dropped and the request goes out as `"topics":[]`, which is an unfiltered scan of the whole range.
43. **A log's `logIndex` is only unique within a block.** Matching decoded logs back to raw ones by index alone is correct for one receipt and wrong for every historical scan.
44. **V1 is closed, not idle.** `launchEnabled()` is false and no address has ever been whitelisted, so `launchToken` reverts `NotWhitelisted` for everybody. Its **tokens still trade**: 223 swaps across a forty-pool sample in under six days.
45. **V1's `msg.value` is a floor; V2's is an equality.** `msg.value >= launchFee` and the excess **is** the opening buy. The two factories are opposites here, and the sentence that was wrong about V2 was a true sentence about V1.
46. **`predictVanityTokenAddress` and `hasVanitySuffix` do not exist.** Neither factory has them; there is one prediction function, `predictTokenAddress`, and no vanity search anywhere in the protocol.
47. **V1's salt is not namespaced by the launcher.** The deployer is inside the token's creation code instead, which is why `predictTokenAddress` takes it as an argument. V2 namespaces the salt itself.
48. **A V1 pool holds WETH, not native ETH.** A buy is wrapped by the router out of `msg.value`; a sell has to leave its output at the router and `unwrapWETH9` it in a second call, or the seller is handed WETH.
49. **RH's V3 router is a stock SwapRouter02.** No `deadline` inside `exactInputSingle`; it lives on `multicall(uint256,bytes[])`. `MSG_SENDER` is `address(1)` and `ADDRESS_THIS` is `address(2)`. Unlike the UniversalRouter, this one is not forked.
50. **V1's transfer caps expire after two blocks.** `maxWalletBps` and `maxTxBps` bind only while `block.number <= restrictionEndBlock`. Every tradeable V1 token is long past it.
51. **The locker's protocol share is a percent, not basis points.** `tokenProtocolFeeShares[token] / 100`. Reading 30 as bps understates it a hundredfold.
52. **`collectFees` is not permissionless.** Unlike `graduate` and `vault release`, the locker accepts only the owner, the deployer, the fee-redirect recipient, or a whitelisted collector.
53. **The two factories were compiled with different solc versions.** V1 with 0.8.30, V2 with 0.8.35. Anything deriving an ABI from V1's standard-JSON input needs the older compiler, which the repo does not install.
54. **A V3 pool names its sides `token0`/`token1`, a curve names them `token`/`pairToken`.** Code that resolves units from one shape silently prints the other's amounts unscaled.
55. **An MCP server's stdout is its protocol channel.** A single `console.log` anywhere in that process desynchronises the client's parser. The RPC layer's warnings go to stderr for this reason, which the CLI never had to care about.
56. **A call to an address with no code succeeds.** `status: 0x1`, empty output, no revert. Any test asserting on status alone will pass against a contract that was never deployed.
57. **The buy that crosses the graduation threshold sweeps the curve itself.** `graduate()` afterwards reverts `WrongGraduationPhase`; only `createGraduatedPool()` remains.
58. **`eth_simulateV1` is supported on this chain; the `debug_*` namespace is not.** Multi-block, multi-call, state-carrying simulation is available over plain RPC. `debug_traceCall`, `debug_traceTransaction` and `eth_createAccessList` all answer `-32601`.
59. **Blockscout's API is rate limited.** Regenerating eight ABIs twice in a row draws 429s. The fetch script backs off for two seconds per attempt on 429 specifically, otherwise `abi:check` is a flaky CI gate. It also leaves already-committed files alone unless `--check` or `--refresh` asks for them: adding one contract should not spend the other nine's quota, and a sweep of ten drains the bucket for minutes.

---

## Open questions

| # | Topic | Note |
|---|---|---|
| ~~03~~ | ~~V1 scope~~ | **Closed.** Re-measured on 2026-08-25: the factory is retired, its tokens trade. Read and trade shipped; launch gated. |
| 04 | ERC-20 `--scan` | Tracked list is the default; should a full `Transfer` log scan be added as an optional flag? |
| 05 | Logo hosting | Pons stores metadata as on-chain strings. Optional IPFS pinning later? |
| ~~06~~ | ~~Pair symbol collisions~~ | **Closed.** `pons pairs` resolves symbols from the live list and refuses to choose between two assets sharing one, rather than guessing. |
| 08 | Sweeping curve fees | `sweepFees(uint256)` is permissionless and `pons info` shows the pending amount, but no command calls it, so `claim` can only ever see what a sweep has already moved. A `--sweep` on `claim`, or a separate verb? |
| 07 | Vanity salt mining | Neither factory ships a search, and mining locally needs both compilers' creation code. Worth the weight, or leave `--salt` taking a value mined elsewhere? |

---

*Measurements taken 2026-08-25 on Robinhood Chain 4663.*
