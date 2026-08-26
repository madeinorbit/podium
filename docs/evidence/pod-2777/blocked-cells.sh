#!/usr/bin/env bash
# Which blocked cells have become drivable?
#
#   bash docs/evidence/pod-2777/blocked-cells.sh
#
# POD-1761's rule (2026-08-26): every blocked cell carries the reason it is
# blocked, and WHEN THAT REASON LANDS, RE-CHECK THE CELL. The failure mode the
# rule exists to prevent is that NOTHING TELLS YOU. A blocked cell looks settled
# because it has a documented cause, so it is the reading nobody revisits — the
# same trap as a PASS, in the other direction. A4a sat PARTIAL for hours after
# POD-2853 landed and made it drivable again.
#
# So this turns the rule into a command instead of a memory.
#
# IT CHECKS FOR THE RUNTIME CHANGE, NEVER FOR A LEDGER ROW. The shared ledger
# once carried "the long-turn wedge is fixed and driven" while the fix existed
# only on its own branch — the commit saying so changed two files, both under
# docs/plans. A ledger is what people consult INSTEAD of checking, which makes it
# the more dangerous place for that claim to live. Every check below looks at
# code paths under apps/ and packages/ and ignores docs entirely.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
EPIC="issue/1761-agent-runtime"

cd "$REPO" || exit 1
git fetch -q --all 2>/dev/null

printf '%s\n' "blocked-cell check — $(date '+%Y-%m-%d %H:%M %Z')"
printf '  HEAD %s   epic tip %s\n\n' \
  "$(git rev-parse --short=9 HEAD)" "$(git rev-parse --short=9 "$EPIC" 2>/dev/null)"

# A BLOCKER THAT HAS ALREADY LANDED IS THE CASE THIS SCRIPT NEARLY MISSED.
#
# The first version only asked "has the fix landed since MY HEAD". That finds a
# blocker that lands in future and MISSES one that landed BEFORE my HEAD and
# whose cell I never went back to — which is precisely the A4a situation the rule
# was written for, and the script listed A10 half 2 as "still blocked" by a fix
# that was already in my own tree.
#
# So a blocker is now marked LANDED explicitly, and a landed blocker means
# RE-CHECK NOW rather than "wait". The status column carries which it is.
#
# cell | blocking issue | landed? | what it blocks | runtime paths that would carry the fix
CELLS=$(cat <<'ROWS'
A3 opencode|POD-2885|no|the long-turn wedge freezes both planes, so the interrupt control cannot observe a turn in flight. Needs POD-2885 ONLY — a3.ts is standalone, no drive.ts and no lock|apps/daemon/src/runtime apps/server/src/modules/sessions packages/agent-runtime
A3 codex|POD-2885|no|same. Run a3.ts after POD-2885 lands: the refusal turning into a SCORE is the signal the wedge fix reached this path|apps/daemon/src/runtime apps/server/src/modules/sessions packages/agent-runtime
A4a terminal half|POD-2875|no|opening a second viewer on the native view parks the chat send, so the ask never gets raised|apps/server/src/modules/sessions packages/protocol
A4a/A4b codex|the harness itself|n/a|codex raises no approval on this host; controlled against codex run OUTSIDE Podium with the same flag|
A10 half 2|POD-2853|YES|the demoted session used to die before it could report its driver identity — that fix is IN my tree, so this is drivable NOW|apps/daemon/src/runtime packages/pty
ROWS
)

any_drivable=0
while IFS='|' read -r cell issue landed why paths; do
  [ -z "$cell" ] && continue
  if [ "$landed" = "YES" ]; then
    any_drivable=1
    printf '  %-22s %-14s >>> BLOCKER ALREADY LANDED — RE-CHECK THIS CELL <<<\n' "$cell" "$issue"
    printf '     %s\n\n' "$why"
    continue
  fi
  if [ -z "$paths" ]; then
    printf '  %-22s %-14s STILL BLOCKED — not a code fix\n' "$cell" "$issue"
    printf '     %s\n\n' "$why"
    continue
  fi
  # shellcheck disable=SC2086
  landed=$(git log --oneline HEAD.."$EPIC" -- $paths 2>/dev/null | grep -v '^\s*$' | grep -vE 'test\(|\.test\.' | head -5)
  if [ -n "$landed" ]; then
    any_drivable=1
    printf '  %-22s %-14s >>> RE-CHECK: runtime code has landed <<<\n' "$cell" "$issue"
    printf '%s\n' "$landed" | sed 's/^/       /'
  else
    printf '  %-22s %-14s still blocked\n' "$cell" "$issue"
  fi
  printf '     %s\n\n' "$why"
done <<< "$CELLS"

if [ "$any_drivable" -eq 1 ]; then
  printf 'AT LEAST ONE CELL IS DRIVABLE AGAIN. Rebase, rebuild at a frozen HEAD, re-drive it.\n'
  exit 10
fi
printf 'Nothing has become drivable since HEAD.\n'
exit 0
