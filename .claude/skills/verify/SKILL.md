---
name: verify
description: Run the checks this repo gates on (typecheck, lint, tests, build, ABI drift) and read the failures the way this project reads them. Use before committing, after changing anything under src/, or when a change touches an ABI or a protocol assumption.
---

# Verifying a change to ponscli

Four checks, in this order. Later ones are slower and depend on the earlier ones passing.

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Run them individually, not as one `&&` chain: when the second fails you want the
first's output still on screen.

## What each failure usually means here

**`typecheck`**: most often an ABI change. viem infers argument and return types
from the literal ABI, so adding a contract or regenerating one surfaces as a type
error at every call site that used the old shape. That is the check working.

**`lint`**: `no-unnecessary-type-assertion` fires a lot in this repo because the
generated ABIs are `as const` and already narrow. If you wrote `as Address` on
something coming out of `addresses.ts`, delete it.

**`npm test`**: the suite is offline. Every test drives the real command surface
through `test/fakeChain.ts`, a table of address + ABI + function → result. A test
that fails with `every free endpoint failed` is not a network problem: it means
the fixture is missing an answer for a call the code now makes. Add it to
`answers`, or to `succeed` if the call is a state-changing one whose arguments
the test cannot predict.

**`npm run build`**: rarely fails on its own. If it does after the others pass,
suspect a runtime-only import cycle.

## The ABI gate

```sh
npm run abi:check
```

Fails when a committed ABI no longer matches its verified source. **It is not
part of `npm test` on purpose**: it reaches the network, and Blockscout's API is
a token bucket that a full sweep drains. Run it when you have touched
`scripts/fetch-abis.mjs` or suspect a redeployment, not on every change.

## Before you claim something about the protocol

This project's standing rule is that protocol values come from the chain, not
from contract source or from this document. The source's defaults are stale in
several places that matter. If a change rests on a claim about how Pons behaves,
verify it against mainnet state before writing it down:

```sh
npm run dev -- info <token> --human
npm run dev -- buy <token> 0.01 --from <address> --dry-run --human
```

`--dry-run` simulates against live state with a balance override, so it proves
the call works without holding any funds. Where a claim needs more than that,
`docs/architecture/ponscli.md` records how every existing measurement was taken.
