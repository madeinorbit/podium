#!/bin/sh
# Sweep every idle-cost variant, ONE BROWSER PER INVOCATION (POD-1607).
#
# The whole sweep in one process is enough peak load for the shared host to reap
# it mid-run, so each variant gets its own short-lived process and the results
# are collected here.
#
#   Xvfb :77 -screen 0 1280x900x24 & bunx vite --config vite.idle-cost.config.ts &
#   DISPLAY=:77 sh e2e/pod1607-sweep.sh [n] [windowSeconds]
set -u
N="${1:-24}"
W="${2:-10}"
OUT="${IDLE_COST_OUT:-/tmp/pod1607-idle-cost.jsonl}"
: > "$OUT"

# blank and hog run FIRST and are not optional: blank is the floor every other
# row is read against, and hog is the positive control. The caller checks them.
VARIANTS="${IDLE_COST_VARIANTS:-blank hog marks timers full gauge braille sweep marks:off full:off braille:off sweep:off}"
for V in $VARIANTS
do
  printf '%-22s' "$V"
  LINE=$(bun run e2e/pod1607-idle-cost.ts --only "$V" --n "$N" --window "$W" 2>&1 \
    | grep '\[idle-cost-json\]' | sed 's/^\[idle-cost-json\] //')
  if [ -z "$LINE" ]; then
    echo "FAILED (no reading)"
    echo "{\"variant\":\"$V\",\"failed\":true}" >> "$OUT"
  else
    echo "$LINE" | sed 's/.*"cpuPct":\([0-9.]*\).*/\1%/'
    echo "$LINE" >> "$OUT"
  fi
  # Let the host settle so the next browser starts from the same baseline.
  sleep 3
done

echo
echo "readings in $OUT"
