# ponscli

A TypeScript + viem CLI for the **Pons** launchpad on **Robinhood Chain** (4663).
Two binaries: `pons` for people, `pons-mcp` for models.

## The rule that matters most

**Protocol values come from the chain, not from contract source and not from this
file.** The deployed values differ from the sources in ways that change results:
`snipeTaxSeconds` is 3 where the source says 15, the V3 factory is not at its
canonical address, and the approved quote-asset list has both grown and shrunk.
Anything you assert about how Pons behaves should be something you read off
mainnet, and `docs/architecture/ponscli.md` records how every existing claim was
measured. If a measurement contradicts that document, the document is what is
wrong — correct it in place and say so.

## Layout

| | |
|---|---|
| `src/core/` | Business logic. Framework-free: no commander, no reporter, no argv. |
| `src/commands/` | Thin CLI wiring over `core/`. |
| `src/mcp/` | The MCP server, also thin, over the same `core/`. |
| `src/chain/` | The two-tier RPC waterfall, endpoint health, transports. |
| `src/abi/` | Generated and committed. Do not edit by hand. |
| `docs/architecture/ponscli.md` | Every decision, and the measurement behind it. |

New behaviour belongs in `core/`, where both front ends can reach it. If you find
yourself copying logic from a command into an MCP tool, that logic was in the
wrong place.

## Verifying a change

Use the `verify` skill, or run `npm run typecheck`, `npm run lint`, `npm test`,
`npm run build`. `npm run abi:check` reaches the network and is deliberately not
part of the test suite.

## Things that will bite

- **`--json` is the default when stdout is not a TTY.** A command emits exactly
  one payload per invocation; anything conversational goes to stderr through
  `reporter.note` or `reporter.warn`.
- **`pons-mcp` writes JSON-RPC on stdout.** Nothing in that process may
  `console.log`. One stray line desynchronises the client's parser.
- **The MCP server never signs**, and nothing should be added that does. It reads
  and it builds unsigned plans; a person sends them.
- **Never put a private key or a password on a command line.** argv is in the
  process table and in shell history. `PONS_PRIVATE_KEY` for import,
  `PONS_PASSWORD` or the hidden prompt for unlocking. A hook enforces this.
- **`--confirm` spends real money.** The other three modes — plan, `--dry-run`,
  `--unsigned` — cost nothing. Every mode but `--unsigned` simulates against live
  state with a balance override, so the default already proves a call works
  without funds; `--dry-run` asks for the same thing explicitly.
- **A launch cannot be undone.** `pons launch` is the one irreversible command.

## Tests

Offline, and they drive the real command surface. `test/fakeChain.ts` answers
from a table of address + ABI + function → result, serving Multicall3 and
`eth_getLogs` too. A test failing with `every free endpoint failed` means the
fixture is missing an answer for a call the code now makes, not that the network
is down.

## Commit messages

One line, imperative, short. No trailing period, no bullet lists, no
co-author or tool attribution.
