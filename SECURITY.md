# Security

`ponscli` encrypts private keys, signs transactions, and spends real money on a
public chain. A defect here can cost somebody funds, so please report privately
first.

## Reporting

Use **[GitHub's private vulnerability reporting](https://github.com/mesutgulecen/ponscli/security/advisories/new)**
on this repository. It opens a private thread with the maintainer; nothing is
public until an advisory is published.

Please do not open a public issue for anything that could cost somebody funds,
and please do not include a private key, a keystore file, a seed phrase, a
password, or a paid RPC URL in the report — a paid endpoint carries its
credential in the URL.

What helps: the version, the command, what you expected, and the smallest thing
that reproduces it. A proof of concept against a throwaway key is worth more
than a description, and `--dry-run` proves a call works without holding funds.

Expect a first response within a week. If a report is confirmed, a fix and an
advisory follow; you will be credited unless you would rather not be.

## Supported versions

The latest published version only. This is a young project on a moving protocol
and there are no backports.

## What is in scope

Anything that could lose funds or leak a key:

- A key, password, or paid credential reaching a log line, an error message,
  stdout, or the process table
- A keystore that can be decrypted without its password, or a weakness in the
  scrypt and AES-256-GCM handling
- A signed transaction that does not match the plan the user approved — a
  different recipient, a larger value, a lower slippage floor
- A path by which the MCP server signs, broadcasts, or reads a keystore
- A revert, quote, or balance reported as something it is not, where acting on
  the wrong answer costs money
- Dependency or supply-chain issues that reach a user's machine

## What is not

- **The Pons protocol itself.** This is an unofficial third-party client. The
  contracts belong to [Pons](https://www.ponsfamily.com/); please report
  contract issues to them, not here.
- **Public RPC endpoints**, their rate limits, and their operators.
- **Losses from ordinary use** — slippage, price impact, a launch that did not
  trade, or a `--confirm` somebody meant to type. The CLI shows the plan, the
  simulation, and the warnings before it signs; acting on them is the user's.
- **A key on a compromised machine.** The keystore is encrypted at rest and
  written owner-only, but nothing here defends against a reader who is already
  root.

## What the design guarantees

These are the boundaries the code is built around, and a way past any of them is
a vulnerability rather than a feature request:

- **Read-only by default.** No command signs without `--confirm`. Three of the
  four execution modes cannot spend.
- **No key in argv.** There is no flag that takes a private key or a password —
  argv is visible in the process table and lands in shell history.
  `PONS_PRIVATE_KEY` for import, `PONS_PASSWORD` or a hidden prompt for
  unlocking.
- **The MCP server never signs.** It reads the chain and returns unsigned
  calldata. It loads no keystore and has no tool that broadcasts. A model can be
  steered by a prompt; the worst it should be able to do here is quote a bad
  price.
- **Credentials are masked in errors, not just in output.** A paid endpoint's
  key lives in the URL, and HTTP clients put the URL inside transport error
  messages.
- **Broadcast happens once.** A transaction is signed before it is sent, so an
  ambiguous failure is reported with its hash rather than retried into a second
  transaction spending the same funds.
