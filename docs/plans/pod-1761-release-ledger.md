# POD-1761 release ledger — every capability, one milestone, one action

*Written 2026-08-25. This is the coordinator's execution sheet. It sorts every
row of `docs/architecture/driver-capability-catalog.md` into exactly one
milestone (from `docs/plans/pod-1761-release-milestones.md`) with exactly one
action, and defines tonight's runbook and its scorecard.*

## The action vocabulary

| action | meaning | tonight's cost |
|---|---|---|
| **confident** | proven live, or pinned by a test that bites (mutation-checked). No work beyond keeping gates green. | zero |
| **check** | code exists; nobody has watched it work on the tip. One live drive step, result written down. | minutes each |
| **land** | a fix exists on a review-stage issue branch. Merge under lock with its verdict, then drive it. | the review queue |
| **implement** | does not exist and its milestone needs it. | not tonight unless listed |
| **defer(Mx)** | scheduled for milestone x; explicitly not v1's problem. | zero |

Status correction feeding this ledger: of the ten v1 blockers named in the
milestones doc, **seven are already fixed on review-stage branches** (POD-2470,
POD-2116, POD-2761, POD-2602, POD-2775, POD-2298, and POD-2604 which is blocked
on a dependency), and only four are open work (POD-2772, POD-2631, POD-2692,
POD-2691) plus POD-2432 (restart-safe inventory).

---

## Tonight's runbook (M0 + M1 candidate)

Ordered. Each step has a measurable exit; do not start a step before the
previous one's exit is true.

**Step 1 — land the review queue.** For each of POD-2470, POD-2116, POD-2761,
POD-2602, POD-2775, POD-2298: confirm its reviewer verdict is a pass (request
the review if none exists), then ff-only merge to `issue/1761-agent-runtime`
under `podium merge-lock`. POD-2604 first needs its blocker cleared or the
dependency waived. *Exit: all six merged; `git log` shows them on the tip.*
Status 2026-08-25 15:32: POD-2775 reports fixed AND driven (A/B evidence on the
issue, branch tip `a62c09c72`, each fix mutation-checked) — land first, it
unblocks judging POD-2761.

**Step 1 progress, 2026-08-25 evening (coordinator, verified not reported):**
- POD-2775 **LANDED** at `059dc628a`. Hibernate→resume works on codex: parked
  session live in 2.4s, ALPHA (pre-park) and BRAVO (post-resume) both in the
  transcript, against a byte-identical control build where it never came back.
  Three defects, mutants attributable one test each.
- POD-2574 **LANDED**. R1 fixed; typecheck fully cached (549ms). Its author
  reopened F2 against themselves — "already told synchronously" holds for an
  operator at the composer, is FALSE for an agent mailing another session where
  nothing renders the return — and found a test red since the commit that
  introduced it, because nobody had run the module.
- POD-2761 **REOPENED, and this is the one to watch.** The ordering pin landed
  (`7c69a6430`) and I verified it myself: the reviewer's previously-surviving
  mutation now kills exactly one test. But its session closed on item 1 of five,
  and item 3 is worse: `start()` is not only the cold-start path — `attach()`
  calls it on two documented CONTINUATION cases, where `spawnAbducoAgent` adopts
  a LIVE master and only repaints the viewport. So the reset deletes scrollback
  nothing will redraw and truncates the server's replay log. That is exactly the
  half of the operator's report the drive could not reproduce, and this change
  can now CAUSE it. `hasMaster(record.label)` is the named discriminator.
- POD-2780 (`@podium/web` typecheck red on the tip, named in step 2 below)
  **FIXED** at `d71456bc8` — a fixture missing `since`/`nativeSubagentCount`.
  Found by running the whole gate rather than the package I had touched.
- POD-2631 **fix landed** (`589512488`, "publish in-flight inventory probes").
  Its real shape is a WINDOW not a wedge: for ~40 minutes after a daemon start,
  installed harnesses report `not installed` and every spawn fails with a flat
  refusal. It blocked all claude-code spawns this evening, then self-healed.
- Gate tooling: the shared Turbo cache now lives inside the repo instead of
  `/tmp` (it died with every reboot), and `bun run typecheck` caps its own
  concurrency from free memory. Both were burning this box.

**Step 1, second pass — what the independent reviews found (2026-08-25 ~20:30):**
- POD-2470 **CLOSE.** All three properties hold and the rule is wired into the
  real gate, not merely unit-tested — the reviewer checked that too, correctly
  calling a rule that is only unit-tested "the other vacuity". Two-hop leak
  mutation RED with the full chain printed.
- POD-2631 **fixed and pinned.** Root cause: daemon attach marked the machine
  online while keeping the PREVIOUS connection's inventory authoritative, so a
  stale `installed: false` became a confident false negative; re-probes also
  superseded the authoritative wave and completed results were discarded. Now
  reports `probing`, spawn WAITS 25s, `podium machine reprobe` exists, and
  opencode discovery pins `~/.opencode/bin/opencode`. I ran its regression test
  (28 passed) and broke it (1 failed / 27) — it had never been executed, because
  the per-file vitest command collects ZERO tests under `apps/server`.
- POD-2761 **both rounds verified by my own mutation**, not by report: the
  ordering pin bites, and forcing `reattaching = false` goes RED across the
  opencode, codex AND grok adopted rows. Its A/B is still null and says so.
- POD-2775 **REOPENED — the most important finding of the night.** Two things:
  **(a) a parked OPENCODE session still cannot come back.** Its `adopt()` needs
  `probeHealth` against a server the park killed; codex is fixed, grok is fine,
  opencode is not. A codex-shaped route was generalised to three families and
  one was checked. **(b) NOTHING asserts the resumed session is the RIGHT
  conversation** — mutating a resume to a stranger's thread id left 269 tests
  green, because the conformance suite compares ids and generations but never
  the conversation, the fake app-server ECHOES BACK whatever thread id it is
  handed, and the drive checked only that both strings appeared. The single
  property resume exists to deliver has no automated defence at any level.

**Step 2 — gates green, and meaningful.** Run on the tip, stating whether
`PODIUM_TEST_WORKERS` was set (it changes the outcome):
`bun scripts/typecheck.ts` (25/25), `bun scripts/test.ts` (full suite, under
the `test:heavy` lock, short-disk TMPDIR), `bun run lint:boundaries` (baseline
is 6 known lines — zero NEW). Stale-golden and gate bugs that block this step:
POD-2714, POD-2759, POD-2778, POD-2728, POD-2040, POD-2031. Known reds already
attributed: `@podium/web` typecheck fails on the epic tip itself (POD-2780,
filed 2026-08-25 with reproduction — fix or attribute before release), and
`scripts/test-configuration.test.ts` is red iff `PODIUM_TEST_WORKERS` is set
(environment, not code — run the gate with it unset and say so). *Exit: all
three commands green, or every red attributed to a filed issue that is provably
pre-existing on main.*

**Step 3 — repin the operator instance** (`/tmp/pod-op`, port 19797) to the
tip and **verify the pin** (a drive proves nothing on an older commit —
check the running commit, not the deploy log). *Exit: instance reports the
tip's commit.*

**Step 4 — the Tier-A drive matrix.** The scorecard below, driven by hand or
script on the instance. Save a screenshot or transcript per cell and attach the
set to this issue. *Exit: zero failing cells.*

**Step 5 — triage the four open blockers.** Fix tonight or waive in writing:
- POD-2772 (login gate silently demotes server drivers to the terminal path)
  — **must fix**: it defeats the point of the release; sessions would quietly
  not be on the new drivers. Verify after: a logged-in opencode/codex/grok
  session reports `driverFamily: server`.
- POD-2691 (dead servers accumulate) — fix or waive with a documented manual
  reap and a cap; the drive matrix row A9 decides.
- POD-2631 (failed install probe cached as "not installed") — waivable
  tonight with the documented recovery (daemon restart) IF the drive matrix
  never hits it; fix is small (don't cache a timeout as absence).
- POD-2692 (login readout reads the operator's home, not the instance's) —
  waivable if tonight's release doesn't target named instances; otherwise fix.
- POD-2432 (sessions listable after daemon restart) — the A7 row of the
  matrix decides: if kill-daemon → restart → session resumes cleanly on all
  three drivers, tonight's bar is met without the full inventory work.

**Step 6 — release.** Merge the epic branch to main under merge-lock, tag,
release notes name: what flipped (three server drivers), the escape hatch
(`PODIUM_RUNTIME_DRIVER=generic-pty`), and the written waivers from step 5.
*Exit: main is the tip; instance repinned to main; matrix re-run spot-check
(A1, A7) passes.*

**Step 5's must-fix is DONE: POD-2772 landed (`2d641120b`).** It was three
causes behind one red lane, and the headline is that **the login gate was telling
the truth** — it is not what to change:

1. **The home.** The lane pointed `discovery.homeDir` at a bare mkdtemp. That is
   not only the scanner's root: host-runtime makes it `ctx.homeDir`, the home
   inventory reads harness login from, AND the HOME every server-driver child is
   spawned with. Under an empty home opencode is *genuinely* logged out, a
   logged-out harness has no headless path to admit, and the spawn naming
   `opencode-server` is refused before any server starts. The isolated home now
   carries `auth.json` and nothing else — the move `applyRealAgentCodexEnv`
   already makes for codex — leaving the 243MB conversation store behind.
2. **The model.** Suspected to be the same empty home one layer down; it is not.
   `opencode/laguna-s-2.1-free` has been RETIRED from opencode's gateway and
   answers `UnknownError` under the isolated home and a real one alike, which no
   credential story survives. The lane now resolves a free model the gateway
   still lists, and throws naming what it *did* list rather than handing that to
   a `waitFor`.
3. **The reaper — a false-red generator across the whole e2e suite.**
   `SuperagentService` is built from `registry.modules`, so it exists only after
   the registry and is not among the modules `SessionRegistry.dispose()` names.
   Its turn reaper kept firing into a closed database, and every e2e file ended
   with two or three `RangeError: Cannot use a closed database`, which Vitest
   counts as unhandled and fails the FILE on. **A lane whose every assertion
   passed still reported red.** Anyone who has chased an e2e red on this epic may
   have been chasing this.

Measured live on opencode 1.18.16: before, 1 failed with 3 errors; after,
1 passed, 0 errors, 31s of assertions against 184s of timeouts.

## STEP 5 TRIAGE — the coordinator's calls, made 2026-08-26

The four blockers step 5 left open, decided rather than left hanging:

- **POD-2772 — FIXED and landed** (`2d641120b`). It was the must-fix and it was
  three bugs; see below.
- **POD-2631 — FIXED and landed**, its regression test run and mutation-checked
  by me after nobody had been able to execute it.
- **POD-2692 — PROMOTED FROM 'WAIVABLE' TO FIX, and started.** The ledger judged
  it waivable "if tonight's release doesn't target named instances". That is
  wrong on the facts now: **the acceptance drive could not measure claude at all**,
  and the mechanism is this family. POD-2772 hit the same seam from the other
  side — `discovery.homeDir` is not only the scanner's root, host-runtime makes it
  `ctx.homeDir`, which is BOTH the home the inventory reads harness login from AND
  the HOME every server-driver child is spawned with. This is the seam's **third**
  appearance on this epic (POD-2772's silent demotion, POD-2631's flat refusal,
  and now claude's unmeasurable column). Close it rather than meet it again.
- **POD-2432 — WAIVED for this release, with the reason on the record.** Step 5
  said the matrix's A7 row decides it: if a session resumes cleanly after a daemon
  restart, the bar is met without the full inventory work. **Resuming works** —
  POD-2775's journal-based `adopt` is precisely the daemon-died case, and the
  conformance corpus round-trips a snapshot across a supervisor restart. What is
  missing is only *enumerating* sessions this boot did not start. That is a real
  gap and a poor experience, and it is not a correctness or parity failure against
  main. Deferred to the operator explicitly rather than closed.

**And a new blocker the gate found that step 5 never listed: POD-2820.**
`bun run lint:boundaries` exits 1 on the tip, with three manifest-consumers
violations that are **all this epic's own** — two of the three files do not exist
on main and the third has zero forbidden imports there. Declaring the missing
dependency is NOT the fix: it silences `declared-deps` and immediately exposes
`manifest-consumers` underneath, which is the rule that means it. The declaration
was missing because the import should not be there.

## THE MATRIX IS COMPLETE — headless better in 3 cells, worse in 1 (`acab1cc65`)

codex, opencode and claude driven on both arms where both exist, per-cell pinned,
**every scored cell with its positive control fired.**

**HEADLESS BETTER (3)** — codex streams to a late joiner (78 frames, monotonic)
where its PTY cannot; opencode resumes a parked session where its PTY does not;
opencode's attachments reach the agent where the PTY's do not.

**HEADLESS WORSE (1) — codex attach, and it is the one thing standing between
this epic and its own bar.** Two defects in one cell: the headless driver
*declares image-only* and refuses a text file **exactly as declared**, while codex
on the PTY reads the text file fine — so the declaration itself is the
regression, not the refusal. And **the image it DOES declare was not read back
either**, which is unambiguous: a claimed capability that does not work is worse
than an honest refusal. **POD-2819, started.**

**CLAUDE RUNS ONE PATH** and it is the one the epic promises not to make worse:
reply, stop and resume PASS; **attach FAIL**; streaming n/a on a coarse-only
family. It binds `claude-pty` whatever the preference says — forcing
`generic-pty` produced **no binding at all** in 91s, because that preference names
a driver claude does not have, so that arm was meaningless rather than red.
Whether claude's attach also fails on today's main is POD-2819's to establish.

**The rig refused far more often than it failed**, and every refusal traced to
something real — a stalled turn, a modal nobody had cleared, a driver that never
bound, an arm naming a driver the harness lacks. In its own words: *a guard
cannot tell the rig's fault from the product's, which is why each refusal needed
a diagnosis before it could become a report.*

**The `resurrect` finding was retracted** (`2a9630dc6`) after POD-2775's control
experiment — which argued against its own author's position — established that a
healthy wake goes `starting → live` and never visits `exited` at all.

## CLAUDE'S PHASE IS FIXED — the release-critical column's blocker (`4adb58eb6`)

`claude-pty` reported `idle` through 79,922 bytes of output over 53 of 59
one-second intervals, `phase` idle at all 60 polls. **Claude fires no
`SessionStart` at all**, so the first hook a fresh session delivers is its
`UserPromptSubmit` — which does double duty: it becomes the causal bootstrap AND
is buffered to replay as the live hook. At that instant claude has not yet
created the conversation's `.jsonl`, so the transcript capture **threw** and the
handler returned without folding. `UserPromptSubmit` is the only hook that opens
a turn epoch, so the epoch stayed closed; the `Stop` arriving minutes later, once
the file existed, was then *correctly* refused for having no open epoch. The one
legacy `agentState` frame was correctly rejected at the server as unfenced, so
there was no second channel either — three mechanisms each behaving correctly,
composing into a session that looked asleep while it worked.

**The fix in one sentence: an unreadable transcript now costs the hook its
POSITION, not its EXISTENCE.** The hook is claude's own report of a lifecycle
event and is evidence on its own; the transcript only supplies a cursor boundary.

**Verified by my own mutation, not by report.** Control 34 passed; restoring the
drop (`drainClaudeHooks(causal); return`) kills exactly one test — *folds the
prompt hook that arrives before claude has created the transcript* — 1 failed /
33 passed, restored byte-identical.

**Claude still cannot be driven end-to-end in the rig, and that is a decision I
made rather than a gap.** Its OAuth token there is revoked; claude authenticates
by OAuth only, no API key exists on this box, and a refresh in either home
ROTATES the token and invalidates the other holder — so re-seeding could log the
operator out of their daily driver mid-release. I declined that trade. Instead:
the terminal driver is SHARED, so codex and grok on `generic-pty` exercise the
same `injection.ts`, `paste.ts` and `index.ts` claude runs on, and that becomes
the substrate evidence. **The named residual** — `manifests/claude-code.ts`,
`agent-state/claude-code.ts`, `claude-screen.ts`, `claude-sdk-protocol.ts` — is
recorded as the untested delta. A named residual is a releasable risk; an
unmeasured column is not.

## THE CRITICAL PATH IS CLOSED — hibernate/resume on all three server families

**POD-2775 finished all six blockers; I verified two of them by my own mutation
rather than by report.**

- Reverting `opencode/runtime.ts` to the pre-fix commit: **5 red**, including
  *brings a HIBERNATED session back on its own conversation* and *wakes on the
  SAME model and effort it was parked on* — on **opencode**, not merely codex.
- The wrong-thread mutant that once survived 269 tests with zero red: codex
  corpus 155 passed clean, then **6 red** with `'thr-someone-elses-conversation'`.
  Both restored byte-identical.

**The F1 design answer is better than either option I offered.** I said "either
the park leaves something `adopt()` can reach, or `adopt()` restarts and
rejoins". They took the second *and explained why the first is unavailable*:
making the park leave a live server means not killing it, which is the POD-2249
lie. Then the real obstacle — `adopt()`'s precondition is a surviving process
tree and `resume()` is the verb for process-gone, **but `resume()` mints a new
session id and a wake must keep the old one**, because a row, a client terminal
and an open tab all still name it. The journal makes the restart safe: `kill()`
clears it, `hibernate()` keeps it, so an absent entry means retired and a
mismatched process key means another incarnation — both still throw.

**Two corrections against myself, recorded because the second one matters.** I
reopened this issue claiming F1 was untouched, having grepped `probeHealth` at
`opencode-server.ts:608` and found it unchanged. I then "corrected" that by
saying :608 was a neighbouring client-terminal path. **That was also wrong, in
the flattering direction.** The author's own record is the accurate one: :608 *is*
on the resume path, inside the `host.adopt` the driver calls first — what changed
is that **its refusal is now a fork rather than an end**. The host is entitled to
say "no live server for this binding"; the driver answers a different question.
Grepping for the probe will always make this fix look absent.

**POD-2792 fixed interrupt on opencode, two defects deep.** The stop button never
reached the driver; then, once it did, `POST /abort` ends the turn as
`session.error` carrying `MessageAborted`, which the driver classified correctly
as `interrupted` and then **closed as FAILED anyway** — so stopping an agent
landed it on `phase: errored` with no error to show, where codex reaches `idle`
from the same button. `MessageAborted` appeared once in the package and no test
named it; two conformance pins now do.

**So two cells of the opencode column should now flip**, and the drive re-running
them is the independent confirmation those fixes need.

## THE COMPARISON THE EPIC IS JUDGED ON — FIRST HARNESS ANSWERED (`5c5a4d547`)

**opencode, driven on BOTH arms, same rig, same probes, same commit, with the arm
read live out of the daemon's `/proc` environ:**

> **HEADLESS IS BETTER IN TWO CELLS AND WORSE IN NONE.**

- **Streaming** — it streams to a viewer who joins mid-turn (26 frames, seq
  145→512, monotonic per row, fine watch acquired) where `generic-pty` cannot, by
  its own declaration of `watchLevels ['coarse']`. Not a shortfall in the old
  driver: a capability it does not claim.
- **Attachments** — reach the agent on the headless path and never arrive on the
  terminal one.
- Reply, stop, resume and the three n/a cells are **the same on both**.

**CORRECTED 2026-08-25 22:00 — INTERRUPT *WAS* A REGRESSION, on all three
server drivers.** The reading below (both arms failing) was accurate and my
inference from it was not. POD-2792 found the cause: `sessions.interrupt` routed
EVERY session down the terminal path — look up the harness abort key, send it as
`input` bytes. A server-family session has no PTY, so the daemon took the
`discarding input bytes for a bridgeless contract session` branch and dropped
them **on the line above the `bridge?.write` that would have delivered them**,
while `interruptTurn` had already returned `{ok:true}`. **`RuntimeGateway.interrupt()`
had ZERO callers** — driver method, daemon handler and gateway method all existed
and nothing ever called them. The driver half *was* pinned by the conformance
corpus; the wiring was not. That is the WIRED-not-PINNED column warning about
precisely itself.

Measured before (pin 83b0077, both controls firing): opencode and codex headless,
turn confirmed in flight, `{"ok":true}`, the daemon's discard warning naming that
session, and **35 and 66 preview frames arriving AFTER the stop**. After (pin
47be96d): PASS on both, stopped in **12ms and 532ms**, 0 and 1 frames after.
**The terminal arm remains unmeasured after the fix** and POD-2792 flagged that
itself rather than letting it pass.

**The original reading, kept because it is what was measured:** Terminal arm, control
fired: `{"ok":true}`, then terminal bytes 257 at the call → +44,049 after 6s →
+72,080 after 12s, and no transcript item carries `event:'interrupt'`. 72KB of
output after a call that reported success. A pre-existing gap on the old path that
the headless work inherited. POD-2792 is re-scoped: it no longer blocks the
release, and it must not be fixed only on the new path.

**CORRECTED — it was ONE HARNESS, not the terminal driver.** Driven by POD-2801,
`codex/generic-pty` and `grok/generic-pty` both report `working` correctly. The
defect was **opencode only**, and its cause was neither the driver nor the board's
read path: `observeOpencodeState` had TWO readers on ONE SQLite cursor —
`emitTranscript` and `tick` both query the parts newer than `(lastPartTime,
lastPartId)` and both advance it, and `pollOnce` ran them in that order. So on
every tick of every turn the transcript read consumed the new rows and the state
read queried from a cursor already past them: zero rows, no
`prompt_submitted`/`activity`/`turn_completed`, `onEvents` never called, the
reducer never reached. The phase kept whatever `bootEvents` seeded — `idle` —
while the transcript filled. Fixed to one reader per cursor. Driven before/after
with the PTY's own output bytes as control: **`idle`×60 over 121,554 bytes →
`working`×12 over 159,751 bytes** (`604f8d7de`).

**BUT CLAUDE HAS THE SAME SYMPTOM FROM AN UNRELATED CAUSE, and it is the column
that can stop the release.** `claude-pty` never reports `working` either:
79,242 bytes across 49 of 59 one-second intervals, 12,267 transcript chars,
`phase=idle` at all 60 polls. Claude's phase comes from http hooks folded by the
causal observer rather than from a poller; the harness **does** fire them
(verified against a throwaway sink — `UserPromptSubmit` and `Stop` both posted),
and the checkpoint names the real provider session id — but its cursor sits at
`components {transcript: 0, hook: 0}`. **POD-2810, started.** Claude is the
harness this epic promises will be no worse, and today a busy claude session
reads as idle for its whole turn.

**The original, too-broad claim, kept because it is what I wrote:**
— 13,250 characters of output across 60 polls in 60 seconds, `idle` every time. A
busy terminal session renders as idle on the home board for the entire turn. The
catalogue lists that row `wired` for terminal, which is exactly what that column
warns about. Filed POD-2801.

**The drive replaced its own pin leg after the POD-2775 reviewer defeated it**, and
recorded two of its own wrong answers rather than fixing them quietly: a ring
buffer that made 105KB of *continuing* output read as *stopped* (negative deltas
satisfy "did not grow"), and a verdict whose narrative line contradicted the bytes
printed directly above it.

## FIRST REAL DRIVE READINGS (POD-2777, 2026-08-25 ~21:00)

The acceptance drive is running and has produced the epic's first measured
column. **opencode HEADLESS, all controls fired:**

| probe | result |
| --- | --- |
| reply | PASS |
| attach | PASS |
| stream | PASS |
| stop | PASS |
| **interrupt** | **FAIL** — `{ok:true}` returned while the turn keeps running, no interrupt marker. Four consistent observations. Filed POD-2792. |
| **resume** | **FAIL** — hibernate accepted, `hibernated` in 42ms (a genuine park), then resurrect returns ok and the row goes `exited` and stays there. Independently confirms POD-2775's F1. |
| interaction, model-switch, provider-error | n/a with reasons |

**Two corrections the drive made against itself, both worth copying.** It first
reported a late-join streaming regression from a single preview frame; re-driving
the same cell at the same pin gave 26 frames (seq 145→512, 25/25 transitions
growing). The single frame carried seq=512 — *the same final seq the passing run
ends on* — so the viewer had arrived at the tail. Timing miss, not a dead plane,
and it now reports BLOCKED with the seq printed so the claim is checkable. And
its first opencode `resume` PASS was **vacuous**; with the park control in place
the corrected answer is a true red.

Its refusal machinery also caught its own operator error: a terminal-column run
without a declared arm exited 4, because the rig compared the daemon's live
`generic-pty` against the arm claimed. It refused rather than quietly measuring
the wrong driver in the wrong column.

## The scorecard — Tier A drive matrix

One cell = one live drive on the operator instance. Pass criteria are exact;
a cell without its criterion met is a FAIL, not a shrug. Claude and shell
columns prove the untouched paths stayed untouched.

| # | drive | claude | codex | grok | opencode | shell | pass criterion |
|---|---|---|---|---|---|---|---|
| A1a | send while idle | ☐ | ☐ | ☐ | ☐ | ☐ | reply arrives; bubble goes `sent`, never silent-settles |
| A1b | send while busy | ☐ | ☐ | ☐ | ☐ | n/a | shows `queued` with position; survives page reload; delivered when idle |
| A1c | send to a dead session | ☐ | ☐ | ☐ | ☐ | ☐ | typed refusal or resume-and-send offered; never a lost message |
| A2a | status while working | ☐ | ☐ | ☐ | ☐ | n/a | badge `working` within 2s of turn start, `idle` after end; no flicker-idle mid-turn |
| A2b | status at boot | ☐ | ☐ | ☐ | ☐ | ☐ | a fresh idle session shows idle, not `working` or blank |
| A3 | interrupt mid-turn | ☐ | ☐ | ☐ | ☐ | n/a | turn stops; transcript shows interrupt; refused interrupt says why |
| A4a | permission ask | ☐ | ☐ | ☐ | ☐ | n/a | card appears in chat AND terminal shows the same ask; answering resolves both |
| A4b | answer twice | ☐ | ☐ | ☐ | ☐ | n/a | second answer is a typed error, not a double action |
| A5 | transcript | ☐ | ☐ | ☐ | ☐ | n/a | turns render with tool calls paired to results; reload shows same history |
| A6a | terminal attach + type | ☐ | ☐ | ☐ | ☐ | ☐ | keystrokes echo; resize refits; second viewer sees the same screen |
| A6b | chat↔CLI switch, both directions, twice | ☐ | ☐ | ☐ | ☐ | n/a | chat→CLI→chat→CLI: no restart, no scrollback corruption, correct size (POD-2761/2602 fixed); after the switches, a chat send still answers AND typing in the CLI still echoes — the session is fully functional in BOTH views |
| A7a | daemon restart | ☐ | ☐ | ☐ | ☐ | ☐ | session survives or auto-resumes as the SAME conversation (asks it to recall a codeword from before) |
| A7b | hibernate + wake | ☐ | ☐ | ☐ | ☐ | n/a | wakes with context intact; never wedges (POD-2775 fixed) |
| A8 | logged-out spawn | ☐ | ☐ | ☐ | ☐ | n/a | gets a working login path; after login, next session lands on the server driver (POD-2772 fixed) |
| A9 | kill session | ☐ | ☐ | ☐ | ☐ | ☐ | process tree gone (check the process table, not the UI); no orphan servers after 5 min |
| A10 | driver identity | n/a | ☐ | ☐ | ☐ | n/a | session reports server family; `PODIUM_RUNTIME_DRIVER=generic-pty` demotes it (escape hatch works) |

Rows A5 + A6a + A6b together are the "both views work and can be switched"
guarantee: chat functions (A5, A1, A4), the native view functions (A6a), and
switching never costs the session (A6b).

Plus two Tier-B not-worse spot-checks (no pass bar beyond "today's behavior"):
provoke a provider error (should at least match today's wording; grok's names
the quota reason since POD-2604), and confirm an OOM-killed session is not
shown as finished.

**Release rule: zero Tier-A fails. A Tier-A fail either gets fixed tonight or
the release does not happen. There is no waiver row in the matrix.**

---

## The full ledger — every catalogue row

Grouped by catalogue section. "Measured by" is the gate that keeps it true.

### §1 Turn lifecycle → all M1

| row | action | measured by |
|---|---|---|
| send opens turn, reports delivery | confident | conformance suite + A1a |
| queue with durable position | confident | suite + A1b |
| steer into running turn | confident | suite |
| steer downgrade reported | confident | suite |
| never undeclared delivery | confident | suite |
| unverified only where permitted | confident | suite |
| interrupt | **check** | A3, all four columns |
| stop-turn distinct from interrupt | defer(M4) | — |
| send-on-stop | defer(M4) | — |
| turn id carried, never minted | **check** | POD-2497 closes it; A1b reload leg |
| queue abandonment | confident | per-driver tests |
| principal survives the queue | **check** | code-read + one steward-send drive |
| per-turn override stays one turn | defer(M4) | — (model switching is Tier C) |
| origin rides turn/started | check → M2 | attribution pane spot-check |
| verdict from provider | **check** grok/opencode | A2a idle-badge honesty |
| failure typed + disposition | confident | driver tests |
| failure detail verbatim | confident | driver tests + Tier-B error spot-check |
| graceful stop drains queue | **check** | A9 with a queued message pending |

### §2 Streaming → M3 (Tier C — streaming into chat exists for nobody today), except the correctness substrate

| row | action | measured by |
|---|---|---|
| cursors monotonic across rebind; causal fencing; provenance/generation; cursor material declared | confident (M1) | suite — these underpin the transcript, not streaming |
| fine-watch rows (stream when declared, silent when coarse, join key, epoch stamp, stop on release, live-only) | confident, defer(M3) for live proof | suite now; POD-2773 drives grok/opencode in M3 |
| first turn a viewer joins streams | check (M3) | proven codex; POD-2773 |
| in-progress tool previews (`partial`) | implement grok/opencode if needed (M3) | codex pinned |
| watch filtered per viewer count | check (M3) | codex pinned |

### §3 Interactions → M1 core, M2 tail

| row | action | measured by |
|---|---|---|
| asked→answered, enumerable, in state(), twice=error, unknown refused, any phase, at-least-once bounds, typed payloads, decision-arm honesty | confident (M1) | suite + driver tests + A4 |
| login ask | **check** (M1) | A8 |
| permission ask | **check** (M1) | A4a |
| keystroke-emulated refusal leaves ask open | **check** (M1) | claude column of A4a with an unanswerable menu |
| recovery auto-answers full resume | **check** (M1) | A7a on a driver that prompts at resume |
| plan-approval / elicitation / recovery payload producers | check (M2) | thin today; POD-2414 line |
| expiry + escalation deadline | implement (M2) | no worker exists |
| answeredBy reported | check (M2) | attribution pane |

### §4 Lifecycle → M1 core, M4 portability

| row | action | measured by |
|---|---|---|
| resume/adopt/snapshot/hibernate/export family (9 rows) | confident (M1) | proven + suite; A7a/A7b re-prove live |
| import | implement (M4) | POD-2415 |
| byteFaithful/formatVersion, relative paths, not-yet vs never | confident, matter in M4 | suite |
| durability declared per driver | implement (M2) | the A7a behavior itself is M1 (POD-2432 or clean auto-resume); the *declaration* mechanism is M2 |
| forking, rewind | defer(M4) | — |

### §5 Attachments → all M1

| row | action | measured by |
|---|---|---|
| staging ref/refusal, enforced declaration, foreign ref, undeclared kind | confident | suite |
| promptForm — the image actually reaches the model | **check** | drive: paste an image on each driver, ask the agent what it shows |
| realpath containment | **check** | one adversarial path test |
| TTL/GC, dies with session | confident | legacy, unchanged |
| typed refusal rendered | **check** | grok refusal drive (evidence exists; re-run on tip) |

### §6 Errors and truth → M1 truth, M2 quality

| row | action | measured by |
|---|---|---|
| typed refusals, structural markers, permanent-vs-not-yet, version gates, health/OOM counters, failure vocabulary | confident (M1) | suite + POD-2413 tests |
| provider errors NAMED in chat | land (M2, or tonight if POD-2604 unblocks) | Tier-B spot-check |
| quota vocabulary arm | implement (M2) | — |
| needs-human materializes as interaction | land + check (M2) | POD-2414 is in review with a third pass requested |
| not logged in | **check** (M1) | A8 + POD-2772/2631/2692 triage |
| OOM rendered red | **check** (M1) | Tier-B spot-check |
| credential hygiene | **check** grok/opencode (M1) | verify strip on a live server-driver spawn (codex proven) |
| refused never stays "delivered" | land (M1) | POD-2298 in review; A1c |
| timeout reports failure | **check** grok/opencode (M1) | forced-timeout drive |

### §7 Configuration → M1 spawn facts, M4 mutability

| row | action | measured by |
|---|---|---|
| workdir/env/initialPrompt honoured | confident (M1) | every spawn exercises it |
| model/effort observed with provenance | **check** (M1) | A2 panel readout |
| title/accent | **check** (M1) | sidebar shows a real title per driver |
| sticky configure (model/effort/permission), per-turn overrides, subagent model, MCP forwarding, instruction re-prime | defer — M4 (re-prime M2) | catalogue keeps them |
| usage per turn surfaced | defer(M4) | B5 |

### §8 State readout → M1 what the badge needs, rest deferred

| row | action | measured by |
|---|---|---|
| working/idle, compacting, boot seeding, observation gap, lastActivityAt, open todos, blocked-on-human | **check** (M1, one drive: A2a+A2b) | drive |
| errored as a state | implement (M2) | POD-2693 |
| subagent count via contract | defer(M4) | legacy path keeps the UI chip alive in v1 |
| waiting-on cron/event/subagent | defer(M4) | — |
| context percent displayed | defer(M4) | — |

### §9 Attach and leases → M1

| row | action | measured by |
|---|---|---|
| lease/spectator/refusal/reserve/drain/peek family (9 rows) | confident | suite + A6a |
| cold start no fake continuity | land | POD-2761 in review; A6b |
| endpoint security | confident | opencode pinned; codex 0600 posture pinned |
| park/reconnect, retention policy, parkable declaration | implement (M2) | B8 |
| draft read/write | check (M2) | B6 |

### §10–11 Ownership + runtime primitives → M1 minimum, M4 the rest

| row | action | measured by |
|---|---|---|
| dedicated placement, exit-is-master's-exit, selection pure/total, create-with-id, tier boundary | confident (M1) | suite |
| kill leaves no corpses | land/fix (M1) | POD-2691 + A9 |
| typed stop outcomes, positive-evidence kill, exact identity, attribution, one authority | defer(M4) | process-ownership plan |
| list/inventory/quota/usage/accounts/login/import primitives | defer(M4) | legacy probers carry v1 |

### §12 Legacy loss budget → M1 = "unchanged", six explicit checks

Everything in catalogue §12 ships in v1 **on its existing path, unchanged** —
confident by virtue of not being touched — EXCEPT six rows where the new
drivers bypass the old path and parity must be checked once:

1. server-driver child env: instance HOME + credential strip applied (`serverChildEnv`) — check.
2. mail reaches a session on each driver (grok ACP hooks fire; opencode has no hooks — confirm parity with today's opencode, which also had none) — check.
3. prime injection still primes server-driver sessions — check.
4. browser-shim login capture works when a server-driver session needs login — check (part of A8).
5. uploads GC still covers server-driver staging dirs — check.
6. boot/idle seeding parity on server drivers (A2b) — check.

### §13 Client demands → folded into the matrix

`disposition`, echo reconciliation, `driverFamily`, `outputSeen`, OOM stop
reason, transcript cursor semantics — all exercised by matrix rows A1, A2, A6,
A9, A10. Thinking/todos/plan-body surfaces: defer(M4), recorded decisions.

---

## Spec reconciliation — every open spec commitment has a milestone

The normative spec (`docs/2026-08-07-agent-runtime-architecture.html`, rev 10)
was audited commitment-by-commitment in
`docs/architecture/pod-1761-spec-gap-audit.md`: 66 commitments — 17
implemented, 25 partial, 18 missing, 6 diverged. This section places every
MISSING and DIVERGED commitment so the spec and the milestones cannot drift
apart. (The spec's own conformance sentence — send outcomes, ask lifecycle,
interrupt fencing, snapshot round-trip, causality under restart, per-family
permitted failures — is implemented as the conformance corpus and is
"confident" above.)

**Missing → milestone:**

| audit id | commitment | milestone |
|---|---|---|
| IS4 | needs-human failures materialize as interactions | M2 (POD-2414, in review) |
| IS5 | escalation deadlines + superagent triage | M2 (deadline) / M4 (triage) |
| AS2 | attach as a runtime wire command | M4 — v1 attaches through the legacy PTY relay, which works and stays |
| IS12 | generic procedures (oneShot / askAndAwait / interruptAndSend) | M4 |
| LD1 | one concrete per-machine AgentRuntime | M4 (POD-2410) |
| LD2 | import + process-table list | M4 (POD-2415, POD-2432; the restart-survival *behaviour* is M1 via matrix row A7a) |
| LD8 | Claude SDK embedded driver in a worker child | M4 (POD-2753, in review rounds) |
| LD11 | macOS/Windows degradation declared | M4 |
| CLI2 / CLI3 | `podium attach`, `podium runtime ps` | M4 |
| XT1 | every primitive on the daemon wire | M4 (POD-2412) |
| XT2 | server-family handoff via export/import | M4 |
| SA3 | accounts/login/logout/credential primitives | M4 — legacy login detection carries v1 |
| LD12 | retire headless/exec legacy axes | M5 (POD-2416) |
| XT6 | fleet acceptance (50 executors, one week) | M5 — closes the epic |
| XT4 / XT5 | cloud supervisor, cloud credential seeding | out of epic — recorded plan non-goals |

**Diverged → resolution:**

| audit id | divergence | status |
|---|---|---|
| IS2 | `stageAttachment` threw in every driver | **resolved on the tip** — POD-2408/POD-2574 landed typed staging; matrix row "promptForm" verifies it live in M1 |
| SA5 | grok server default vs spec's terminal-only row | resolved — spec rev 10 amended |
| AS6 / G1 | which projection owns state fields | accepted post-audit ruling; no work |
| LD3 | opencode archive not byte-faithful | accepted ruling — semantic archive is the universal guarantee; byte-faithful is capability-gated (matters in M4) |
| LD13 | codex/attach landed without the rollout proof | the debt this ledger pays: the M1 matrix IS the missed proof, and POD-2413 landed the OOM/budget half |

Ongoing owner: POD-2690 (spec-to-code conformance audit) keeps this table
honest as the tip moves.

---

## Tally

- **confident:** ~60 rows — the conformance corpus and driver tests carry them; gates green is the only maintenance.
- **check tonight:** ~25 drive cells, almost all folded into the 16-row matrix plus the six §12 parity checks.
- **land tonight:** 6 review branches + 1 blocked (POD-2604).
- **fix tonight:** POD-2772 (mandatory), POD-2691 (or waive with reap procedure), POD-2631/2692 (waivable with written recovery).
- **implement:** nothing for v1. Everything marked implement is M2+.

That is the whole release: land seven branches, run three gate commands, drive
one matrix, make four written triage calls. Every later milestone consumes its
rows from this ledger the same way.
