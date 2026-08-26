#!/usr/bin/env bash
#
# End-to-end against Robinhood Chain mainnet, with real money.
#
# Everything else in this repository is free to run: the test suite is offline,
# and `--dry-run` simulates against live state with a balance override, so it
# proves a call works without holding funds. This script is the one thing that
# does not: it launches a token, buys it, sells it and claims the fees, and
# each of those is a real transaction that really spends ETH.
#
# It exists because there is a gap only spending can close. A simulation proves
# one call against one block; it cannot prove a *sequence*, meaning that an approval
# lands and the sell in the next block then succeeds, that a launch confirms and
# the curve it created is buyable, that a receipt decodes the way the decoder
# says it will. Those are the failures that reach a user, and this is what
# catches them before a release does.
#
# It is off by default and asks before every transaction. Nothing here is
# automatic, and it must never run in CI.
#
# Usage:
#   PONS_E2E=i-understand ./scripts/mainnet-e2e.sh
#
# Requires a funded keystore. Roughly 0.002 ETH plus gas for the whole run.

set -euo pipefail

PONS="${PONS:-npm run --silent dev --}"
SYMBOL="${SYMBOL:-E2E$(date +%H%M)}"
NAME="${NAME:-ponscli end to end}"
BUY="${BUY:-0.002}"

if [ "${PONS_E2E:-}" != "i-understand" ]; then
  cat >&2 <<'MSG'
This script spends real ETH on Robinhood Chain mainnet.

It launches a token, buys it, sells it and claims the fees. None of that can be
undone, and the launch fee is not refundable. Roughly 0.002 ETH plus gas.

If that is what you want:

  PONS_E2E=i-understand ./scripts/mainnet-e2e.sh

If you wanted to check the code instead, everything below is free:

  npm test                              the offline suite
  pons buy <token> 0.01 --dry-run       simulated against live state
  pons launch --name X --symbol Y       the plan, unsent
MSG
  exit 1
fi

step() {
  printf '\n\033[1m== %s\033[0m\n' "$1"
}

# Ask before each transaction rather than once at the start. A run that is
# abandoned halfway should stop at the next prompt, not have already spent.
confirm() {
  printf '\n%s\n' "$1"
  printf 'Send it? [y/N] '
  read -r reply
  case "$reply" in
    y | Y) return 0 ;;
    *)
      printf 'Stopped.\n' >&2
      exit 1
      ;;
  esac
}

step "Preflight"
$PONS doctor --human
$PONS wallet balance --human

step "1. Launch $SYMBOL"
# Printed first without --confirm: the plan a person approves below is the plan
# that gets sent, because both come from the same builder.
$PONS launch --name "$NAME" --symbol "$SYMBOL" --desc "ponscli end-to-end run" --dry-run --human
confirm "About to launch $SYMBOL. This spends the launch fee and cannot be undone."
LAUNCH_JSON=$($PONS launch --name "$NAME" --symbol "$SYMBOL" --desc "ponscli end-to-end run" --confirm --json)
printf '%s\n' "$LAUNCH_JSON"

TOKEN=$(printf '%s' "$LAUNCH_JSON" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const p = JSON.parse(d)
  process.stdout.write(p.plan?.economics?.token ?? '')
})")
if [ -z "$TOKEN" ]; then
  printf 'Could not read the launched token address out of the result.\n' >&2
  exit 1
fi
printf '\nLaunched %s\n' "$TOKEN"

step "2. Read it back"
# The address was predicted before the launch was sent. If the launch landed
# somewhere else, CREATE2 prediction is broken and everything after it is too.
$PONS info "$TOKEN" --human

step "3. Buy $BUY ETH of it"
$PONS buy "$TOKEN" "$BUY" --dry-run --human
confirm "About to buy $BUY ETH of $SYMBOL."
$PONS buy "$TOKEN" "$BUY" --confirm --human

step "4. Sell half of it"
# The interesting half of the run: a sell needs an approval to land first, and
# a simulation cannot prove that the second transaction succeeds after the
# first one confirms.
$PONS sell "$TOKEN" 50% --dry-run --human
confirm "About to sell half the $SYMBOL position. This sends an approval, then the sell."
$PONS sell "$TOKEN" 50% --confirm --human

step "5. Claim the creator fees"
$PONS claim --human || printf '(nothing owed yet; fees are swept on a schedule, not per trade)\n'

step "6. Follow what happened"
$PONS watch "$TOKEN" --since 500 --once --human

printf '\n\033[1mDone.\033[0m %s\n' "$TOKEN"
printf 'Sell the rest with: pons sell %s all --confirm\n' "$TOKEN"
