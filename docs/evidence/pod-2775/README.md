# POD-2775 — hibernating a codex session wedges it

The operator's sentence was one symptom. Driven on an isolated instance it is
**two defects**, and they are independent: the resume fails against a park whose
process teardown was completely clean, and the park's alarming log pair appears
on parks that lose nothing.

A review round then found **three more**, all in the same wake path: opencode
could not come back at all, nothing anywhere asserted that a resumed session was
the RIGHT conversation, and a wake dropped the session's model. Those are at
[the bottom of this file](#the-review-round--three-findings-and-what-they-cost-to-prove),
with their own A/B.

This directory holds the rig that drives hibernate→resume — two arms, `codex`
and `opencode` — and the record of what it found.

## The scripts

| file | what it does |
| --- | --- |
| `drive-env.sh` | isolation environment for the `p2775` instance — source it, never execute it |
| `drive-up.sh` | brings up server + daemon, split and detached, from this worktree |
| `drive-verify.sh` | **refuses to let you measure anything** until the running processes are proven to be the commit you name |
| `drive.ts` | the drive: one exchange, park, resume, another exchange — receipt, process, row, transcript. Takes the arm: `codex` (default) or `opencode` |
| `drive-down.sh` | stops the pair, keeps the state and logs |

```
bash docs/evidence/pod-2775/drive-up.sh
bash docs/evidence/pod-2775/drive-verify.sh HEAD
bun  docs/evidence/pod-2775/drive.ts codex
bun  docs/evidence/pod-2775/drive.ts opencode
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

## The review round — three findings, and what they cost to prove

An independent reviewer read the landed fix and found three real things. All
three were confirmed here before anything was changed.

**A parked OPENCODE session still could not come back.** The daemon route that
resumes from the binding journal is one route serving three families, and the
first round drove one. Codex's `adopt` was already written as
resume-not-rebind, so it passed; opencode's asked the host for a LIVE endpoint
and threw when nothing answered — correct after a supervisor restart, fatal
after a hibernate, which kills the server on purpose.

**Nothing anywhere asserted the resumed session was the RIGHT conversation.**
Replacing `journalled.threadId` with `'thr-someone-elses-conversation'` passed
the entire driver corpus: 355 tests, zero red, measured here before the fix. The
reason is one line in a fixture — `thread/resume` ECHOED BACK whatever id it was
handed, so a resume of a thread that never existed resolved as happily as the
real one. Every property a rebind had checked the session's BOOKKEEPING, all of
which a session on somebody else's thread satisfies exactly.

**A wake dropped the session's model and effort.** Codex sends both on every
`turn/start` and opencode on every prompt, from the spec the handle was bound
with — and an adopted session was bound with an empty one.

### The A/B, both arms

The control branch is `pod-2775-control-before` (`91aa29fac`), byte-identical to
the pre-fix epic tip in `apps/` and `packages/` —
`git diff --stat 83b007772 pod-2775-control-before -- apps packages` is empty —
with the rig kept, so the only difference between the rows IS the fix. The
opencode before-row was driven at `91aa29fac` and the codex before-row at the
same tree; the after-rows at `5e7d93a83` (before the rebase onto `2dfa7412f`,
which changed nothing under `apps/` or `packages/agent-runtime`).

| arm | tree | resume | conversation | journalled model |
| --- | --- | --- | --- | --- |
| opencode | before | **DEAD** — row `exited` in 0.6s, `spawnFailure: the opencode serve session recorded in the binding journal could not be resumed`, no child | same `ses_…` | `null` |
| opencode | after | **LIVE** in 8.3s on a NEW pid, both nonced witnesses present | same `ses_…` | `{}` |
| codex | before | LIVE in 3.5s | same thread | `null` — the operator asked for `gpt-5-codex`/`high` and the record the wake reads holds neither |
| codex | after | LIVE in 1.1s | same thread | `{"model":"gpt-5-codex","effort":"high"}` on both sides |

The codex rows are both LIVE because round one's fix is already on the epic tip;
what moved there is the MODEL, which is the third finding measured on a live
instance rather than argued from a code read.

### What the rig had to learn to produce those rows

**Presence is not identity.** The witnesses were the bare words `ALPHA` and
`BRAVO`, which any transcript containing them satisfies — including a fresh
session that had just been told to say them. They are nonced per run now, and
the binding journal's conversation id is read off disk before the park and after
the resume. That is the mechanism rather than a proxy for it.

**An idle row is not an exchange, and an exchange is not an idle session.** The
rig waited for `agentState.phase === 'idle'` and parked at once. Safe for codex,
where the initial prompt opens the thread's first turn; wrong for opencode,
whose initial prompt is a `when-ready` send AFTER `POST /session`, so the row is
idle in the window before it goes out. The first opencode run parked an EMPTY
conversation and correctly reported NO MEASUREMENT. Waiting only for the witness
then moved the park onto an OPEN TURN, which `hibernateSession` refuses outright
— reported on the next run as a refusal and no park at all. Both were rig
defects the controls caught, and the order is now witness, then idle, then park.

**The port has to be proved ours.** POD-2777's acceptance rig picked
19847/46847/46848, the same three this one started on. The loser of that race
fails to bind while `/health` keeps answering 200 from the WINNER — every check
passed, and the drive was one step from logging in to another session's daemon
and reporting their sessions as ours. This rig moved to 19867/46867/46868, and
`drive-verify.sh` now compares the pid holding the listener against the pid it
started, because `/health` carries no instance id.

### The review round's mutants

| mutant | test that went red | what stayed green |
| --- | --- | --- |
| `codex/runtime.ts` resumes a literal thread id instead of `journalled.threadId` | 6 tests across `runtime.test.ts` and the codex conformance suite | everything else in the 8-file run |
| opencode's `adopt` throws again when nothing answers | both properties in `park and come back` — and ONLY on opencode | codex and grok conformance, 159 tests |
| `adoptedSpec(journalled.workdir)` — model dropped again (codex) | `wakes on the SAME model and effort it was parked on` | the other 50 |
| `model: {}` in opencode's adopted spec | the same property, opencode | the other 53 |

The first row is the one worth keeping: the mutant was reachable only after the
fake was taught to refuse a thread it never started. A fixture more forgiving
than the harness cannot fail, whatever is asserted on top of it.

### What is pinned in the corpus rather than driven

`park and come back — hibernate, then adopt` is a new conformance block, so
every family answers it rather than the one that happened to be looked at. The
model property inside it reads what the harness was ASKED for, off the fixture's
own server — a session's model is on no contract surface, which is exactly why a
wake could drop it unseen. Grok supplies no model control and the property says
why: its driver never reads `spec.model`, so it has nothing to preserve.

The opencode arm of the live drive does not pin a model: this host's only
provider credential is `opencode-go`, and the family refuses anything that is
not `provider/model`, so naming one here would be a guess. The corpus covers it
where the fixture knows what its harness accepts.

### Filed, not fixed

A wake relaunches the server WITHOUT the spawn frame's `env` — the layer
`session-env.ts` calls "the server-resolved session env off the spawn frame
(managed credentials)". `RuntimeDriver.adopt` takes only a binding, so the
driver synthesises a spec from its journal and neither family's carries it. Not
a regression from this round (before it, a parked opencode session could not
come back at all, and codex shipped the same shape), and the repair is a
contract change across four drivers. Filed as POD-2795 with the analysis.

## The second review round — findings 4, 5 and 6

The same reviewer's list was six, not three. The last three are all on code from
round one, and two of them are mine.

**4 — the retire lost its only retry of the verb that clears the journal.**
Round one narrowed the escalation branch so a verb that failed beside a process
that DIED is not escalated. The argument for that is entirely about `stop`:
repeating a park's stop re-runs the path that flushes codex's rollout JSONL. It
does not transfer to `kill`, and a retire's `kill()` is the only thing on the
handle path that clears the binding journal — `reapByIdentity` clears it
explicitly, `reapViaHandle` never did, because `kill()` always got there. So a
retire whose `kill()` threw left the entry on disk, and for opencode that entry
holds the server's baseUrl **and** its secret. The verb runs again on the retire
arm. The test asserts the JOURNAL, not the call count: counting `['kill','kill']`
would stay green against a repeat that cleared nothing.

**5 — the bound's declaration was wrong in the other direction.** It claimed the
handle-verb timeout was "strictly greater than everything those verbs are DEFINED
to spend". False by 14 seconds: codex's `stop()` may spend the graceful window
plus two `systemctl` calls at 8s each, 18s against a 4s bound. Exactly the defect
this file was created for, sign flipped — an assertion about two numbers that the
numbers do not support.

The fix is the declaration, not the number. Raising the bound to cover systemd's
worst case adds 16s to a receipt an operator is watching and buys nothing,
because nothing reads an expired bound as "wedged" any more: the reap escalates
on the measured process. So the comment now says what it can back — above the
graceful window, which is the one CONTRACT inside the verb, and deliberately not
above the reclaim, whose duration belongs to systemd. The 8s per-call bound was
spelled separately in all three server hosts and is now one exported constant, so
the worst case is computable instead of rediscovered, with the inequality pinned
in both directions.

**6 — this rig's own pin check was defeated, twice.** `drive-verify.sh`
established which commit the running pair was built from by reading a start time
out of `/proc` and comparing it against the commit's timestamp.

Both halves fail, and both were measured on this host rather than argued:

- `stat -c %Y /proc/<pid>` is the **inode mtime**, not the process start time.
  Sampling every live pid against `btime + starttime` from `/proc/<pid>/stat`:
  **100 of 240 pids skew by more than 5s, worst 7751s** — and the skew runs
  FORWARD, so a process OLDER than the commit reads as newer than it. That is the
  direction that turns a stale rig into a pass.
- and `started >= committed` is satisfied by the **parent** commit too.
  Demonstrated on the same running pair rather than reasoned about:

  ```
  new check, named the PARENT   -> VERIFY FAILED: server was spawned from 470c54f1d, you named c47650df4
  what the OLD check would say  -> inode-mtime=1787689220 parent-commit-time=1787688987 → PASS
  new check, named HEAD         -> VERIFIED: p2775 is running 470c54f1d
  ```

  For an A/B whose entire claim is which of two commits produced a row, that is
  the check failing at precisely its job — and this rig's own before-arms were
  guarded by it.

`drive-up.sh` now writes the sha it spawned from, and whether the tree was clean
at the time, beside the pidfile; verify compares that. Nothing is reconstructed
from a clock, and an instance nobody started through `drive-up.sh` is refused
rather than guessed at.

### Re-driven after all six

Both arms, at `afab5e749`, after findings 4-6 landed on top of 1-3:

| arm | park receipt | park process | resume | conversation |
| --- | --- | --- | --- | --- |
| codex | CLEAN | REAPED | LIVE in 1.8s on a new pid | same thread, model `{gpt-5-codex, high}` both sides |
| opencode | CLEAN | REAPED | LIVE on a new pid | same `ses_…` |

### The round-two mutants

| mutant | test that went red | what stayed green |
| --- | --- | --- |
| the retire's second `kill()` removed again | `a RETIRE whose kill threw runs it AGAIN — that verb is what clears the journal` | the other 42, including the park's `['stop']` pin |
| `threadId` → a foreign literal, re-measured across 19 files at the tip | 9 tests in 2 files | 592 passed, 5 skipped |

The second row is the number worth carrying: the reviewer measured zero red for
that mutant across nine driver files and both daemon lanes. After the fake was
taught to refuse a thread it never started, the same mutation reds nine.

## The third round — driving the acceptance rig's verb

POD-1761's acceptance drive kept reporting a red opencode resume row after this
rig reported green. Two rigs disagreeing about one live instance is worth more
than either result, so the first thing to rule out was that they are exercising
DIFFERENT CODE PATHS: their drive wakes a parked session with
`sessions.resurrect`, `drive.ts` uses `sessions.resumeAndSend`.

They are not different paths. `resurrectSession`
(`apps/server/src/modules/sessions/session-revival.ts`) sets the row to
`starting` and sends a `spawn` frame — the same frame `resumeAndSend` produces
and the same one `resumeJournalledServerSession` intercepts. `drive-resurrect.sh`
exists to SHOW that rather than argue it: their verb, in their order, with the
binding journal printed at every step.

| step | before (`1861f0d93`, source byte-identical to `83b007772`) | after (`719c94221`) |
| --- | --- | --- |
| before the park | live, `ses_…`, baseUrl `:40125` | live, `ses_…`, baseUrl `:35661` |
| hibernate | `{ok:true}` → hibernated, journal kept | `{ok:true}` → hibernated, journal kept |
| **resurrect** | `{ok:true}` → **exited after 2s**, baseUrl unchanged | `{ok:true}` → **live after 6s**, baseUrl `:37043` |
| resumeAndSend | `{ok:true, queued}` → still exited after 40s | `{ok:true, delivered}` → live after 2s |
| transcript | pre-park PRESENT, post-resume **MISSING** | pre-park PRESENT, post-resume PRESENT |

The before row is the acceptance drive's row, reproduced here — so this rig does
show the defect when the defect is present, which is the control that the
disagreement actually needed.

**THE BASEURL IS THE EVIDENCE.** It changes across the wake while the `ses_…`
stays the same: a relaunched server rejoining the recorded conversation, which is
exactly what a rebind cannot do. On the before arm it never moves, because
nothing was ever started.

### The park/retire tension, answered

A park must leave the journal (it is the address the wake reads) and a retire
must not (finding 4). Those pull against each other because the entry holds
`baseUrl` **and** `secret`. Three things keep them apart:

- `hibernate()` keeps the entry; `kill()` clears it, and finding 4 restored the
  retire's second `kill()` — the only thing on the handle path that runs that
  clear.
- a parked entry's credential belongs to a process that **no longer exists**. The
  park stops the server; the secret at rest opens nothing.
- and the wake does not reuse it. `relaunchFor` mints a FRESH secret, exactly as
  `resume()` does, so the old credential is never presented again — visible in
  the table above as the port moving with it.

## What a screenshot would not have shown

Nothing here is drawn. The park's receipt is two lines in the daemon's log
matched by their real text; the process side is the process table and
`systemctl show … ActiveState`; the resume is the session row and a transcript
read over the same tRPC surface the browser uses. What this is *not* is a person
clicking Hibernate and then Resume in a browser — that check belongs to the
operator, and this rig exists to make it worth their time.
