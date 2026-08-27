# ponscli

[![CI](https://github.com/mesutgulecen/ponscli/actions/workflows/ci.yml/badge.svg)](https://github.com/mesutgulecen/ponscli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ponscli.svg)](https://www.npmjs.com/package/ponscli)
[![node](https://img.shields.io/node/v/ponscli.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/ponscli.svg)](LICENSE)

An **unofficial** command-line interface for the [**Pons**](https://www.ponsfamily.com/) launchpad on **Robinhood Chain** (chain ID 4663), built for developers and agents alike. Not affiliated with Pons or Robinhood; it reads public contracts on a public chain.

- **Read-only by default.** The CLI runs without ever seeing a private key. Signing is an explicit opt-in, so an agent cannot spend by accident.
- **Structured output everywhere.** `--json` on every command, enabled automatically when stdout is not a terminal. Errors are structured too, with stable exit codes.
- **Protocol values are read from the chain.** Fees, tax windows and the approved pair-token list are queried live, never hard-coded. The on-chain values differ from the contract source.
- **Two-tier RPC.** Free endpoints round-robined in Tier 1; a paid endpoint in Tier 2, reached only after Tier 1 is fully exhausted. Without a paid credential, bulk work degrades rather than turning an outage into an invoice.
- **Two binaries.** `pons` for people, `pons-mcp` for models, over the same core, so the price an agent is quoted is the price the CLI prints.

## Install

```sh
npm install -g ponscli
pons --version
```

Or without installing anything. The package is `ponscli` and the binary is
`pons`, so `npx` has to be told which one to run:

```sh
npx -p ponscli pons info 0x44D6…20f4
```

**Two Node versions matter, and they are not the same one.** The CLI *runs* on
**20.11 or newer**, which CI checks on every push by installing the packaged
tarball on exactly that version. *Building* it needs **20.19 or newer**, because
the linter's dependency tree requires it. From a clone, `npm install` builds as
part of the install, and `npm run dev -- <command>` runs it from source.

## Quick start

Reading needs no key, no wallet and no configuration.

```sh
pons info 0x44D6…20f4             # price, reserves, graduation phase, live snipe tax
pons pairs                        # every quote asset a launch may be priced in
pons watch 0x44D6…20f4            # follow one launch's trades as they happen
pons tx 0x2e8d…f58e               # receipt, decoded logs, and why a failure failed
pons doctor                       # probe every RPC endpoint with real calls
```

Trading needs a key. Nothing is signed unless you say so.

```sh
pons wallet create                          # generate a key into an encrypted keystore
pons buy  0x44D6…20f4 0.05                  # price it, simulate it, print it. Nothing is sent
pons buy  0x44D6…20f4 0.05 --dry-run        # the same, said explicitly
pons buy  0x44D6…20f4 0.05 --confirm        # sign and broadcast
pons sell 0x44D6…20f4 50% --slippage 200
```

Everything is machine-readable when piped, and that is the default:

```sh
pons info 0x44D6…20f4 | jq .graduation
```

## Commands

Full reference, including which contract each command touches: **[`docs/commands.md`](docs/commands.md)**.

**Reading**, no key required

| | |
|---|---|
| `pons info <token>` | Price, supply, graduation progress, fees, live snipe tax |
| `pons pairs` | Approved quote assets, in the order [the Pons client](https://www.ponsfamily.com/launchpad/create) renders them |
| `pons watch <token>` | Curve trades, buybacks and graduation, followed with a cursor |
| `pons tx <hash>` | Receipt, decoded logs, and the revert reason behind a failure |

**Trading**, with RPC and a key

| | |
|---|---|
| `pons buy <token> <amount>` | Buy on whichever venue the token trades |
| `pons sell <token> <amount\|50%\|all>` | Sell on the same |
| `pons graduate <token>` | Finish a curve that has raised its threshold. Anyone may call this |

**Launching**

| | |
|---|---|
| `pons launch --name X --symbol Y` | Create a token. V2 by default |

**Fees**

| | |
|---|---|
| `pons claim` | V2 creator or protocol fees held in the escrow |
| `pons collect <token>` | V1 position fees held by the locker |
| `pons vault show\|release <token>` | The V2 buyback vault |

**Wallet and setup**

| | |
|---|---|
| `pons wallet create\|import\|show\|export` | Key management |
| `pons wallet balance\|track\|untrack` | Holdings |
| `pons wallet transfer\|sweep` | Spend |
| `pons config list\|get\|set\|unset\|path` | Configuration, and where each value came from |
| `pons doctor` | Endpoint health, probed with the calls the CLI actually makes |

## The two generations

Pons has launched tokens through two factories, and both are supported. You never have to say which one you mean: both registries are asked, and the answer settles everything after it.

|  | V1 | V2 |
|---|---|---|
| Venue | a Uniswap V3 pool, from the first block | a bonding curve, graduating to Uniswap V4 |
| Quote asset | WETH | ETH, or one of 23 approved tokens |
| Opening protection | wallet and transaction caps, for two blocks | a snipe tax, 99% decaying over three seconds |
| Liquidity | locked forever; only its fees come out | seeded into the pool at graduation |
| Fees | `pons collect` | `pons claim` |
| New launches | **closed** | open |

**V1's factory is retired.** `launchEnabled()` has been false since 2026-08-12, and the transaction that set it is the last thing the factory ever emitted; no address has ever been whitelisted past it, so `pons launch --generation v1` refuses before building anything. Its tokens are another matter. Thousands still hold liquidity, and a forty-pool sample saw 223 swaps in under six days, which is why reading and trading them is fully supported.

## Trading

Every write builds a **Plan** first: what it will send, to whom, what it expects back, and what is worth warning about. That same Plan is what gets simulated and what gets signed, so the three cannot drift apart.

| mode | what happens |
|---|---|
| *(no flag)* | Build the plan, simulate it against live state with a balance override, and print both. Nothing is signed or sent |
| `--dry-run` | The same work, asked for explicitly: `"mode": "dry-run"` in the payload, and no reminder that nothing was sent |
| `--unsigned` | Emit calldata and value for somebody else to sign. The only mode that does not simulate |
| `--confirm` | Sign and broadcast |

Four behaviours worth knowing:

- **The venue is not a choice you have to make.** The launch record says where the token trades. `--route curve|v4|v3` overrides that answer rather than searching for one.
- **The floor is fixed when you accept it.** The plan is rebuilt from live state immediately before broadcasting, and the floor you accepted is carried into the rebuild rather than recomputed from the new price. A trade cannot be signed below the bound you approved, and if the price has moved past it nothing is sent at all.
- **A sell into a curve at its threshold is redirected, not failed.** The curve stops trading once it has raised enough, and `pons graduate <token>` is a call anyone can make.
- **A V1 sell is unwrapped for you.** V1 pools hold WETH rather than ETH, so a sell leaves its proceeds at the router and unwraps them in the same transaction. Selling the obvious way would work and hand you WETH.

## Launching

```sh
pons launch --name "My Token" --symbol MINE --desc "..."      # plan it and simulate it. Nothing is sent
pons launch --name "My Token" --symbol MINE --dry-run         # the same, said explicitly
pons launch --name "My Token" --symbol MINE \
  --pair USDG --creator-tax 250 --dev-buy 100 --confirm       # launch, quoted in USDG
```

A launch is the one thing here that cannot be undone. Before it builds a transaction the command prints the whole of what you are committing to: the address the token will land at, the supply, where it graduates, the fee split, and what the snipe tax will do. It also checks locally everything the factory would reject on chain.

- **The address is known before you send.** Both generations deploy with CREATE2 from a salt you choose, so `pons launch` prints the token and curve addresses in advance and refuses a salt that is already taken. `--salt` accepts a raw 32-byte value, so a mined vanity address works.
- **The terms are pinned.** `previewLaunchEconomics` returns a digest covering the supply, the curve fee, the pool's fee tier and the protocol's fee split, and it travels with the launch. If the protocol owner changes any of them while your transaction is in flight, the launch reverts rather than quietly repricing.
- **`--dev-buy` is atomic, and it has to be.** The V2 factory demands exactly the launch fee and nothing more, so an opening buy cannot ride along with it; the buy goes through the launchpad's own router in the same transaction instead. A launch without one has been bought out inside two blocks on this chain.
- **`--buyback` costs you, not holders.** The vault is funded entirely from your own fee share and releases over five years, split with the protocol. It is not a holder distribution, and the plan says so as a warning rather than a footnote.

`pons pairs` lists the assets a launch may be priced in: native ETH plus the twenty-three approved tokens, which are tokenised equities, two index funds and one stablecoin. They come back in the order [the Pons create page](https://www.ponsfamily.com/launchpad/create) renders them, so the two agree row for row.

## Security

- **Read-only is the default.** No command signs anything without `--confirm`. Three of the four execution modes cost nothing, and every one of them but `--unsigned` proves the call against the deployed contracts first, without the account holding funds.
- **The keystore is scrypt + AES-256-GCM**, written owner-only. A password comes from a hidden prompt or `PONS_PASSWORD`; a key to import comes from `PONS_PRIVATE_KEY`.
- **Neither is ever a flag.** An argument is visible in the process table and lands in shell history. There is no flag that takes either, and `pons config list` says so where somebody would look for one.
- **Credentials never reach a log line.** A paid endpoint carries its key in the URL and error messages embed URLs, so URLs are masked inside thrown errors, not just in formatted output.
- **The MCP server cannot sign.** It never loads a keystore and never broadcasts. See [`docs/agents.md`](docs/agents.md#the-server-cannot-sign).
- **A native transfer is signed with a fixed 100,000 gas limit.** Nitro charges the L1 posting cost out of the transaction's own limit and `eth_estimateGas` does not say so; at 21,000 a transfer works while L1 is cheap and fails intermittently when it is not.

Found something that could cost somebody funds? Please report it privately. [`SECURITY.md`](SECURITY.md) has the how, what is in scope, and what the design guarantees.

## Configuration

Values resolve through a ladder: **flag > environment > config file > default**. `pons config list` prints the resolved value alongside the tier it came from, so a surprising setting is one command away from being explained.

The config file is flat JSON at `$XDG_CONFIG_HOME/ponscli/config.json` (falling back to `~/.config/ponscli/config.json`), written owner-only.

| Key | Environment | Default |
|---|---|---|
| `rpc.url` | `PONS_RPC_URL` | unset. Your own node, tried first |
| `rpc.endpoints` | `PONS_RPC_ENDPOINTS` | the official and nodeflare public endpoints |
| `rpc.alchemyKey` | `PONS_ALCHEMY_KEY` | unset, which disables the paid tier |
| `rpc.tier` | `PONS_RPC_TIER` | `auto` |
| `rpc.timeoutMs` | `PONS_RPC_TIMEOUT_MS` | `10000` |
| `wallet.keystore` | `PONS_KEYSTORE` | `<config dir>/keystore.json` |
| `wallet.tracked` | `PONS_WALLET_TRACKED` | empty |
| `output.json` | `PONS_JSON` | on when stdout is not a TTY |
| `output.color` | `PONS_COLOR` | `auto` (honours `NO_COLOR`) |
| `trade.slippageBps` | `PONS_SLIPPAGE_BPS` | `100` (1%) |
| `trade.priorityFeeGwei` | `PONS_PRIORITY_FEE_GWEI` | unset |
| `cache.dir` | `PONS_CACHE_DIR` | `<cache dir>/ponscli` |

`PONS_PASSWORD` and `PONS_PRIVATE_KEY` are read from the environment but are deliberately **not** config keys: neither belongs in a file that `config list` prints and that users paste into issue reports.

## Architecture

The full document, holding every decision and the measurement behind it, is [`docs/architecture/ponscli.md`](docs/architecture/ponscli.md). The shape in brief:

```
src/core/       business logic, framework-free
src/commands/   thin CLI wiring
src/mcp/        the MCP server, also thin
src/chain/      the RPC waterfall
src/abi/        generated and committed
```

Both front ends are shells over `src/core/`. That is what makes `pons-mcp` a wrapper rather than a second implementation.

### How requests are routed

Tier 1 is a round-robin over free endpoints; Tier 2 is a paid endpoint reached only once every Tier 1 candidate has been tried. Every rule comes from a measurement against this chain's own endpoints rather than from a general-purpose retry policy. The ones that matter most day to day:

- **A revert is an answer, not a failure.** It comes straight back to you instead of being retried across every endpoint and then escalated to the paid tier.
- **A rate limit parks an endpoint for 30 seconds, not an hour.** Free endpoints are token buckets; a long park costs more availability than the throttling did.
- **Writes never round-robin.** A nonce taken from one node and broadcast to another is `nonce too low`, so transactions pin a single endpoint.
- **`eth_chainId` is not a health check.** One public endpoint answers it faster than any other and then rejects `eth_call`. `pons doctor` probes with real calls for exactly this reason.

### ABIs

`src/abi/` is generated and committed, so the CLI works offline and an interface change shows up as a reviewable diff.

```sh
npm run abi:fetch     # regenerate from Sourcify, falling back to Blockscout
npm run abi:check     # fail if the committed files have drifted
```

Each file records where its ABI came from and how the match was proven. There are four provenance classes, because the contracts differ:

| class | example | how it is proven |
|---|---|---|
| Verified at its address | `PonsV2LaunchFactory` | Sourcify's own bytecode match |
| Deployed identically on every chain | Permit2 | verified on Base; every selector present in Robinhood's bytecode |
| Deployed once per launch, verified nowhere | the V2 curve and token | compiled from the factory's verified standard-JSON input, matched byte for byte against a live instance outside its immutables |
| Deployed many times, verified at some | the V3 pool, V1's token | one verified instance, proven general against a second, independently chosen one |

One file is written by hand: `erc20Errors.ts`, holding the errors third-party quote assets revert with. A quote asset is somebody else's token, there is no single ABI covering the twenty-three approved ones, and without these the most ordinary failure on a USDG launch prints as four unexplained bytes.

## For agents

Full guide: **[`docs/agents.md`](docs/agents.md)**.

`pons-mcp` ships in this package as a second binary and calls into the same `core/` the CLI does.

```jsonc
// claude_desktop_config.json, .mcp.json, or your client's equivalent
{
  "mcpServers": {
    "pons": { "command": "pons-mcp" }
  }
}
```

Six tools: `pons_info`, `pons_pairs`, `pons_plan_buy`, `pons_plan_sell`, `pons_transaction`, `pons_endpoints`.

**The server cannot sign, and there is no flag that makes it.** It reads the chain and it builds unsigned transactions; a person sends them. That is the whole security model, and it is why the server is safe to leave running next to a model: the worst a confused agent can do is quote you a bad price, not spend your money.

Answers come back in base units, because a model can do exact arithmetic on `50000000000000000` and cannot on `0.05`.

For an agent shelling out to the CLI instead, `--json` is already the default when stdout is not a terminal, and an argument mistake carries the failing command's usage line so the caller can correct itself:

```json
{
  "ok": false,
  "error": {
    "code": "USAGE",
    "message": "missing required argument 'token'",
    "hint": "run 'pons info --help'",
    "details": { "command": "info", "usage": "pons info [options] <token>" }
  }
}
```

## Agentic coding

This repository carries its own agent configuration. `CLAUDE.md` is the project brief, with `AGENTS.md` symlinked to it for Codex, Cursor, Copilot and others.

| | |
|---|---|
| `.claude/hooks/block-secrets.sh` | Refuses any command line holding a private key or an inline password |
| `.claude/hooks/warn-broadcast.sh` | Says out loud when `--confirm` or `pons launch` is about to spend real money |
| `.claude/skills/verify/` | Runs the checks this project gates on, and explains what each failure means here |

## Testing

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The suite is **entirely offline**. Every test drives the real command surface against `test/fakeChain.ts`, a table of address + ABI + function → result that serves Multicall3 and `eth_getLogs` too, so what is exercised is the same decoding and aggregation the live path uses.

Two checks reach the network and are deliberately not part of `npm test`:

```sh
npm run test:sequence   # prove multi-block sequences against live mainnet state
npm run abi:check       # fail if a committed ABI has drifted from its verified source
```

### Sequences, without a local node

A simulation proves one call against one block. It cannot prove that an approval lands and the sell in the *next* block then succeeds, or that a launch confirms and the curve it created is buyable a block later. Those are the failures that reach a user.

Robinhood Chain answers `eth_simulateV1`, which runs several blocks of several calls with state carrying across all of them, against live mainnet state. `npm run test:sequence` uses it to prove six sequences, including the whole life of a launch: created, traded, taken past its graduation threshold, and seeded into a Uniswap V4 pool. No local node, no Foundry, nothing spent.

Every sequence carries a control that must fail. Without one, a state override could be doing the work that the sequence appears to prove.

### Spending real money on purpose

`scripts/mainnet-e2e.sh` launches a token, buys it, sells it and claims the fees against mainnet, for real. Sequences are covered for free by the check above, so what this adds is the one thing simulation cannot: a real transaction, signed by a real key, accepted by the real mempool, with a real receipt to decode. It is off unless you say so, asks before every transaction, and must never run in CI.

```sh
PONS_E2E=i-understand ./scripts/mainnet-e2e.sh
```

## Exit codes

Scripts and agents can branch on the outcome without parsing prose.

| Code | Meaning |
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

In `--json` mode a failure writes `{"ok": false, "error": {...}}` to **stderr**, never stdout, so a pipe carries only results.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md), and [`SECURITY.md`](SECURITY.md) for anything that should not be a public issue. The short version: run the four checks above, keep new behaviour in `src/core/`, and verify any claim about the protocol against mainnet before writing it down. The contract sources are stale in several places that matter.

## About

Written from scratch in TypeScript on [viem](https://viem.sh). No source is copied from any repository: the command surface is derived from a behavioural map of [`chainstacklabs/pumpfun-cli`](https://github.com/chainstacklabs/pumpfun-cli), and the RPC policy from measurements taken against this chain's own endpoints.

**Pons itself** is at [ponsfamily.com](https://www.ponsfamily.com/): the web client for launching and exploring, its [analytics](https://www.ponsfamily.com/analytics), and its [documentation](https://www.ponsfamily.com/docs). This CLI is not part of it, is not endorsed by it, and talks to the same public contracts anybody else can.

## License

MIT. See [LICENSE](LICENSE).
