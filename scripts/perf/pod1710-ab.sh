#!/usr/bin/env bash
# POD-1710 A/B probe. Drives a fixed, repeatable load at a LIVE Podium server and
# reports the server's own per-RPC timings for it. Run the SAME script before and
# after a deploy, on the same box and the same DB, so the two runs are comparable.
#
#   PODIUM_SESSION_TOKEN=<token from `podium auth mint-session`> \
#     scripts/perf/pod1710-ab.sh <label>
#
# Reads only. Every call is a query RPC; nothing here mutates state.
set -uo pipefail
BASE="${PODIUM_BASE:-http://127.0.0.1:18787}"
TOKEN="${PODIUM_SESSION_TOKEN:?set PODIUM_SESSION_TOKEN}"
LABEL="${1:-run}"
OUT="${OUT_DIR:-/tmp}/pod1710-${LABEL}.json"

call() { # proc, json-input
  curl -s --max-time 120 -H "Cookie: podium_session=$TOKEN" \
    "$BASE/trpc/$1?input=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$2")" \
    -o /dev/null -w "%{time_total}\n"
}

echo "# POD-1710 A/B probe: $LABEL"
echo "# base=$BASE  started=$(date -Is)"

# The search terms are FIXED so the FTS candidate count -- the thing that drives
# the cost -- is the same in both runs. Short/common terms match the most rows.
echo "## conversations.search (the per-keystroke path)"
for term in a e in the po se; do
  t=$(call conversations.search "{\"query\":\"$term\",\"limit\":30}")
  printf "  %-4s %8.3fs\n" "$term" "$t"
done

echo "## sessions.list / issues (steady-state read path)"
for i in 1 2 3 4 5; do
  printf "  sessions.list  %8.3fs\n" "$(call sessions.list '{}')"
done

echo "## server-side view"
curl -s --max-time 60 -H "Cookie: podium_session=$TOKEN" \
  "$BASE/trpc/perf.snapshot?input=%7B%7D" -o "$OUT"
python3 - "$OUT" "$LABEL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))['result']['data']
def row(sec, items):
    print(f"  -- {sec}")
    for k,v in items:
        print(f"     {k:28s} n={v['count']:5d} p50={v.get('p50Ms',0):9.1f} p95={v.get('p95Ms',0):10.1f} max={v.get('maxMs',0):10.1f}")
rpc=d.get('rpc',{})
row("rpc of interest", [(k,rpc[k]) for k in
    ('conversations.search','discovery.refreshRepos','issues.markRead','sessions.markRead') if k in rpc])
ph=d.get('phases',{})
row("phases of interest", [(k,ph[k]) for k in
    ('feedBootstrap.read','feedBootstrap.total','feedPublish.total','sessionsBroadcast.total','sessionView.list') if k in ph])
print(f"  (raw snapshot: {sys.argv[1]})")
PY
echo "# finished=$(date -Is)"
