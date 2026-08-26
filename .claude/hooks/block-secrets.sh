#!/usr/bin/env sh
# Refuse to let a private key or a keystore password reach a command line.
#
# argv is visible in the process table and lands in shell history, so a key
# passed as an argument is disclosed to every other user on the machine and
# then written to disk. The CLI has no flag that takes one for exactly this
# reason: `pons wallet import` reads PONS_PRIVATE_KEY, and unlocking reads a
# hidden prompt or PONS_PASSWORD, so any command line carrying one is a
# mistake rather than a shortcut.
#
# Exit 2 blocks the tool call and shows this message to the model.
set -eu

input=$(cat)
command=$(printf '%s' "$input" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try { process.stdout.write(JSON.parse(d).tool_input?.command ?? '') } catch { process.stdout.write('') }
})")

[ -z "$command" ] && exit 0

# A 32-byte hex key, with or without the 0x. Matched anywhere on the line:
# `--private-key`, an echo into a file, and a bare paste all look the same here.
if printf '%s' "$command" | grep -Eq '(^|[^0-9a-fA-Fx])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)'; then
  # A transaction hash is the same shape and is not a secret, so only refuse
  # when the line looks like it is handling a key rather than reading a chain.
  if printf '%s' "$command" | grep -Eqi 'private[-_ ]?key|PONS_PRIVATE_KEY|mnemonic|seed[-_ ]?phrase|keystore'; then
    printf 'Blocked: this command line appears to carry a private key.\n' >&2
    printf 'argv is in the process table and in shell history. Use PONS_PRIVATE_KEY\n' >&2
    printf 'for import and PONS_PASSWORD (or the hidden prompt) for unlocking.\n' >&2
    exit 2
  fi
fi

if printf '%s' "$command" | grep -Eq 'PONS_PASSWORD=[^ ]|PONS_PRIVATE_KEY=[^ ]'; then
  printf 'Blocked: a secret was assigned inline on the command line.\n' >&2
  printf 'Export it in the shell instead, so it does not land in history.\n' >&2
  exit 2
fi

exit 0
