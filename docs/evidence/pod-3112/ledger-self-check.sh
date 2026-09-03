#!/usr/bin/env bash
set -euo pipefail

validate_epic_ledger() {
  local ledger="$1" bad
  bad="$(awk -F '	' '!/^#/ && NF>0 && NF!=8 {print NR ": NF=" NF ": " $0}' "$ledger")"
  [ -z "$bad" ] || { printf '%s\n' "$bad" >&2; return 1; }
  if grep -nF '\t' "$ledger" >/dev/null; then
    echo "literal backslash-t sequence found in $ledger" >&2
    grep -nF '\t' "$ledger" >&2
    return 1
  fi
}

if [ "${1:-}" = "--self-check" ]; then
  dir="$(mktemp -d)"
  trap 'rm -rf "$dir"' EXIT
  printf 'one\ttwo\tthree\tfour\tfive\tsix\tseven\teight\n' > "$dir/good.tsv"
  printf '%s\n' 'one\ttwo\tthree\tfour\tfive\tsix\tseven\teight' > "$dir/bad.tsv"
  validate_epic_ledger "$dir/good.tsv"
  if validate_epic_ledger "$dir/bad.tsv" 2>/dev/null; then
    echo "negative literal-backslash-t fixture was accepted" >&2
    exit 1
  fi
  echo "PASS valid eight-field TAB row accepted"
  echo "PASS literal-backslash-t row rejected"
  exit 0
fi

validate_epic_ledger "${1:-docs/plans/pod-1761-results.tsv}"
echo "PASS every populated non-comment row is NF==8 and contains no literal backslash-t"
