# POD-2775 — hibernating a codex session wedges it

The operator's sentence was one symptom. Driven on an isolated instance it is
**two defects**, and they are independent: the resume fails against a park whose
process teardown was completely clean, and the park's alarming log pair appears
on parks that lose nothing.

This directory holds the rig that drives hibernate→resume and the record of what
it found.

## The scripts

| file | what it does |
| --- | --- |
| `drive-env.sh` | isolation environment for the `p2775` instance — source it, never execute it |
| `drive-up.sh` | brings up server + daemon, split and detached, from this worktree |
| `drive-verify.sh` | **refuses to let you measure anything** until the running processes are proven to be the commit you name |
| `drive.ts` | the drive: one exchange, park, resume, another exchange — receipt, process, row, transcript |
| `drive-down.sh` | stops the pair, keeps the state and logs |

```
bash docs/evidence/pod-2775/drive-up.sh
bash docs/evidence/pod-2775/drive-verify.sh HEAD
bun  docs/evidence/pod-2775/drive.ts
```

Re-cut from `docs/evidence/pod-2761/`, whose evidence doc reported this defect
blocking its own drive.

## What was reproduced, before anything was changed

Driven on `p2775` at `8550ee452` (the epic branch tip), on a codex session with
one completed exchange, parked from `idle`:

```
{"level":"warn","ns":"daemon:server-reap","msg":"could not complete the server-driver verb",
 "verb":"stop","err":{"message":"server-driver stop timed out after 1000ms"}}
{"level":"warn","ns":"daemon:server-reap","msg":"the server-driver process needs measured escalation",
 "processKey":"podium-cx-c1b4c3ac-…","verb":"stop"}
```

and then, on the resume:

| poll | row status | `spawnFailure` |
| --- | --- | --- |
| 0 … 24 (75s) | `exited` | `session '…' already has a persisted server journal` |

The row never left `exited`, and it never would have: the retry is the same
frame, so it fails identically every time.

## The two defects

**1. The bound was shorter than the thing it bounded.** `server-reap.ts` wrapped
each driver's own `stop()`/`kill()` in a 1000ms timeout. Codex's stop is
*defined* to wait 2000ms for the child to take its stdin EOF — the ending that
flushes the rollout JSONL the next resume reads — and then runs a `systemctl`
scope reclaim. So the verb could not finish inside its own bound, and every
healthy park reported a failed verb. The reap's own comment asserted the
relationship it needed ("the graceful endings the drivers define … have already
run inside the handle verb by the time these polls start") while its constant
made that impossible; the two numbers lived in different files and nothing could
see the contradiction. Grok carried the same 2000ms literal and the same defect.

**2. A failed verb was read as a surviving process.** The escalation branch fired
on `verbError !== undefined` as well as on a measured survivor. That inverts this
module's own contract — "the measured answer, never an assumed one" — because
`dead` *is* the measurement. It raw-SIGKILLs a corpse and runs `stop()` a second
time, and for a park that second stop is not free: codex's stop is the rollout
flush.

**3. And the one that actually kept the session down.** `sessions.resume` reaches
the daemon as a `spawn` frame, and the server-driver spawn path turned every one
into `runtime.create()`. `createWithId` refuses a session that already holds a
binding-journal entry — correctly; two children under one session id is the
POD-2249 double-spawn — and a **parked** server session holds exactly such an
entry, deliberately, because it is the address the conversation lives at. The
resume path had no way through that guard and was never meant to go through it:
for this family `adopt()` is already defined as resume-not-rebind (codex starts a
fresh app-server and `thread/resume`s the journalled thread), and it is what the
REATTACH path has always used. The resume path simply never asked for it.

Defect 3 does not depend on defects 1 and 2. It was reproduced above against a
park whose child exited cleanly, whose scope went `inactive`, and which left
nothing behind.

## The A/B

Same rig, same session shape, same machine, minutes apart. The "before" arm is
`380456dab`, a branch whose `apps/daemon` and `packages` trees are byte-identical
to the pre-fix commit (`git diff` between them is empty) with the rig kept, so
the only thing that differs between the two rows is the fix.

| | park receipt | park process | resume | conversation |
| --- | --- | --- | --- | --- |
| before (`380456dab`) | verb timed out at 1000ms, then escalated | child gone, scope inactive | `exited`, `already has a persisted server journal` | ALPHA yes, BRAVO **no** — the session never came back |
| after (`b17983ec5`) | **clean** — 0 verb failures, 0 escalations | child gone, scope inactive | **`live` in 3.6s**, a NEW app-server pid | ALPHA **and** BRAVO both in the transcript |
| after, re-driven at the branch tip (`6b155b5ec`) | clean | child gone, scope inactive | `live` in 2.4s, a NEW app-server pid | ALPHA and BRAVO both present |

Read the `park process` column across both rows: the child died and the scope
went inactive on BOTH builds. That is defect 3 shown to be independent — the
resume failed against a park that left nothing behind, and it would still have
failed if the reap had never logged a thing.

The before-run's two lines, as the daemon wrote them:

```
15:19:24.515 warn daemon:server-reap could not complete the server-driver verb
             sessionId=bff9db46-… verb=stop
15:19:26.073 warn daemon:server-reap the server-driver process needs measured escalation
             sessionId=bff9db46-… processKey=podium-cx-bff9db46-…
```

1.6s apart: the bound expired at 1000ms, and `pollDead` then watched the child
exit on its own — 2.6s after the stop began, which is `GRACEFUL_EXIT_MS` plus the
exit. Nothing was ever wedged.

The after-run in full:

```
host: 6488MB available (floor 900MB)
  session 63673313-ffe7-4a04-aaea-fb7952414aab
  reached 'idle' after 14.3s
  app-server children: 283702
  scope podium-cx-63673313-….scope: active
hibernating…
  the call returned in 0.2s; the row read 'hibernated' after 0.1s
1. THE PARK'S RECEIPT
     "could not complete the server-driver verb" : 0
     "needs measured escalation"                 : 0
     "is STILL running after a kill"             : 0
2. THE PROCESS
     app-server children still alive: none
     scope ActiveState: inactive
3. THE RESUME
     the row reads 'live' after 3.6s
     app-server children after the resume: 285137
     scope ActiveState: active
4. THE RESUMED SESSION
     ALPHA (before the park) present in the transcript: true
     BRAVO (after the resume) present in the transcript: true
=== VERDICT ===
  park receipt : CLEAN — the stop verb completed inside its bound
  park process : REAPED — no app-server child survived
  resume       : LIVE — a fresh app-server resumed the thread and took a turn
  overall      : PASS
```

The after arm was driven twice — once on the fix commit and again on the branch
tip after the tests and this document landed — because a rig that only ever
measured an intermediate commit is a rig that measured something nobody will
merge.

The resumed pid is a DIFFERENT process from the parked one, which is the point:
this family's adopt is a resume, not a rebind, and the fresh child says so by
bumping the binding version.

## The tests, checked against the defects they claim to pin

A green test proves nothing until the defect it names has been put back and shown
to turn it red. Each fix was reverted on its own, and each mutant was killed by
exactly one test while the other stayed green — so the pins are attributable
rather than a diffuse "something went red".

| mutant | test that went red | tests that stayed green |
| --- | --- | --- |
| `control/session.ts` reverted — no resume-by-adopt | `resumes a PARKED server session by adopting its journal rather than reaching the create` | `does NOT adopt when a live handle already holds the session` (it pins the unchanged half) |
| `HANDLE_VERB_TIMEOUT_MS` given a local `1000` again | `a stop that spends its whole graceful window is NOT reported as a verb that could not complete` | all 41 others, including the escalation pin |
| the escalation trigger back to `dead === false \|\| verbError !== undefined` | `a verb that failed beside a process that DIED is not escalated` | all 41 others, including the bound pin |

The middle row is why the bound is pinned behaviourally rather than by asserting
on the two constants: that mutant leaves `SERVER_HANDLE_VERB_TIMEOUT_MS` and
`SERVER_GRACEFUL_EXIT_MS` agreeing with each other perfectly, so a
constants-only assertion would have survived it — and re-localising the bound is
exactly how the defect arrived in the first place.

## What this rig refuses to report

Three controls, each of which has a matching way to produce a confident and
worthless number:

**No app-server child, no measurement.** A codex the version gate refuses, or a
logged-out isolated home, degrades the driver to `generic-pty` behind one warn
line. That session answers prompts and looks healthy, and it never enters the
server-driver teardown this issue is about — so a park on it is clean by
construction. The drive reads the degrade line out of the daemon log and exits
non-zero rather than reporting anything. (POD-2761's rig learned this twice, for
two different reasons.)

**No pre-park exchange, no resume verdict.** `BRAVO` missing is the finding — but
only if something could be read at all. `ALPHA` was written before the park, so
its presence proves the transcript read reaches this session's history. Without
it, `BRAVO`'s absence is evidence about the read, not about the resume.

**No memory headroom, no run.** A codex child OOM-killed mid-park is
indistinguishable from a clean park. The drive checks `MemAvailable` before it
creates anything, states the number in its output either way, and refuses under
900MB.

**And the park has to be attempted at all.** `hibernateSession` REFUSES a working
agent, and it refuses by returning `{ ok: false, reason }` rather than by
erroring. The first run of this drive slept a fixed twenty seconds, read `ok`
from the absence of an `error`, and then measured a session nobody had touched —
every number after that point described a live session. The drive now waits for
`idle` and prints the refusal reason.

## What a screenshot would not have shown

Nothing here is drawn. The park's receipt is two lines in the daemon's log
matched by their real text; the process side is the process table and
`systemctl show … ActiveState`; the resume is the session row and a transcript
read over the same tRPC surface the browser uses. What this is *not* is a person
clicking Hibernate and then Resume in a browser — that check belongs to the
operator, and this rig exists to make it worth their time.
