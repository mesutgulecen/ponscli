## What this changes

<!-- One paragraph. What behaviour is different afterwards. -->

## Why

<!-- If this rests on a claim about how Pons behaves, say how you verified it
     against mainnet. `docs/architecture/ponscli.md` records the measurement
     behind every existing claim; if yours contradicts it, correct that
     document in the same change and say so. -->

## Checks

```
npm run typecheck
npm run lint
npm test
npm run build
```

- [ ] All four pass
- [ ] New behaviour lives in `src/core/`, where both front ends reach it
- [ ] `npm run test:sequence`, only if this changes anything a transaction
      depends on **in order**: an approval before a trade, a launch before the
      buy that follows it, a graduation phase
- [ ] `npm run abi:check`, only if this touches `scripts/fetch-abis.mjs` or a
      redeployment is suspected

## Anything irreversible?

<!-- Delete if not. `pons launch`, `--confirm` and the keystore are the three
     places a mistake costs somebody money or a key. Say which one this touches
     and what stops it going wrong. -->
