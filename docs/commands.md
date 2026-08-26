# Command reference

Every command accepts the [global flags](#global-flags) anywhere on the line, and
every command emits JSON when stdout is not a terminal.

- [Reading](#reading), no key required
- [Trading](#trading)
- [Launching](#launching)
- [Fees and lifecycle](#fees-and-lifecycle)
- [Wallet](#wallet)
- [Configuration and diagnostics](#configuration-and-diagnostics)
- [Global flags](#global-flags)
- [What each command touches on chain](#what-each-command-touches-on-chain)
- [Exit codes](#exit-codes)

Throughout, `<token>` is a token contract address. You never say which generation
it belongs to: both factories are asked, and the answer decides the rest.

---

## Reading

### `pons info <token>`

Price, supply, graduation progress, fees, and, for a V2 launch still on its
curve, the snipe tax a buyer would pay right now.

The two generations answer with different shapes, distinguished by a
`generation` field, because they genuinely differ: V2 has reserves and a
graduation phase, V1 has a pool and a locked position.

```sh
pons info 0xcF5bA8DB535a55D06493360018EbDEbbdaEbC3E6
```

> Once a V2 token graduates its curve is drained, so the price the curve would
> report is zero. `price` and `marketCap` come back `null` rather than `0`.

### `pons pairs [--config <id>] [--refresh]`

The quote assets a V2 launch may be priced against: native ETH plus the approved
tokenised equities and one stablecoin.

Read live from the factory and rendered in **approval order**, which is the order
the Pons web client uses, so the two lists agree row for row. The full approval
history is replayed once and cached; `--refresh` replays it from scratch.

| flag | meaning |
|---|---|
| `--config <id>` | Launch config the native row is priced against. Default `0`. |
| `--refresh` | Ignore the cache and replay the whole approval history. |

### `pons watch <token> [--since <blocks>] [--interval <s>] [--once]`

Follow one launch: curve trades, buybacks and graduation for V2; pool swaps and
fee collections for V1.

| flag | meaning |
|---|---|
| `--since <blocks>` | History to print before following. Default `1000`. |
| `--interval <s>` | Seconds between scans. Default `3`. |
| `--once` | Print the backlog and exit. |

> **Not a per-block poll.** At ten blocks a second, asking for the head every
> block is ten requests a second to learn that nothing happened. `watch` keeps a
> cursor and asks for the blocks that accumulated since it last looked. The
> cursor is cached, so a second run resumes where the first stopped.

### `pons tx <hash>`

Receipt, decoded logs, and the reason a failure failed.

A receipt carries `status: 0` and nothing else on any EVM chain. The reason is
recovered by replaying the call at the block it landed in, then translating the
four-byte selector.

> Replaying needs state the node still holds. The official endpoint keeps
> roughly a quarter of an hour of it; past that the command says the reason
> could not be recovered rather than reporting none.

---

## Trading

`buy` and `sell` share every flag. Neither signs anything without `--confirm`.

```sh
pons buy  <token> <amount> [flags]
pons sell <token> <amount> [flags]
```

`<amount>` for a buy is the quote asset to spend (`0.05`). For a sell it is a
token amount, a percentage (`50%`), or `all`.

| flag | meaning |
|---|---|
| `--slippage <bps>` | Tolerance in basis points; `100` is 1%. Defaults to `trade.slippageBps`. |
| `--from <address>` | Account to trade for, when there is no keystore. |
| `--recipient <address>` | Who receives the proceeds. Defaults to the trader. |
| `--route <venue>` | `auto` (default), `curve`, `v4` or `v3`. |
| `--dry-run` | What the default already does, build and simulate then stop, said explicitly. |
| `--unsigned` | Print calldata and value instead of signing. |
| `--confirm` | Sign and broadcast. |

**The venue is not a choice you have to make.** The launch record says where the
token trades, and `--route` overrides that answer rather than searching for one.
Asking for a venue a token does not trade on is refused, not silently ignored.

**The floor is fixed when you accept it.** The plan is rebuilt from live state
immediately before broadcasting, and the floor you accepted is carried into the
rebuild rather than recomputed from the new price. A recomputed floor falls
with the price, which would make the tolerance you asked for roughly twice as
wide. If the fresh quote no longer clears the accepted floor, nothing is sent.

**Approvals are handled in order.** A V2 sell needs the curve approved, a V1 sell
needs the router approved, and an ERC-20-quoted V2 buy needs the quote asset
approved. Each is added as a step before the trade and only for the exact amount.

---

## Launching

```sh
pons launch --name <name> --symbol <symbol> [flags]
```

The one command here that cannot be undone. It spends the launch fee, deploys two
immutable contracts, and freezes the creator tax, the quote asset and the
snipe-tax exemption list for the life of the token.

| flag | meaning |
|---|---|
| `--name <name>` | Up to **64 bytes**. Required. |
| `--symbol <symbol>` | Up to **16 bytes**. Required. |
| `--desc <text>` | Up to 2048 bytes. |
| `--logo <url>` | Up to 512 bytes. |
| `--twitter` `--telegram` `--discord` `--website` `--farcaster` | Up to 256 bytes each, stored on chain as strings. |
| `--config <id>` | Launch config. Default `0`. |
| `--pair <symbol\|address>` | Quote asset, resolved against the live `pons pairs` list. Default `ETH`. |
| `--creator-tax <bps>` | Trade tax paid to you. Bounded by the live `maxCreatorTaxBps`. |
| `--buyback` | Enable the buyback vault. **Costs you, not holders.** |
| `--dev-buy <amount>` | Opening buy, atomic with the launch. |
| `--slippage <bps>` | Floor on the opening buy. |
| `--exempt <addr,addr>` | Extra wallets exempt from the snipe tax. **Cannot be added later.** |
| `--recipient <address>` | Who receives the opening buy. |
| `--fee-recipient <address>` | Who earns the creator fees. |
| `--salt <hex\|text>` | CREATE2 salt. A 32-byte hex value is used as given; anything else is hashed. |
| `--from <address>` | Launch from this account, when there is no keystore. |
| `--generation <v1\|v2>` | Which factory. Default `v2`. |
| `--dex <id>` | V1 only: which dex config. |

> **Limits are in bytes, not characters.** Seventeen cat emoji are seventeen
> characters and sixty-eight bytes. Measured the wrong way a name looks well
> inside the limit and reverts on chain.

**The address is known before you send.** Both generations deploy with CREATE2
from a salt you choose, so the token and curve addresses are printed in advance
and a salt that is already taken is refused.

**The terms are pinned.** For V2, `previewLaunchEconomics` returns a digest
covering the supply, the curve fee, the pool's fee tier and the protocol's fee
split, and it travels with the launch. If the protocol owner changes any of them
while your transaction is in flight, the launch reverts rather than quietly
repricing.

**`--dev-buy` is atomic, and for V2 it has to be.** The V2 factory demands
exactly the launch fee and nothing more, so an opening buy cannot ride along with
it; the buy goes through the launchpad's own router in the same transaction
instead. V1 is the opposite: it reads any value above the fee as the buy.

> **V1 is closed.** `launchEnabled()` has been false since 2026-08-12 and no
> address has ever been whitelisted, so `--generation v1` refuses before building
> anything. The path exists because the flag is one owner call from being true
> again.

---

## Fees and lifecycle

### `pons graduate <token> [--phase sweep|pool|both]`

Finish a V2 curve that has raised its threshold. **Anyone may call this**, and a
holder does not have to wait for the creator.

Two phases: `graduate()` drains the curve, `createGraduatedPool()` seeds the
Uniswap V4 pool. `both` is the default and does whichever steps remain.

### `pons claim [--token <address>] [--from <address>]`

Claim creator or protocol fees held in the V2 fee escrow. `--token` claims an
ERC-20 quote asset instead of native ETH.

Reads what is owed first: an empty claim is a wasted transaction, and the escrow
reverts on nothing rather than paying zero.

### `pons collect <token> [--from <address>]`

V1's equivalent: collect the launch's accrued Uniswap V3 position fees through
the locker.

**Not permissionless.** The locker accepts only the protocol owner, the launch's
deployer, its fee-redirect recipient, or a whitelisted collector.

### `pons vault show <token>` / `pons vault release <token>`

The V2 buyback vault: locked, released and vested supply, and a permissionless
release of whatever has vested.

> The buyback is **not** holder fee sharing. It is funded from the creator's own
> fee share and split between creator and protocol over five years.

---

## Wallet

```sh
pons wallet create                          # generate a key into an encrypted keystore
pons wallet import                          # encrypt an existing key from PONS_PRIVATE_KEY
pons wallet show                            # print the address; needs no password
pons wallet export                          # decrypt and print the private key
pons wallet balance [--token <address>...]  # native, plus every tracked token
pons wallet track <token>
pons wallet untrack <token>
pons wallet transfer <to> <amount> [--token <address>]
pons wallet sweep <recipient>               # everything, less what the transfer costs
```

The keystore is scrypt + AES-256-GCM. A password comes from a hidden prompt or
`PONS_PASSWORD`, and a key to import from `PONS_PRIVATE_KEY`, **never from a
flag**, because an argument is visible in the process table and lands in shell
history.

> **A native transfer is signed with a fixed 100,000 gas limit.** Nitro charges
> the L1 posting cost out of the transaction's own limit and `eth_estimateGas`
> does not say so. At 21,000 a transfer works while L1 is cheap and fails
> intermittently when it is not.

---

## Configuration and diagnostics

```sh
pons config list [--configs]     # every setting, its value, and where it came from
pons config get <key>
pons config set <key> <value>
pons config unset <key>
pons config path
pons doctor [--stats] [--wait]   # probe every endpoint with real calls
```

`--configs` adds the factory's live launch policy, read from the chain.

`doctor` probes each endpoint with the calls the CLI actually makes: a contract
read, a log query and a historical state read, never a liveness ping. One public
endpoint on this chain answers `eth_chainId` faster than any other and then
rejects `eth_call`.

| flag | meaning |
|---|---|
| `--stats` | Also print the waterfall's activation counters. |
| `--wait` | Pace probes to a metered endpoint's interval instead of stopping at its limit. |

---

## Global flags

Accepted anywhere on the line: `pons config list --json` and
`pons --json config list` are equivalent.

| flag | config key | meaning |
|---|---|---|
| `--json` | `output.json` | Machine-readable output. On by default when stdout is not a TTY. |
| `--human` | `output.json` | Force human output even when piped. |
| `--color <mode>` | `output.color` | `auto`, `always`, `never`. Honours `NO_COLOR`. |
| `--rpc <url>` | `rpc.url` | Your own node, tried before the shared endpoints. |
| `--rpc-tier <tier>` | `rpc.tier` | Pin the waterfall: `auto`, `1`, `2`. |
| `--timeout <ms>` | `rpc.timeoutMs` | Per-request timeout. |
| `--keystore <path>` | `wallet.keystore` | Path to the encrypted keystore. |
| `--slippage <bps>` | `trade.slippageBps` | Default slippage tolerance. |
| `--priority-fee <gwei>` | `trade.priorityFeeGwei` | EIP-1559 `maxPriorityFeePerGas`. |
| `--cache-dir <path>` | `cache.dir` | Where immutable chain data is cached. |

Values resolve through a ladder: **flag > environment > config file > default**.
`pons config list` prints the resolved value alongside the tier it came from.

---

## What each command touches on chain

There is no Pons REST API. `ponsfamily.com/api/*` returns 404. Everything below
is read from contracts.

| command | contract | method or event |
|---|---|---|
| `info` (V2) | `PonsV2LaunchFactory`, the launch's curve | `getLaunchedToken`, `getReserves`, `realQuoteReserve`, `getLaunchFeePolicy` |
| `info` (V1) | `PonsLaunchFactory`, Uniswap V3 factory and pool, `PonsLaunchLocker` | `getLaunchedToken`, `graduationStatus`, `getPool`, `slot0`, `feeRedirects` |
| `pairs` | `PonsV2LaunchFactory` | `PairTokenApprovalUpdated` logs, then `approvedPairTokens`, `pairTokenEconomics` |
| `watch` (V2) | the launch's curve, `PonsV2LaunchFactory` | `eth_getLogs` for `CurveBuy`, `CurveSell`, `BuybackLocked`, `LaunchSwept`, `PoolGraduated` |
| `watch` (V1) | the Uniswap V3 pool, `PonsLaunchLocker` | `eth_getLogs` for `Swap`, `Mint`, `Burn`, `FeesClaimed` |
| `tx` | none | `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_call` replay |
| `buy` / `sell` (V2 curve) | the launch's curve | `buy`, `sell` |
| `buy` / `sell` (V2 pool) | `UniversalRouter`, Permit2, `V4Quoter` | `execute`, `permit`, `quoteExactInputSingle` |
| `buy` / `sell` (V1) | `SwapRouter02`, `QuoterV2` | `multicall(deadline, [exactInputSingle, unwrapWETH9])` |
| `launch` (V2) | `PonsV2LaunchFactory`, `PonsV2LaunchDeployer` | `previewLaunchEconomics`, `predictLaunchAddresses`, `launchToken` |
| `launch` (V2, `--dev-buy`) | `PonsV2LaunchAndBuy` | `launchAndBuy` |
| `launch` (V1) | `PonsLaunchFactory` | `predictTokenAddress`, `launchToken` |
| `graduate` | `PonsV2LaunchFactory` | `graduate`, `createGraduatedPool` |
| `claim` | `PonsV2FeeEscrow` | `balanceOf`, `claim`, `claimToken` |
| `collect` | `PonsLaunchLocker` | `collectFees` |
| `vault` | `PonsV2BuybackVault` | `totalLocked`, `vestedAmount`, `releasable`, `release` |
| `wallet balance` | the tracked ERC-20s | `balanceOf`, `decimals`, `symbol` |
| `wallet transfer` / `sweep` | none | native transfer, or ERC-20 `transfer` |
| `doctor` | none | `eth_chainId`, `eth_blockNumber`, `eth_call`, `eth_getLogs`, archive read |
| `config` | none | local filesystem only |

Addresses are in [`src/chain/addresses.ts`](../src/chain/addresses.ts). Protocol
*parameters*, meaning fees, tax windows and the approved pair list, are never hard-coded;
they are read live, because the deployed values differ from the contract sources.

---

## Exit codes

| code | meaning |
|---|---|
| `0` | Success |
| `1` | Unclassified failure |
| `2` | Usage: bad flags, arguments or command |
| `3` | Configuration is missing, malformed or contradictory |
| `4` | Every RPC endpoint failed |
| `5` | The chain answered, and the answer was a revert |
| `6` | Keystore missing, wrong password, or signing refused |
| `7` | The user declined a confirmation |
| `8` | The account cannot pay for what was asked |

In `--json` mode a failure writes `{"ok": false, "error": {…}}` to **stderr**,
never stdout, so a pipe carries only results. See
[`docs/agents.md`](agents.md#errors) for the error shape.
