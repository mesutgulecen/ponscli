# Contributing

Thanks for looking. This is an unofficial third-party client for a protocol that
handles money, so the bar is a little different from a typical CLI: the code has
to be right about somebody else's contracts, and it has to stay right as those
contracts are redeployed and retuned.

## Getting set up

```sh
npm install
npm run dev -- info 0x…      # run the CLI from source
npm run mcp                  # run the MCP server from source
```

Node **20.19 or newer** to develop, which is higher than the 20.11 the package
itself declares: eslint's dependency tree requires it. CI holds the published
artefact to the lower floor separately, by installing the tarball on 20.11 and
running both binaries.

## Before you open a pull request

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Run them separately rather than as one `&&` chain. When the second fails you
want the first's output still on screen. If you use Claude Code, the `verify`
skill does this and explains what each failure usually means here.

Two checks reach the network and are deliberately **not** part of the suite:

```sh
npm run test:sequence   # multi-block sequences against live mainnet state
npm run abi:check       # ABI drift against the verified sources
```

Run `test:sequence` when you have changed anything a transaction depends on in
order: an approval, a launch and the trade that follows it, a graduation
phase. It uses `eth_simulateV1` to run several blocks of several calls with
state carrying across them, so it catches what a single `--dry-run` cannot.
Every sequence in it has a control that must fail; if you add one, add its
control too, and assert on returned output rather than on status, because a call
to an address with no code succeeds and returns nothing.

Run `abi:check` when you have touched `scripts/fetch-abis.mjs` or suspect a
redeployment. Blockscout's public API is a token bucket that a full sweep
drains.

## The one rule that matters most

**Protocol values come from the chain, not from contract source and not from the
documentation.** The deployed values differ in ways that change results:
`snipeTaxSeconds` is 3 where the source says 15, Robinhood's Uniswap V3 factory
is not at the canonical address, and the approved quote-asset list has both grown
and shrunk.

If a change rests on a claim about how Pons behaves, verify it against mainnet
before writing it down:

```sh
npm run dev -- info <token> --human
npm run dev -- buy <token> 0.01 --from <address> --dry-run --human
```

`--dry-run` simulates against live state with a balance override, so it proves a
call works without holding any funds. That is how most of the claims in
[`docs/architecture/ponscli.md`](docs/architecture/ponscli.md) were established,
and each one records the measurement behind it. **If your measurement
contradicts that document, the document is what is wrong**. Correct it in place
and say so in the commit. Several sections already exist only because an earlier
reading turned out to be wrong; that is the intended lifecycle, not an
embarrassment.

## Where code goes

| | |
|---|---|
| `src/core/` | Business logic. Framework-free: no commander, no reporter, no argv. |
| `src/commands/` | Thin CLI wiring over `core/`. |
| `src/mcp/` | The MCP server, also thin, over the same `core/`. |
| `src/chain/` | The RPC waterfall, endpoint health, transports. |
| `src/abi/` | Generated and committed. Do not edit by hand. |

New behaviour belongs in `core/`, where both front ends can reach it. If you find
yourself copying logic from a command into an MCP tool, that logic was in the
wrong place.

## Tests

The suite is offline and drives the real command surface. `test/fakeChain.ts`
answers from a table of address + ABI + function → result, and serves Multicall3
and `eth_getLogs` too, so what is exercised is the same decoding and aggregation
the live path uses.

A test failing with `every free endpoint failed` means the fixture is missing an
answer for a call the code now makes, not that the network is down. Add it to
`answers`, or to `succeed` when the call is state-changing and its arguments are
not something a test can predict.

Fixtures are real launches read off the chain, with the date recorded in a
comment. Please keep that habit: a fixture nobody can trace back to a block is a
fixture nobody can re-derive.

## Style

Match the surrounding code. A few things that are load-bearing rather than
preference:

- **Comments say why, not what.** The interesting comments in this repository are
  the ones recording a measurement or a trap: a fixed gas limit that exists
  because Nitro charges L1 posting cost out of it, a two-call multicall that
  exists because the router does not unwrap on the way out. Keep writing those.
- **`as const` on ABIs is load-bearing.** viem infers argument and return types
  from the literal; widening to `Abi` throws that away.
- **One payload per invocation.** Commands emit exactly one result on stdout;
  anything conversational goes to stderr through `reporter.note` or
  `reporter.warn`.
- **Nothing in `pons-mcp` may `console.log`.** stdout is the JSON-RPC channel.

## Commit messages

One line, imperative, short. No trailing period, no bullet lists, no co-author or
tool attribution.

```
Add V1 adapter with generation detection and V3 route
Route subcommand argument errors through the error taxonomy
```

## Security

Two hard rules:

- **A private key or password never reaches argv.** It is visible in the process
  table and lands in shell history. `PONS_PRIVATE_KEY` for import,
  `PONS_PASSWORD` or a hidden prompt for unlocking. No flag takes either, and a
  hook in `.claude/` refuses command lines that carry one.
- **The MCP server does not sign.** No tool may be added that signs, broadcasts,
  or reads a keystore. A test asserts it.

If you find a vulnerability, please report it privately rather than opening a
public issue. [`SECURITY.md`](SECURITY.md) has the how, and what counts.
