#!/usr/bin/env bash
# THE ACCEPTANCE DRIVE'S SEQUENCE, ON THIS RIG — `sessions.resurrect`, not
# `sessions.resumeAndSend` (POD-2775, review round 3).
#
#   bash docs/evidence/pod-2775/drive-up.sh
#   bash docs/evidence/pod-2775/drive-verify.sh HEAD
#   bash docs/evidence/pod-2775/drive-resurrect.sh [opencode|codex|grok]
#
# WHY A SECOND SEQUENCE EXISTS AT ALL. `drive.ts` wakes a parked session with
# `sessions.resumeAndSend`; POD-1761's acceptance drive uses `sessions.resurrect`
# and reported a red opencode row after this rig reported green. Two rigs
# disagreeing about one live instance is worth more than either result, so the
# first thing to rule out was that they are different code paths.
#
# THEY ARE NOT: `resurrectSession` (session-revival.ts) sets the row to
# `starting` and sends a `spawn` frame, which is the same frame `resumeAndSend`
# produces and the same one `resumeJournalledServerSession` intercepts. This
# script exists to SHOW that rather than to argue it — it drives their verb, in
# their order, and prints the binding journal at every step.
#
# WHAT THE JOURNAL LINE IS FOR. The wake's evidence is the baseUrl CHANGING while
# the `ses_…` stays the same: that is a relaunched server rejoining the recorded
# conversation, which is exactly what the fix does and what a rebind could not
# do. The secret changes with it — a fresh one is minted for the new process —
# so the credential a parked entry holds belongs to a server that no longer
# exists.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

KIND="${1:-opencode}"
case "$KIND" in
  opencode) JDIR=opencode-servers; IDKEY=opencodeSessionId ;;
  codex)    JDIR=codex-app-servers; IDKEY=threadId ;;
  grok)     JDIR=grok-acp-servers; IDKEY=grokSessionId ;;
  *) echo "unknown arm '$KIND' — expected opencode, codex or grok" >&2; exit 2 ;;
esac

[ "$PODIUM_PORT" != "19797" ] || { echo "refusing to drive the operator's instance" >&2; exit 1; }
B="http://$PODIUM_HOST:$PODIUM_PORT"
J="$PODIUM_DRIVE_BASE/cookie-jar"
NONCE="$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"

P(){ curl -fsS -b "$J" -X POST -H 'content-type: application/json' -d "$2" "$B/trpc/$1"; }
Q(){ curl -fsS -b "$J" "$B/trpc/$1?input=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$2")"; }
ST(){ Q sessions.list '{}' | python3 -c "
import json,sys
r=[x for x in json.load(sys.stdin)['result']['data'] if x['sessionId']=='$1']
print(r[0]['status'] if r else 'GONE')"; }
PHASE(){ Q sessions.list '{}' | python3 -c "
import json,sys
r=[x for x in json.load(sys.stdin)['result']['data'] if x['sessionId']=='$1']
print(((r[0].get('agentState') or {}).get('phase') or '?') if r else '?')"; }
JR(){ python3 -c "
import json,urllib.parse
f='$PODIUM_RIG_STATE_ROOT/$JDIR/'+urllib.parse.quote('$1',safe='')+'.json'
try:
  d=json.load(open(f))
  print('conversation=%s baseUrl=%s secret=%s' % (d.get('$IDKEY'), d.get('baseUrl','n/a'), 'present' if d.get('secret') else 'n/a'))
except FileNotFoundError: print('NO JOURNAL — a retired session, or one that never bound')
except Exception as e: print('unreadable (%s)' % e.__class__.__name__)"; }

R="$(P sessions.create "{\"cwd\":\"$PODIUM_DRIVE_BASE/repo\",\"agentKind\":\"$KIND\",\"initialPrompt\":\"Say the word BEFORE-$NONCE and nothing else.\"}")"
SID="$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['data']['sessionId'])")"
echo "arm $KIND, session $SID"

# THE WITNESS ON THE TRANSCRIPT FIRST, THEN IDLE — the order drive.ts had to
# learn: an idle row is not an exchange, and an exchange is not an idle session.
for _ in $(seq 1 90); do
  case "$(Q sessions.transcriptRead "{\"sessionId\":\"$SID\",\"direction\":\"before\",\"limit\":50}")" in
    *"BEFORE-$NONCE"*) break ;;
  esac
  sleep 2
done
case "$(Q sessions.transcriptRead "{\"sessionId\":\"$SID\",\"direction\":\"before\",\"limit\":50}")" in
  *"BEFORE-$NONCE"*) ;;
  *) echo "NO MEASUREMENT: the pre-park exchange never reached the transcript" >&2
     P sessions.kill "{\"sessionId\":\"$SID\"}" >/dev/null; exit 1 ;;
esac
for _ in $(seq 1 60); do [ "$(PHASE "$SID")" = "idle" ] && break; sleep 2; done
echo "  before the park : status=$(ST "$SID")  $(JR "$SID")"

echo "  hibernate       : $(P sessions.hibernate "{\"sessionId\":\"$SID\"}")"
sleep 3
echo "                    status=$(ST "$SID")  $(JR "$SID")"

echo "  resurrect       : $(P sessions.resurrect "{\"sessionId\":\"$SID\"}")"
for i in $(seq 1 15); do sleep 2; S="$(ST "$SID")"; [ "$S" != "starting" ] && break; done
echo "                    status=$S after $((i * 2))s  $(JR "$SID")"

echo "  resumeAndSend   : $(P sessions.resumeAndSend "{\"sessionId\":\"$SID\",\"text\":\"Say the word AFTER-$NONCE and nothing else.\"}")"
for i in $(seq 1 20); do sleep 2; S="$(ST "$SID")"; [ "$S" = "live" ] && break; done
echo "                    status=$S after $((i * 2))s  $(JR "$SID")"

sleep 30
T="$(Q sessions.transcriptRead "{\"sessionId\":\"$SID\",\"direction\":\"before\",\"limit\":80}")"
case "$T" in *"BEFORE-$NONCE"*) PRE=PRESENT ;; *) PRE=MISSING ;; esac
case "$T" in *"AFTER-$NONCE"*) POST=PRESENT ;; *) POST=MISSING ;; esac
echo "  transcript      : pre-park BEFORE-$NONCE $PRE / post-resume AFTER-$NONCE $POST"
echo
if [ "$S" = "live" ] && [ "$PRE" = PRESENT ] && [ "$POST" = PRESENT ]; then
  echo "VERDICT: WOKE — resurrect brought it back on its own conversation and it took a turn"
else
  # The pre-park witness is the control: without it the post-resume absence is
  # evidence about the read, not about the wake.
  [ "$PRE" = PRESENT ] || echo "CONTROL MISSING — the pre-park exchange is unreadable too"
  echo "VERDICT: DID NOT WAKE — status=$S, pre-park=$PRE, post-resume=$POST"
fi
P sessions.kill "{\"sessionId\":\"$SID\"}" >/dev/null
