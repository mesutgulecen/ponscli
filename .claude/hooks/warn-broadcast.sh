#!/usr/bin/env sh
# Say out loud when a command is about to spend real money.
#
# `--confirm` is the one flag in this CLI that signs and broadcasts. It is not
# blocked, since the whole point of the flag is that somebody meant it, but an
# agent running it should be reminded that the four modes exist and that three
# of them cost nothing.
#
# Exit 0 with output on stderr: advisory, not a refusal.
set -eu

input=$(cat)
command=$(printf '%s' "$input" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try { process.stdout.write(JSON.parse(d).tool_input?.command ?? '') } catch { process.stdout.write('') }
})")

case "$command" in
  *pons*--confirm*|*--confirm*pons*)
    printf 'Note: --confirm signs and broadcasts a real transaction on Robinhood Chain.\n' >&2
    printf 'Nothing else in this CLI does. If you only wanted to see or check it:\n' >&2
    printf '  (no flag)   build the plan, simulate it, print it\n' >&2
    printf '  --dry-run   the same, said explicitly\n' >&2
    printf '  --unsigned  emit calldata for somebody else to sign\n' >&2
    ;;
  *pons\ launch*)
    printf 'Note: a launch cannot be undone. It spends the launch fee and freezes the\n' >&2
    printf 'creator tax, the quote asset and the exemption list for the life of the token.\n' >&2
    ;;
esac

exit 0
