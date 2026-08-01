# POD-279 overnight handover — 2026-07-31 23:00 to 2026-08-01 13:30

Integration branch `issue/279-integration`, HEAD `46eabc2a`, clean and pushed.
Typecheck 22/22 with 0 cached (22, not 23 — `packages/agent-bridge` is deleted).

## What landed

    Phase 3  CLOSED. POD-1283 closed all eight POD-424 production-policy refusals,
             including a real two-user authenticated browser run proving the kernel
             Outbox dead-letter retry/edit/discard flow. POD-290 closed.
    Phase 4  4.1 gateway (POD-317), 4.3 SessionService split COMPLETE
             (POD-393/394/395), 4.4 IssueService recomposition (POD-320).
    Phase 5  POD-398 capability/transcript fold, POD-399 agent-bridge DELETED and
             the harness axiom flipped to error with zero allowlist entries.
    Phase 6  6.1a transport extraction (POD-400), plus POD-1313 subpath split.

The god object is gone: `sessions/service.ts` 5,893 lines -> `lifecycle.ts` 2,954,
177 -> 118 methods, with nine sibling modules. `IssueService`'s class chain is gone:
class inheritance 6 -> 0.

## STOPPED: no new agent session can start (POD-1317)

`podium issue start` returns SUCCESS, creates the session record and worktree, and
NO PROCESS EVER APPEARS. Six attempts on POD-318. Sessions started earlier keep
running, so it is the spawn path. Server healthy throughout; host not starved.
ONE daemon (podium-daemon.service, MainPID 55241, active) — an earlier note about a
duplicate daemon was my stale read and is retracted.

**Recommended first action: `systemctl --user restart podium-daemon`.** I attempted
it and was correctly blocked as requiring human authorization; I did not route
around it. The live agent trees are NOT daemon children (POD-401 is
3421604 -> 3421615 -> 3424364), so a restart should not kill running agents. Verify
/health and one `podium issue start` immediately after.

## In flight

POD-401 (6.1b replica binding) — 21 behind, silent for ~2h, committed nothing
itself; all its commits are coordinator insurance snapshots, pushed to its branch.
Its `replica-binding.ts` (148 lines) and hydration moves are real but partial. It
also edits `apps/server/src/auth-route.ts` outside its scope: I verified the
`authed` substitution is provably identical to `isRequestAuthed` for the
authenticated arm, but the open/dev arm now returns FIRST_ADMIN_USER_ID where it
returned undefined. That needs a decision, not a merge.

POD-318 (4.2 fleet service) — never ran. Clean worktree, zero commits.

## Open reds on integration

    POD-1316  wire-window.integration.test.ts times out at its 20s deadline.
              Reproducible IN ISOLATION at load 19 on integration itself. Decide
              whether the deadline is too tight for this box or the path regressed
              — do NOT just raise the timeout.
    POD-1318  steward.test.ts recurses infinitely. Reproducible in isolation. TWO
              structural hypotheses of mine are recorded as RULED OUT; trace it
              rather than guess a third.
    POD-1308  known: two 20s normalized-wire cases + the 180s live-scale benchmark.
              Load-sensitive, pass alone.

Full lane on the combined tree: 9,265 passed / 5 failed / 0 startup errors.

## Follow-ups filed

POD-1313 (done), POD-1314 issue-exposure audit, POD-1315 defaulted principal on
addComment, POD-1317 spawn, POD-1318 steward.

## What repeatedly proved true

Every unreliable instrument tonight failed in the SAFE-LOOKING direction: session
status said live when dead; `exit 0` hid four failures; a pipe returned tail's
status; a green typecheck hid a lost `this` receiver; "0 new" hid an allowlist
entry; `issue start` reported success while spawning nothing; and a clean auto-merge
would have silently reinstated a `case 'presence':` that another branch had
deliberately removed. The worktree, `/proc`, a planted violation, and the test COUNT
told the truth each time.

---

## POD-1317 ROOT CAUSE AND THE ONE ACTION THAT NEEDS YOU (added 2026-08-01 21:00)

**The daemon crash-loops on startup recovery over 172 abduco session masters, 163 of
them stale.** It never finishes, so new agent sessions never spawn.

Evidence, all measured:

    a daemon 38 SECONDS old sits at 98% CPU        -> cost is at STARTUP, not a leak
    the wedged bare abduco is gone, it STILL saturates -> that was never the cause
    stime > utime, ~2,400 voluntary ctx switches/s -> syscall storm, not a JS loop
    frames/control/tails/worker = 0 while own-cpu climbs 121 -> 583 -> 1673ms
                                                  -> work is in an UNINSTRUMENTED
                                                     startup path
    172 masters is the only quantity here large enough to match

`podium issue start` still returns SUCCESS with zero processes — that fail-open is
POD-1319 and should be fixed independently, because it is what made this silent.

### The action

I attempted it and was blocked, correctly: `podium help` says *"Agent sessions:
lifecycle changes and automation schedules need operator approval"*, and no
reap/prune/gc command exists. Terminating masters IS a lifecycle change.

**Regenerate the candidate list** (the original was in /tmp, which gets reaped):

```sh
# session ids that currently have someone ATTACHED — never touch these
pgrep -a abduco | grep ' -a ' | grep -oE 'podium-[a-f0-9-]+' | sort -u > /tmp/attached.txt

# masters that are UNATTACHED and older than 7 days
for p in $(pgrep -a abduco | grep ' -n ' | awk '{print $1}'); do
  sid=$(tr '\0' ' ' </proc/$p/cmdline | grep -oE 'podium-[a-f0-9-]+' | head -1)
  e=$(ps -o etimes= -p $p | tr -d ' ')
  [ -z "$sid" ] || [ -z "$e" ] && continue
  grep -qx "$sid" /tmp/attached.txt && continue
  [ "$e" -gt 604800 ] && echo "$p $e $sid"
done > /tmp/reap.txt
wc -l /tmp/reap.txt        # was 100 of 172 masters
```

**Start with twenty, then verify before doing the rest:**

```sh
head -20 /tmp/reap.txt | awk '{print $1}' | xargs -r kill -TERM

ps -o pcpu= -p $(systemctl --user show podium-daemon --value -p MainPID)   # expect << 100%
podium issue start --id 318 --agent codex                                  # expect a real process
```

**Do NOT touch** the 44 `-a` attachment clients (live PTY bridges) or the 28 masters
newer than 7 days.

### Why the selection is safe

A master qualifies ONLY if no attachment client references its session id AND it is
older than 7 days. Several are 17 days old. That cannot select a session anyone is
using.
