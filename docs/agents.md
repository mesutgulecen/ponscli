# Using ponscli from an agent

This CLI was built for agents from the start rather than retrofitted. There are
two ways in — the binary and an MCP server — and one rule that governs both:
**nothing signs without a human saying so.**

- [Which interface to use](#which-interface-to-use)
- [MCP](#mcp)
- [The CLI as a tool](#the-cli-as-a-tool)
- [Amounts](#amounts)
- [Errors](#errors)
- [The four execution modes](#the-four-execution-modes)
- [What an agent should not do](#what-an-agent-should-not-do)
- [Working on this repository](#working-on-this-repository)

---

## Which interface to use

| | `pons-mcp` | `pons` as a shell tool |
|---|---|---|
| Reading the chain | yes | yes |
| Building unsigned transactions | yes | yes |
| **Signing and broadcasting** | **never** | with `--confirm` |
| Wallet management | no | yes |
| Launching a token | no | yes |
| Setup | one config entry | a shell, and a keystore for writes |

Use MCP when the agent should look and plan. Use the CLI when a human is present
to approve spending, or when you need the wallet and launch surface.

---

## MCP

```jsonc
// claude_desktop_config.json, .mcp.json, or your client's equivalent
{
  "mcpServers": {
    "pons": { "command": "pons-mcp" }
  }
}
```

From a clone, `npm run mcp`. The server speaks stdio.

### Tools

| tool | arguments | returns |
|---|---|---|
| `pons_info` | `token` | Launch state. `generation` says `v1` or `v2`; the two shapes differ. |
| `pons_pairs` | — | Approved quote assets, in approval order. |
| `pons_plan_buy` | `token`, `amount`, `account`, `slippageBps?` | Unsigned calldata, a simulation, and any approval needed first. |
| `pons_plan_sell` | `token`, `amount`, `account`, `slippageBps?` | The same, for a sell. `amount` accepts `all` and `50%`. |
| `pons_transaction` | `hash` | Receipt, decoded logs, and the revert reason. |
| `pons_endpoints` | — | RPC endpoint health, probed with real calls. |

Every tool carries `readOnlyHint`.

### The server cannot sign

It never loads a keystore, never prompts for a password, and never broadcasts.
There is no flag that changes this and no tool that bypasses it.

This is not a limitation worked around — it is the boundary that makes the server
safe to leave running. A CLI is driven by somebody who typed the command; an MCP
server is driven by a model that a prompt can steer. The worst a confused agent
should be able to do here is quote a bad price.

Two consequences:

- **`pons_plan_*` returns calldata, not a transaction.** Hand it to a person, or
  have them run the equivalent `pons buy … --confirm`.
- **An approval is reported, not encoded.** When a sell needs one, the result
  names the spender and the amount and stops there. Handing a model a second
  piece of signable calldata for a step it did not ask about is how an approval
  ends up sent on its own, to a spender nobody re-read.

### A plan result

```json
{
  "plan": {
    "id": "0xeddf1990…",
    "kind": "buy",
    "route": "curve",
    "to": "0x60CeF8379Aa278F087074bC60595778985c1bD8E",
    "data": "0x…",
    "value": "50000000000000000",
    "summary": "buy 3,012,449 PROBE for 0.05 ETH",
    "warnings": [
      { "code": "snipe-tax", "severity": "danger", "message": "the snipe tax is 99% of…" }
    ],
    "economics": { "amountIn": "50000000000000000", "tokensOut": "3012449…" }
  },
  "prerequisites": [],
  "simulation": {
    "ok": true,
    "gasEstimate": "177878",
    "blockedByPrerequisite": false,
    "revert": null
  },
  "signing": "this server never signs; send it with `pons buy/sell --confirm`…"
}
```

`warnings[].code` is stable and meant to be branched on. `severity` is `info`,
`warn` or `danger`; a `danger` warning is the CLI's own refusal threshold and
should be surfaced to the user rather than summarised away.

`simulation.blockedByPrerequisite` distinguishes "this will fail" from "this
fails only until the approval above lands". Do not report the second as a broken
trade.

---

## The CLI as a tool

`--json` is the default whenever stdout is not a terminal, so an agent shelling
out gets structured output without asking. Results go to **stdout**, everything
else to **stderr**, and each invocation writes exactly one payload.

```sh
pons info 0x44D6…20f4                     # one JSON object on stdout
pons buy 0x44D6…20f4 0.05 --unsigned      # calldata for somebody else to sign
pons buy 0x44D6…20f4 0.05 --dry-run       # built and simulated, explicitly
```

Branch on the [exit code](commands.md#exit-codes), not on prose.

---

## Amounts

**Every number in JSON output is in base units, as a string.** A model can do
exact arithmetic on `50000000000000000` and cannot on `0.05`. Apply the
`decimals` the same payload reports before showing anything to a person.

Amounts *accepted* as input are human-scaled — `0.05`, `50%`, `all` — because
that is what a person says. The asymmetry is deliberate.

Two traps worth knowing:

- **USDG is 6-decimal.** Every other approved quote asset is 18. A wei-scaled
  amount applied to it is wrong by twelve orders of magnitude.
- **A graduated V2 token reports `price: null`, not `0`.** The curve is drained;
  it no longer prices the token. Treating `null` as zero produces a market cap of
  nothing for a token that trades fine.

---

## Errors

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

`code` is stable. An argument mistake carries the failing command's usage line,
so a caller can correct itself without spending a second invocation on `--help`.

A revert comes back translated rather than as four bytes:

```json
{
  "revert": {
    "selector": "0x13be252b",
    "name": "InsufficientAllowance",
    "message": "the spender is not approved to move that many tokens",
    "hint": "this is the quote asset refusing, not Pons — the approval above has to land first"
  }
}
```

The selector-to-name map is derived from the committed ABIs, so it cannot fall
behind a redeployment. An unknown selector is reported as unknown; no explanation
is invented.

---

## The four execution modes

Every write builds a **Plan** first — what it will send, to whom, what it expects
back, what is worth warning about — and the same Plan is what gets simulated and
what gets signed, so the three cannot drift apart.

| mode | what happens |
|---|---|
| *(no flag)* | Build the plan, simulate it against live state with a balance override, and print both. Nothing is signed or sent. |
| `--dry-run` | The same work, asked for explicitly: `"mode": "dry-run"` in the payload, and no reminder that nothing was sent. |
| `--unsigned` | Emit calldata and value for somebody else to sign. The only mode that does not simulate. |
| `--confirm` | Sign and broadcast. |

The simulation is what an agent should read: it proves the call works against
the contracts actually deployed, without the account holding any funds. It comes
back on the default path too, so an agent that only wants to look does not need
a flag to get it.

---

## What an agent should not do

- **Do not run `--confirm` on a user's behalf without asking.** It spends real
  money and cannot be undone.
- **Do not run `pons launch` speculatively.** It is irreversible, costs the
  launch fee, and freezes the creator tax, the quote asset and the exemption list
  for the life of the token.
- **Never put a private key or a password on a command line.** argv is in the
  process table and in shell history. `PONS_PRIVATE_KEY` for import,
  `PONS_PASSWORD` or the hidden prompt for unlocking. There is no flag that takes
  either, and a hook in this repository refuses command lines that carry one.
- **Do not paper over a `danger` warning.** The snipe tax at 99%, a dev buy
  taking most of the supply, an unlimited approval — these are surfaced because a
  person should decide.
- **Do not treat `blockedByPrerequisite` as a failure.**

---

## Working on this repository

`CLAUDE.md` is the project brief, with `AGENTS.md` symlinked to it for Codex,
Cursor, Copilot and others. `.claude/` carries:

| | |
|---|---|
| `hooks/block-secrets.sh` | Refuses a Bash command line holding a private key or an inline password. Blocks the call. |
| `hooks/warn-broadcast.sh` | Says out loud when `--confirm` or `pons launch` is about to spend. Advisory. |
| `skills/verify/` | Runs the checks this repo gates on, and explains what each failure usually means here. |

Two things to know before changing anything:

**Protocol values come from the chain, not from contract source.** The deployed
values differ in ways that change results — `snipeTaxSeconds` is 3 where the
source says 15, the V3 factory is not at its canonical address, the approved
quote-asset list has both grown and shrunk. Every claim in
[`docs/architecture/ponscli.md`](architecture/ponscli.md) records how it was
measured; if a measurement contradicts that document, the document is what is
wrong.

**New behaviour belongs in `src/core/`.** Both front ends are thin shells over
it. Copying logic from a command into an MCP tool means it was in the wrong
place.

The test suite is offline. A test failing with `every free endpoint failed` means
the fixture in `test/fakeChain.ts` is missing an answer for a call the code now
makes — not that the network is down.
