#!/usr/bin/env bash
# The round-3 defeat battery, end to end through the real test.
#
#   bash docs/evidence/pod-2753/defeat-battery.sh
#
# Derived by an independent reviewer BEFORE the fix was written — thirteen ways to
# get a module into the daemon's heap past an import-graph walk. It injects each
# shape at module scope into headless-drivers.ts, runs claude-sdk-isolation.test.ts,
# reverts, and reports by name. Refuses a dirty tree and re-checks at the end.
#
# The shapes also live as a TABLE in claude-sdk-isolation.test.ts, which is what
# runs in CI. This script exists because the table asserts against the scanners
# directly, while this drives the whole test against a really-modified file — two
# different things to be wrong about.
#
# It carries its own vacuity control: S0/S0b/S0c are shapes the guard has always
# caught, and if they ever stop going RED the harness is broken and every result
# below it is worthless.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export PATH="$HOME/.bun/bin:$PATH"
TARGET=apps/daemon/src/headless-drivers.ts
SIBLING=apps/daemon/src/battery-sibling.ts
RAN=""
BROKEN=0

# SELF-HEAL FIRST, BEFORE THE DIRTY-TREE CHECK. A trap cannot catch SIGKILL, and
# an OOM kill is exactly how this script died on a loaded host — leaving an SDK
# import sitting in headless-drivers.ts twice. The sentinel below is the only
# protection that survives being killed uncatchably: it is written before the
# first mutation and removed after the last restore, so its presence at startup
# means a previous run did not finish, and the pristine copy beside it is what the
# file should be. Sequenced ahead of the dirty-tree refusal deliberately — that
# refusal cannot tell this script's own leftover from somebody's work in progress.
# Repairs from GIT, not from a copy in /tmp. The target is a committed file, so
# git is the authority on what it should be; a backup beside the sentinel is one
# more thing that can be stale or missing when it is needed most.
MARK=/tmp/battery-in-progress
if [ -f "$MARK" ]; then
  if ! git diff --quiet -- "$TARGET" 2>/dev/null; then
    echo "REPAIRING: a previous run was killed before it could restore $TARGET"
    git checkout -- "$TARGET"
  fi
  rm -f "$MARK" "$SIBLING"
fi

# MEMORY IS THE CEILING ON THIS HOST, not load. Fourteen vitest starts on a box
# that is already short will produce a run that reports nothing useful — see the
# ERROR branch below for what that looked like the first time.
AVAIL=$(free -m | awk '/^Mem:/{print $7}')
if [ "$AVAIL" -lt 1500 ]; then
  echo "REFUSING: ${AVAIL}MB available, need 1500MB — this run would report noise"
  exit 1
fi

[ -z "$(git status --porcelain)" ] || { echo "REFUSING: tree is dirty"; exit 1; }
cp "$TARGET" /tmp/battery-target.bak
: > "$MARK"

# Restore on any exit we CAN catch. This is not hypothetical either: a run killed
# by a timeout left the A0b mutation behind before this existed. A mutation
# harness that only restores on the happy path will eventually hand somebody a
# mutated tree and let them commit it — these shapes are chosen for being
# invisible, so nobody would notice.
restore() {
  cp /tmp/battery-target.bak "$TARGET" 2>/dev/null || true
  rm -f "$SIBLING" "$MARK" /tmp/battery-inject.ts /tmp/battery-out.ts 2>/dev/null || true
}
trap restore EXIT INT TERM

SDK='@anthropic-ai/claude-agent-sdk'


shape() { # id, description, code, [sibling-module-source]
  local id="$1" desc="$2" code="$3" sib="${4:-}"
  RAN="$RAN $id"
  [ -n "$sib" ] && printf '%s\n' "$sib" > "$SIBLING"
  printf '%s\n' "$code" > /tmp/battery-inject.ts
  cat /tmp/battery-inject.ts "$TARGET" > /tmp/battery-out.ts && mv /tmp/battery-out.ts "$TARGET"
  if diff -q "$TARGET" /tmp/battery-target.bak >/dev/null; then
    echo "  $id  !! MUTATION NOT APPLIED"; cp /tmp/battery-target.bak "$TARGET"; rm -f "$SIBLING"; return
  fi
  local out; out=$(timeout 200 ./node_modules/.bin/vitest run apps/daemon/src/claude-sdk-isolation.test.ts 2>&1)
  # DID IT RUN AT ALL? This mattered on the first attempt at the 14-shape run:
  # the host was low on memory, vitest died before producing a summary, and the
  # old check — "no 'Tests N failed' line, therefore no failures" — reported every
  # shape as GREEN (DEFEAT). The harness could not tell "ran and the guard lost"
  # from "never ran", which is the same defect as everything else on this page.
  # The vacuity controls DID catch it (S0/S0b/S0c came back green, which is
  # impossible when the harness is working) — but a harness should say it is
  # broken, not leave that to a reader who knows what the controls mean.
  if ! echo "$out" | grep -qE "^ +Tests +[0-9]+"; then
    printf '  %-4s %-13s %s\n' "$id" "ERROR (no run)" "$desc — vitest produced no summary"
    echo "$out" | tail -5 | sed 's/^/        /'
    BROKEN=1
    cp /tmp/battery-target.bak "$TARGET"; rm -f "$SIBLING"; return
  fi
  if echo "$out" | grep -qE "^ +Tests +[0-9]+ failed"; then r="RED  (caught)"; else r="GREEN (DEFEAT)"; fi
  printf '  %-4s %-13s %s\n' "$id" "$r" "$desc"
  cp /tmp/battery-target.bak "$TARGET"; rm -f "$SIBLING"
}

echo "=== controls: shapes the guard must already catch ==="
shape S0  "quoted static import"          "import { query } from '$SDK'
void query"
shape S0b "quoted await import()"         "const m0b = await import('$SDK')
void m0b"
shape S0c "quoted require()"              "import { createRequire as cr0c } from 'node:module'
const m0c = cr0c(import.meta.url)('$SDK')
void m0c"

echo "=== defeats the reviewer derived ==="
shape A0  "template-literal import"       "const mA0 = await import(\`$SDK\`)
void mA0"
shape A0b "template-literal requirer"     "import { createRequire as crA0b } from 'node:module'
const reqA0b = crA0b(import.meta.url)
const mA0b = reqA0b(\`$SDK\`)
void mA0b"
shape A1  "direct createRequire call"     "import { createRequire as crA1 } from 'node:module'
const mA1 = crA1(import.meta.url)('$SDK')
void mA1"
shape A2  "house idiom (const req = ...)" "import { createRequire as crA2 } from 'node:module'
const reqA2 = crA2(import.meta.url)
const mA2 = reqA2('$SDK')
void mA2"
shape A3  "alias of the requirer"         "import { createRequire as crA3 } from 'node:module'
const reqA3 = crA3(import.meta.url)
const rA3 = reqA3
const mA3 = rA3('$SDK')
void mA3"
shape A4  "requirer on a property"        "import { createRequire as crA4 } from 'node:module'
const ioA4 = { req: crA4(import.meta.url) }
const mA4 = ioA4.req('$SDK')
void mA4"
shape A5  "resolve then import"           "import { createRequire as crA5 } from 'node:module'
const reqA5 = crA5(import.meta.url)
const mA5 = await import(reqA5.resolve('$SDK'))
void mA5"
shape A6  "concatenated specifier"        "import { createRequire as crA6 } from 'node:module'
const reqA6 = crA6(import.meta.url)
const mA6 = reqA6('@anthropic-ai/' + 'claude-agent-sdk')
void mA6"
shape A2b "house idiom, import alias"   "import { createRequire as crA2b } from 'node:module'
const reqA2b = crA2b(import.meta.url)
const mA2b = reqA2b('$SDK')
void mA2b"
shape A7  "requirer exported across modules" "import { reqA7 } from './battery-sibling.js'
const mA7 = reqA7('$SDK')
void mA7" "import { createRequire } from 'node:module'
export const reqA7 = createRequire(import.meta.url)"
shape A8  "rebound builtin require"       "import { createRequire as crA8 } from 'node:module'
const loadA8 = crA8(import.meta.url)
const gA8 = loadA8
const mA8 = gA8('$SDK')
void mA8"

cp /tmp/battery-target.bak "$TARGET"; rm -f "$SIBLING"

# RECONCILIATION, and it is the most important thing in this file.
# This script used to run twelve shapes and READ as the whole battery: A7 and A2b
# were simply absent from the output, not marked skipped, and a reader counted the
# lines and got a number that was not the coverage. A harness that silently covers
# less than it appears to is the exact defect the guard it is testing exists to
# prevent — so the two lists are now compared, and a mismatch is a failure rather
# than something a reader has to notice.
TABLE=$(grep -oE "id: '[A-Za-z0-9]+'" apps/daemon/src/claude-sdk-isolation.test.ts \
        | sed "s/id: '//; s/'//" | sort -u | tr '\n' ' ')
MINE=$(printf '%s' "$RAN" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
echo
echo "=== reconciliation with the CI table ==="
echo "  table:  $TABLE"
echo "  script: $MINE"
if [ "$TABLE" = "$MINE" ]; then
  echo "  ok  both cover the same $(printf '%s' "$MINE" | wc -w) shapes"
else
  echo "  !! COVERAGE MISMATCH — this script does not exercise what the table declares"
  exit 1
fi

if [ "$BROKEN" != "0" ]; then
  echo "  !! ONE OR MORE SHAPES DID NOT RUN — every result above is worthless"
  exit 1
fi

[ -z "$(git status --porcelain)" ] && echo "=== tree clean after battery ===" || { echo "!! TREE DIRTY AFTER BATTERY"; git status --short; }
