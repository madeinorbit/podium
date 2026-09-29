# POD-4445 — Round-two measurement harness and legacy control

Status: landed on `integrate/4441-round-two` · 2026-09-20 · G4 of POD-4441.
Plan of record: `docs/plans/pod-4286-prototype-methodology.md` rev 4 (§1a budgets,
§5.7 evidence rules, §5.8 scenarios). Slice: `docs/plans/pod-4441-round-two-slice.md`.

One way to count every arm (CI, happy-dom) and one way to time every arm
(Chromium), plus the current-store control that must FAIL the isolation test —
so the detector is proven before any arm is trusted.

## Layout (`packages/worklist-proto/`)

| Path | What |
|---|---|
| `shared/src/row-shell.tsx` | Required per-row wrapper: `RowShell`, `CommitLogContext`, `createCommitLog`, ambient `withCommitLog` / `withCommitLogAsync`, `currentCommitLog` |
| `shared/src/instrument/reads.ts` | Reads-per-change fence (POD-4557): `createReadFence`, `wrapTables`, `RelationReader`, `DISABLED_READ_FENCE`; `ReadStats.data` (rows whose data was read) and the copy sweep |
| `harness/src/count-harness.tsx` | CI counting: `mountArmForCounts` (`{ work: true }` counts work per change), `mountElementForCounts`, `mountNativeForCounts`, `createReplaySource`, `runCountScenario` (`CountResult.work`), `assertIsolation`, `assertCommits`; `assertReads` / `READ_BUDGETS` RETIRED (POD-4746) |
| `harness/src/work-meter.ts` | Work counted from outside the arm (POD-4746): derivations run, distinct elements walked, the arm's side (`insideArm` / `outsideArm`) |
| `harness/src/neighbourhood.ts` | The changed items' neighbourhood, read off the store and the oracle's order (POD-4746) |
| `harness/src/scale-check.ts`, `work-per-change.test.tsx` | THE work-per-change check: every fence scenario at 1x and 4x (POD-4746); the MobX pool's YES, the legacy control's NO |
| `harness/src/reads-probe.test.tsx` | The reads fence end to end, both directions (probe arms, real engine) |
| `shared/src/scenarios.ts` | THE scenario library (POD-4550): boot (`startScenarioEngine`, `startEngineOnCorpus`), rule-picked targets (`pickTargets`), every write (`write*` settled / `apply*` synchronous), the thirteen scenarios. Count runs, web entries and native lanes all use it |
| `harness/src/fixture/` | The ONE corpus: `buildCorpus(scale, seed)` |
| `harness/src/legacy-control/` | The control: `arm.ts` (`legacyControlArmFor`), `list.tsx`, `native.tsx`, `fenced-store.ts` (its store read through the reads fence), `control.test.tsx` (armed), `control-1x.test.tsx` (CI budget + JSON) |
| `harness/src/oracle/` | G2 oracle, plus `projectSnapshot` and `snapshotFromStore` (parity over live engine state), `oracleSnapshot` (the engine's own clock) and `rebuiltSnapshotFromStore` (every legacy memo bypassed) |
| `shared/src/gen/check.ts` | The correctness gate (POD-4556): `checkArm`, `diffSnapshots`; tests `check.test.ts` (armed), `check-ci.test.ts` (the CI-sized run, opt-in) |
| `harness/web/` | Vite pages per arm/control (`entries/`), shared page wiring (`entrylib.ts`, `window.__proto`) |
| `harness/web/noop-arm.tsx` | The no-op arm: the instrument floor page, and the timer's planted mistakes (POD-4558) |
| `harness/browser/run.ts` | Chromium timing driver (one invocation per arm/scale); writes a results file only when every cell is complete under load 8; `--dry-run` prints the plan |
| `harness/browser/matrix.ts` | Interleaved arms × scales × rounds, load-gated, lease per invocation; writes `matrix-plan.json`; `--dry-run` |
| `harness/browser/complete.ts` | Complete-or-fail (POD-4562): `runShortfalls` (driver), `gridShortfalls` (summary), the load ceiling `MAX_LOAD` |
| `harness/browser/summarize.ts` | Tables: actionMs per cell, floor, budget as floor + allowance, slope; refuses failed runs and any incomplete set |
| `harness/native/` | React Native count lane (`control.native.test.tsx`) |

## One corpus (POD-4550)

Every count, parity check and timing runs on the live-shaped fixture,
`buildCorpus(scale, seed)` in `harness/src/fixture/` (shape and provenance:
`docs/measurements/POD-4441-fixture-shape.md`). There is no second corpus: the
scenario generator's synthetic seed (`SMALL_CORPUS`, 60 issues; and
`GROWTH_CORPORA`, which showed 3,230 visible rows at "1x" against ~211 live)
was deleted in POD-4550, and with it the TanStack arm (eliminated in round
two).

| Knob | Values | Where |
|---|---|---|
| Scale | `1` (live installation: 4,867 issues, 4,304 sessions, 500 repos, 468 worktrees, **211 visible rows**), `2`, `4` (every collection multiplied; the growth slope) | `startScenarioEngine(scale)`, `?scale=` on the web pages |
| Seed | `FIXTURE_SEED = 4443` everywhere; vary it only to prove determinism | `shared/src/scenarios.ts` |
| Clock | the runtime's coarse clock is pinned to `FIXED_NOW` (2026-09-20T12:00Z, inside every band threshold) via the runtime's `coarseClock` seam; `writeClockTick` advances it through the engine; every write stamps rows from the same clock | `startEngineOnCorpus` |

Targets are picked BY RULE from the corpus (`pickTargets`), carried on every
`ScenarioResult` and on `ScenarioEngine.targets`, and checked against the
oracle in `shared/src/scenarios.test.ts`:

| Target | Rule |
|---|---|
| `heartbeatSessionId` (#1) | lowest-id session bound to a closed, childless agent root — a row the worklist never shows |
| `visibleRootId` (#2 #3 #4, #7 destination) | lowest-id open human root in an active stage with children, exactly one live working bound session and no other working session in its subtree, bound or prefix-seated (so #2 flips `working` at every scale; oracle-checked at 1x/2x/4x) |
| `phaseSessionId` (#2) | that root's first live working session |
| `stageMoveId`, `archiveId`, `evictId`, `markReadId` (#5 #6b #6c #9) | the next distinct childless, unpinned open human roots |
| `keeperLeafId` / `keeperParentId` (#6d) | an open leaf that is the ONLY child of a sessionless `backlog` rescue parent (the fixture carries ten such pairs) |
| `reparentId` (#7) | an open child with a live working session whose parent is another open root |
| `burstIssueIds` (#10) | the 50 lowest-id open human issues |

The fixture also carries one live issue whose `worktreePath` no discovery scan
reported (`corpus.unscannedWorktree`, handover from POD-4546): a sessionless
visible root seated ONLY by one orphan session under that path. The oracle
seats it (the row reads working); moving the orphan away turns the row off
(`oracle.test.ts`, "unscanned worktree seat"). A feed that only materialises
scanned worktrees loses that seat and fails parity.

## Counts (CI, happy-dom) — the verdict-carrying half

```bash
# the armed control (must fail isolation, must pass parity):
bun run test:file -- packages/worklist-proto/harness/src/legacy-control/control.test.tsx
# the control at live corpus (same, plus the 60 s CI budget and the 1x JSON):
bun run test:file -- packages/worklist-proto/harness/src/legacy-control/control-1x.test.tsx
# the native lane (package lane — excluded from the node lane, see below):
bun run --filter @podium/worklist-proto test -- harness/native/control.native.test.tsx
```

`runCountScenario` resets stats and the commit log, runs the scenario input in
`act`, and returns `{rowsCommitted, commitsByRow, visibleRows, stats, parity,
parityDiff}`. `assertIsolation(result, {rowsCommitted})` throws with the counts
on failure. happy-dom has no paint: never report a number from here as timing.

Every arm's row component must render inside `<RowShell id={rowId}>`, and every
arm's `mountWeb` must capture `currentCommitLog()` at mount and re-provide it
(`<CommitLogContext.Provider value={log}>`) — a separate root cannot inherit
the harness provider's context. Outside the harness the shell is a pass-through.
Every arm test needs the can-say-NO guard: a visible change must commit rows,
or the detector is blind.

## Timings (Chromium) — walls, second (POD-4558: work time only)

```bash
# production build (heavy):
bun scripts/test-heavy.ts -- bunx vite build --config packages/worklist-proto/harness/web/vite.config.ts
# the interleaved matrix: one run.ts invocation per (arm, scale) per round, pair
# order rotated each round, load-gated, bench and heavy-test leases per invocation:
bun packages/worklist-proto/harness/browser/matrix.ts \
  --arms noop,control --scales 1,2,4 --rounds 4 --samples 5 --tag floor --host flatblock
# (add --dry-run to either matrix.ts or run.ts to print the plan and run nothing)
# (round three's timing machine is flatblock: push the commit to
#  ssh://flatblock/home/mgw/podium-timing, check it out there, `bun install`,
#  build harness/web/dist there with `bun x vite build`; see "Instrument floor")
bun packages/worklist-proto/harness/browser/summarize.ts packages/worklist-proto/harness/browser/results/floor
```

The driver serves `harness/web/dist`, loads `<arm>.html?scale=N&sha=<HEAD>`,
waits for `window.__proto.ready`, settles the page (boot commits never land in
a record), then runs one warm-up round and `--samples` rounds of the six
scenarios (heartbeat, visibleHeartbeat, rename, stagemove, clock, click;
visibleHeartbeat since POD-4560), the order rotated per round. Every scenario, the click included,
goes through ONE timer in the page (`entrylib.ts`, `measure`):

    start → dispatch the change → drain → last commit signal → next frame

| Field | What it is | Budgeted |
|---|---|---|
| `actionMs` | Dispatch to the arm's last commit signal, or to the drain when the change commits nothing. Commit signals: the page's `RowShell`/`CommitBoundary` commit log (every row commit and mount, timestamped when React calls the shell's profiler) and DOM mutations under the arm's root | yes |
| `drainMs` | Dispatch to the first task after it (a `MessageChannel` message: runs once the dispatch's microtasks — feed flush, arm dispatch, React sync-lane commit — have drained; no timer clamp, no poll) | no |
| `frameMs` | Dispatch to the first animation frame after `actionMs` ends | no (its vsync phase is not the arm's) |
| `endedBy` | `drain`, `commit` or `dom`: which signal ended `actionMs` | — |
| `commits`, `mounts`, `domMutations` | In the change's window | counts |
| `strayCommits` | Commit signals that arrived after the previous settle and before this change | any > 0 FAILS the run |
| `longTasks`, `longTaskMs` | Long tasks overlapping the change's window (`takeRecords` after the settle) | reported |

**Targets are drawn rows** (coordinator ruling on POD-4558 finding #4). A
change aimed at a row the arm has not drawn commits nothing on a windowed arm
and the whole list on the control, so it would time the control's redraw
against an arm doing nothing. Every row target is therefore picked by rule,
identically for every arm, from the **first window**: the oracle's first 96
rows of the list (36 before POD-4560) as it stands before the change (`FIRST_WINDOW_ROWS`,
`entrylib.ts`), root rows only (the control nests formal children inside
their parent's row). The rules are the scenario library's (`targetRules`,
the predicates `pickTargets` uses; POD-4559 removed the page's own copy):

| Scenario | Target |
|---|---|
| #4 rename | the first open human root with children in the window; fixed for the page. Server title → `<title> (renamed)`; the next `prepare` restores its server rows untimed, so every sample is the same rename and titles never grow (POD-4559) |
| #5 stage move | the first childless open root (`childlessRoot`) no click selected; the next `prepare` reopens it untimed (its server rows restored), so every sample is the same move of the same row |
| #3 click | the first fresh UNREAD row (never selected, never moved, not the rename target; unread as the runtime's eager mark-read decides it, client-core's `activityAfterRead` over `issueActivityAt`) that neither rule above wants, else any; the ENGINE selection write `setSelectedIssueId` (POD-4559) |
| #1 heartbeat | the library's heartbeat session (a row the worklist never shows) |

**The click is the same engine work on every arm** (POD-4559, coordinator
ruling). Until then it was each arm's pressable: arm-local on hand and MobX
(`store.setSelection`, no engine write), the engine selection on the control,
whose eager mark-read then redrew the whole list: two workloads under one
name. Now every page's click is the engine's `setSelectedIssueId`; every arm
hears it on the locals channel (`createEngineLocals`; round-two hand and MobX
stores through the page's bridge into `setSelection` / `setCoarseNow`), and
the app's own mark-read of the selected row runs for everyone. Only unread
rows are clicked: a read row's click marks nothing, and on the control
commits nothing (the first 4x run with engine clicks alternated 1384 and 0
commits); with unread targets every control click at 4x commits 1384.

**The step's own mark-reads settle inside the step** (POD-4559, as the count
harness since POD-4618). The runtime throttles issue mark-reads to one per
`MARK_READ_ON_VIEW_MS` (1.2 s) and keeps an acknowledged read awaiting truth
until the server echoes it (or its 60 s wall-clock sweep): either lands after
the 250 ms quiet settle, in the next record. Untimed, after every number of
the record is taken: a click waits out the throttle window from its
dispatch; every mark-read the server acknowledged is echoed as truth
(`echoAcknowledgedMarkReads`, the body the count harness's `settled` uses)
until the kernel holds no pending write (`pendingWrites`); the page settles
again. `run.ts --no-mark-settle` (page `?marksettle=0`) removes it: the proof.

**Parity after every sample** (POD-4559). After each record, outside the
timed window, the driver compares the page's `snapshotHash()` (the arm's
`snapshot()`) with `oracleHash()` (`oracleSnapshot` over the same engine
state: its own clock, unselected baseline), both over one sorted-key
serialisation; a mismatch FAILS the run and names the first differing row in
the oracle's order with the fields that differ (`firstDifference()`). Each
record carries `parity: {arm, oracle, firstDifference}`. The no-op floor
draws its boot snapshot forever and is exempt, unless `--strict-parity`.

Before every write the page asserts the target is mounted in THAT arm and
throws if not, so the run FAILS instead of recording a zero. `prepare` picks
(untimed, before the driver's forced GC); `runScenario` times; `summarize.ts`
refuses to compare runs whose arms aimed a (scale, scenario, sample) at
different targets: its entry point (`runSummary`) prints `TARGETS DIFFER`,
prints no table and exits 2. `summarize.test.ts` drives the entry point over
such runs; with the call to `targetMismatches` removed that test goes red.

**Viewport 1600×5800, for every arm and scale** (POD-4560; was 1600×2400).
The pinned section grows with the corpus: on the reshaped fixture (POD-4635)
21 rows at 1x, 42 at 2x, 84 at 4x, and the first open root with children and
the first childless open root are rows 84 and 85 at 4x (42 and 43 at 2x). The
old 36-row window at 2400 px held only pinned rows at 2x and 4x, so rename
and stage move had no drawn target there (the 4x no-op run failed at its
first rename); round two's 1600×1000 failed the same way on the old fixture.
At 5800 px hand and MobX draw about 103 rows of 56 px; the first window is
96 rows (5,456 px with two 40 px headers) and the no-op page draws 108. The
2400 px viewport was accepted by the coordinator (POD-4286, 2026-09-23) on
the same reasoning.

**Check mode** (`run.ts --check`, page `?check=1`): after each change the page
compares, over the rows mounted before and after, the rows whose oracle row
view changed with the rows the arm redrew (committed or remounted) — the
count harness's exact-commit rule (`changedViews`) applied to what the page
drew. A mismatch on hand or MobX fails the run; the control and the no-op
page are reported (they exist to fail it). `--offwindow` plants the library's
`visibleRootId` as the rename target (off the windowed arms' first window).

Removed (round two's taskMs): the 50 ms `waitForNotifications` poll and the
two nested animation frames it wrapped, and `inputToPaintMs` (two frames
after a synthetic click, null on every non-click record, zero stats on the
click). No budgeted number contains a frame wait or a poll.

**The settle is untimed.** After the change the page waits until 250 ms
(`?quiet=`) and at least two frames pass with no new commit signal, so an
arm's work deferred to a later task inside that window is charged to
`actionMs`; work deferred past it lands between changes, shows as
`strayCommits` on the next record and FAILS the run. A settle that never
quiets fails after 5 s.

**What fails a run** (status `failed`, exit 2; `summarize.ts` lists it and
never prints its numbers): 1-minute load above `--max-load` (8) before the
run or on any record; any cell that errors or holds fewer than the planned
warm-up and measured records; any stray commit; a parity mismatch (the no-op
floor exempt); a page error.

**Complete or fail (POD-4562).** Round two published cells as "withheld" and
"provisional" (`docs/measurements/POD-4489-quiet-rerun.md` §1–§2: a control
4x with 7 of 40 records under load 8, a hand 1x reported on a 6-record
subset). Round three has no such state; a run is complete or it failed:

- `run.ts` writes its results file (`--out`) only when the run passed and
  every scenario holds exactly `--warmup` + `--samples` records, each at load
  ≤ 8 (`runShortfalls`, `complete.ts`). Anything else goes to
  `<out>.failed.json`, exits 2, and leaves no file at `--out` (an earlier one
  is deleted before the run starts). The driver reads the load per record
  itself: the bench lease fails open, so holding it proves nothing about the
  load. `--max-load` may lower the ceiling, never raise it (9 is refused).
  `--dry-run` prints the rounds, the rotated scenario order and what complete
  means, and exits without a browser.
- `matrix.ts` writes `matrix-plan.json` (arms, scales, rounds, samples,
  scenarios) beside the runs, retries a run that failed only on load (its
  file kept as `.tryN.failed.json`) and fails on anything else. `--dry-run`
  prints the plan and the rotated pair order.
- `summarize.ts` refuses the set (exit 2, every shortfall named, no table)
  unless the ok runs fill the whole grid: every arm present plus the no-op
  floor (each budget is floor + allowance), × 1x, 2x and 4x, × every
  scenario, the same n in every cell and at least 20 (the smallest n with a
  nearest-rank p95 that is not the maximum); with a matrix plan, exactly
  rounds × samples per cell and an ok output for every planned (round, arm,
  scale). A record above load 8 refuses the set even inside a run marked ok.
  A failed attempt the matrix retried is listed and does not refuse the set;
  a cell with no passing run does. There is no "n < 20" verdict and no
  withheld column: the note template (`docs/measurements/round-three-note-template.md`)
  has none either.

Proof: `harness/browser/complete.test.ts` and `summarize.test.ts` (unit, 38
tests); each refusal was removed in turn and the tests went red (see
NOTES.md, POD-4562). Live: with the box at load 19, `run.ts` refused before
timing, wrote only the `.failed.json`, and exited 2.

Field names overlap `docs/measurements/POD-4286-stage0-live.json` where they
measure the same thing: `runtimeSha`, `browser`, `capturedAt`, heap
`{before,after}` (`usedSize` et al), `longTasks`/`longTaskMs`, `commits`.
`windows[]`/`buckets`/`traceDistributions` are stage0-collector concepts with
no per-scenario equivalent here; `records[]` (one per scenario sample) is new.

## Budgets (methodology §1a) as assertions

| Goal | Budget | Asserted where |
|---|---|---|
| Idle client | zero derivation work except on the clock tick | count harness (`notifications` on settle-only runs) |
| Unrelated heartbeat | 0 rows committed, 0 derivations, publish `actionMs` p95 ≤ floor p95 + 2 ms at 1x (restated, see "Instrument floor"); its work flat from 1x to 4x (the work-per-change check) | counts in CI (`assertIsolation` + `rollupsDerived`, `work-per-change.test.tsx`); publish wall in Chromium (`summarize.ts`) |
| Any other hot-path event (rename, stage move, clock, visible heartbeat) | `actionMs` p95 ≤ floor p95 + 8 ms at live corpus (1x) | `summarize.ts` over the matrix; floor = the no-op page, same scenario, same scale (POD-4558) |
| Row click, engine selection write to the arm's commit (POD-4559; was the pointer event) | `actionMs` p95 ≤ floor p95 + 16 ms at 1x, + 32 ms at 4x | same; `frameMs` (to the next frame) reported, not budgeted |
| Cost follows the change, not the corpus | **The work-per-change check (POD-4746)**: every fence scenario at 1x and 4x; rows read, derivations run and distinct elements walked may grow by at most the changed items' neighbourhood at 4x, computed from the corpus (see "Work per change"). Replaces G3's wall slope (≤ 1.2) and the per-scenario reads budgets | `work-per-change.test.tsx` in CI; `summarize.ts` still prints the wall slope as a measurement, not a gate |
| Memory and cold start | **The growth test (POD-4747)**, replacing G6's multiples of the control: history ×10 at constant active work leaves the arm's retained heap (coldBootstrap `heapAfter − heapBefore`) and its cold start flat; active ×4 grows them at most linearly; per-change walls above the floor flat as active grows ×4; a switch's heap is reported against a cold build's. Tolerance = the larger spread of the two cells' per-round medians (see "Growth test") | driver on the two-axis cells (`matrix.ts --cells`), judged by `growth.ts`; `summarize.ts` reports lifecycle and judges none of it |
| Principal switch | no object of the old principal alive after the switch's forced GC (POD-4561) | driver: the survivor check fails the run |
| Bundle | ≤ +60 KB gzip on web, no native-incompatible dep | entry chunk sizes in build output; native lane mount |

Per-scenario row budgets are methodology §5.8 (#1: 0 rows; #2: 1 + ancestors;
#3: 2; #4: 1; #5–#7: affected + order; #10: bounded; #11–#13: full once).
Counts are asserted in CI; walls in Chromium. Growth with the data (§1a,
scenario #14) is the work-per-change check's, on counts (POD-4746); memory and
cold start growth are POD-4747's growth test. The wall slope is reported, not
gated.

## Instrument floor (POD-4558)

The no-op page (`harness/web/entries/noop.html`, `noop-arm.tsx`) mounts an
arm that takes every change and does nothing with it: it subscribes to the
feed and the locals (so the kernel write and the feed drain run as under any
arm), ignores every notification, and draws one window of rows once, from the
oracle, through `RowShell` — so its commit signal comes from its own shell
and it is timed on exactly the arms' path. Its `actionMs` is the cost of the
write, the feed and the timer's own settle hop: the floor. Every wall budget
is stated as **floor p95 + allowance**, per scenario and scale (table above);
the allowances are methodology §1a's numbers, fixed here before any
round-three arm is timed and not re-read on another dimension afterwards.

**Floor numbers — flatblock, reshaped fixture: THE FLOOR THE BUDGETS USE**
(POD-4560, 2026-09-23, `fe1745142`, Chromium 148.0.7778.96, 8 cores). The
fixture POD-4635 reshaped to the live workspace (732 / 1,464 / 2,928 visible
rows), the six scenarios, the 1600×5800 viewport and 96-row first window.
`matrix.ts --host flatblock --remote-dir podium-timing-4560 --arms
noop,noop+walk:2,noop+sync:5 --scales 1,2,4 --rounds 4 --samples 5 --tag
floor-4560`, interleaved, `bench:flatblock` lease per invocation: 36 runs
`ok`, n = 20 per cell, the 1-minute load on every summarised record ≤ 7.99
(uptime per record); four attempts crossed load 8 part-way (r0 noop 1x, r0
sync:5 4x, r3 sync:5 2x and 4x), were recorded failed, retried, and never
summarised. flatblock's own resident load (a Podium server and daemon, several
opencode sessions) sat at 4–11 during the matrix. `actionMs`, ms:

| Scenario | 1x p50 / p95 | 2x p50 / p95 | 4x p50 / p95 | raw slope p50 4x/1x |
|---|---|---|---|---|
| #1 heartbeat | 17.1 / 22.6 | 31.8 / 58.1 | 64.5 / 92.7 | 3.77 |
| visible heartbeat | 15.5 / 33.1 | 33.5 / 49.3 | 65.3 / 91.1 | 4.21 |
| #4 rename | 5.1 / 8.1 | 12.7 / 22.3 | 37.5 / 65.2 | 7.35 |
| #5 stage move | 4.8 / 7.4 | 10.4 / 15.1 | 41.5 / 62.8 | 8.65 |
| #8 clock | 0.4 / 0.9 | 0.4 / 0.6 | 0.5 / 1.1 | 1.25 |
| #3 click | 15.4 / 21.8 | 30.1 / 65.6 | 91.9 / 109.3 | 5.97 |

Every no-op record commits 0 rows with 0 stray commits. The click is no
longer sub-millisecond (0.5 ms on the old floor): since POD-4559 every sample
clicks an unread row, so the engine's eager mark-read runs a kernel write and
a feed drain inside the window. The shared write path grows faster with the
corpus than on the old fixture (raw slopes 3.8–8.7, were 1.2–5.6), so the
restated excess slope matters more, not less.

**The wall budgets** (floor p95 + allowance), at 1x: heartbeat 24.6
(publish, + 2); visible heartbeat 41.1, rename 16.1, stage move 15.4, clock
8.9 (+ 8); click 37.8 at 1x and 141.3 at 4x (+ 16 / + 32). Slope: the excess
over this floor, ≤ 1.2.

**Budgets = no-op floor + allowance, per scale (POD-4562).** Every wall
budget is derived, never typed in: `summarize.ts` takes the no-op's `actionMs`
p95 for the same scenario and scale from the SAME interleaved matrix (the
floor is a required cell; a set without it is refused) and adds the
allowance below (`allowanceMs`, `summarize.ts`). The allowances are
methodology §1a's numbers; §1a sets a wall at live corpus (1x) for every
event and at 4x for the click only. At 2x, and at 4x for the other events,
the growth is budgeted by the slope, not by a wall; those cells are still
required (a missing 2x or 4x cell fails the set) and printed. The budget
column below is that rule applied to the POD-4560 flatblock floor above; a
new matrix recomputes it from its own floor.

| Scenario | Allowance 1x / 2x / 4x (ms) | Floor p95 1x / 2x / 4x (POD-4560) | Wall budget 1x / 2x / 4x (ms) | Slope budget |
|---|---|---|---|---|
| #1 heartbeat (publish) | + 2 / — / — | 22.6 / 58.1 / 92.7 | 24.6 / — / — | excess 4x/1x ≤ 1.2 |
| visible heartbeat | + 8 / — / — | 33.1 / 49.3 / 91.1 | 41.1 / — / — | excess 4x/1x ≤ 1.2 |
| #4 rename | + 8 / — / — | 8.1 / 22.3 / 65.2 | 16.1 / — / — | excess 4x/1x ≤ 1.2 |
| #5 stage move | + 8 / — / — | 7.4 / 15.1 / 62.8 | 15.4 / — / — | excess 4x/1x ≤ 1.2 |
| #8 clock | + 8 / — / — | 0.9 / 0.6 / 1.1 | 8.9 / — / — | excess 4x/1x ≤ 1.2 |
| #3 click | + 16 / — / + 32 | 21.8 / 65.6 / 109.3 | 37.8 / — / 141.3 | excess 4x/1x ≤ 1.2 |

"—": §1a sets no wall at that scale. The slope is (arm p50 − floor p50) at
4x over the same at 1x, the 1x excess taken as at least 1 ms
(`SLOPE_MIN_EXCESS_MS`); the 2x p50 is printed beside it. Unit test
(`summarize.test.ts`, "allowanceMs") pins the allowance table.

**The restated budgets can still fail** (the same matrix, interleaved with
the floor; n = 20 per cell):

| Plant | heartbeat | visible heartbeat | rename | stage move | clock | click |
|---|---|---|---|---|---|---|
| `walk:2` (O(N)) — excess slope 4x/1x | 5.26 OVER | 6.14 OVER | 5.56 OVER | 5.35 OVER | 5.74 OVER | 4.75 OVER |
| `sync:5` (constant) — excess slope 4x/1x | 0.98 within | 1.15 within | 0.24 within | −0.65 within | 1.00 within | −0.84 within |
| `walk:2` 1x p95 against its budget | 83.3 OVER 24.6 | 43.5 OVER 41.1 | 46.4 OVER 16.1 | 33.4 OVER 15.4 | 27.4 OVER 8.9 | 69.0 OVER 37.8 |
| `sync:5` 1x p95 against its budget | 45.3 OVER 24.6 | 31.8 within 41.1 | 18.7 OVER 16.1 | 14.2 within 15.4 | 5.9 within 8.9 | 30.0 within 37.8 |

`walk:2` fails every slope and every 1x wall (the click too: the mark-read
now notifies the arm). `sync:5` passes every slope. Its heartbeat fails the
2 ms publish allowance, as it must (a constant 5 ms). Its rename p95 (18.7)
is 2.6 ms over a budget a constant 5 ms should meet (8.1 + 8): p95 jitter at
loads up to 8 on this floor. Reported to the coordinator as an observation;
no budget re-read here.

**SUPERSEDED — every browser NUMBER below in this section, and in "Browser
parity" after it, was measured on the fixture BEFORE the POD-4635 reshape**
(211 visible rows at 1x; five scenarios; 1600×2400 viewport; 36-row first
window): floors, wall budgets, plant tables, timer self-tests, check-mode
targets and counts. Kept as the record; no budget uses them (POD-4560). The
RULINGS stand: the budgets restated as excess over the floor, the 1 ms
minimum excess, drawn targets, strays and parity failing a run.

**Floor numbers — flatblock, old fixture, SUPERSEDED** (2026-09-23,
`6fbaf7a3c`, Chromium 148.0.7778.96, 8 cores). Round three times on one
machine, flatblock (POD-4286 ruling): anything compared must be timed on the
same machine, so every arm and the control are timed there and every budget
below is computed from this floor. Runs record `host`; `summarize.ts` refuses
to mix machines (`MACHINES DIFFER`, exit 2). `matrix.ts --host flatblock
--arms noop,noop+walk:2,noop+sync:5 --scales 1,2,4 --rounds 4 --samples 5`,
interleaved, `bench:flatblock` lease per invocation: 36 runs `ok`, n = 20 per
cell, 1-minute load ≤ 7.78 on every record; three attempts crossed load 8
part-way and were recorded failed and retried, never summarised.
`actionMs`, ms:

| Scenario | 1x p50 / p95 | 2x p50 / p95 | 4x p50 / p95 | raw slope p50 4x/1x |
|---|---|---|---|---|
| #1 heartbeat | 12.7 / 21.5 | 20.7 / 25.0 | 34.9 / 71.2 | 2.75 |
| #4 rename | 1.4 / 3.6 | 1.4 / 3.0 | 7.8 / 28.5 | 5.57 |
| #5 stage move | 2.2 / 5.5 | 2.8 / 7.9 | 4.6 / 10.7 | 2.09 |
| #8 clock | 0.4 / 2.5 | 0.4 / 1.5 | 0.5 / 1.1 | 1.25 |
| #3 click | 0.5 / 0.6 | 0.6 / 1.2 | 0.6 / 3.9 | 1.20 |

Every no-op record commits 0 rows with 0 stray commits; `endedBy` is `drain`
throughout (the kernel write, the feed and the settle hop, nothing drawn).
**The old wall budgets, SUPERSEDED** (floor p95 + allowance), at 1x: heartbeat 23.5 (publish,
+ 2), rename 11.6, stage move 13.5, clock 10.5 (+ 8); click 16.6 at 1x and
35.9 at 4x. Slope: the excess over this floor (below).

Note on the flatblock checkout: its Playwright Chromium cannot start without
`libasound.so.2` (Ubuntu 26.04 ships it as `libasound2t64`, not installed).
The runs use Ubuntu's own package unpacked into
`~/podium-timing/.toolchain/lib`, on `LD_LIBRARY_PATH` (`matrix.ts --host`
sets it); nothing system-wide was changed.

**Floor numbers — ludovico, old fixture, a record only, SUPERSEDED** (2026-09-23, `f33022e5f`; the
first valid floor, not used for any budget). `matrix.ts --arms noop`, same
shape: 12 runs ok, n = 20 per cell, load ≤ 7.73; four attempts failed on load
and were not summarised. p50 / p95 at 1x, 2x, 4x: heartbeat 14.2/29.0,
23.6/37.1, 34.5/55.8; rename 1.5/2.7, 1.3/2.2, 6.7/27.0; stage move 2.2/9.6,
2.5/4.6, 4.5/8.7; clock 0.4/0.5, 0.4/0.6, 0.4/0.9; click 0.5/1.3, 0.5/1.2,
0.6/3.2. The raw slopes (2.43, 4.47, 2.05) agree with flatblock's in kind.

**Two budgets restated as excess over the floor** (coordinator ruling on
POD-4558 finding (a), 2026-09-23). The shared write path (kernel write,
replica, engine publish, row-source drain) grows with the corpus before any
arm does anything: the no-op's p50 is 2.4–2.8x at 4x for a heartbeat,
4.5–5.6x for a rename, 2.0–2.1x for a stage move (both machines), and its
heartbeat alone takes 13–14 ms. Two
budgets therefore failed every arm, the no-op included — the same class of
defect as round two's `taskMs` budget with two frame waits inside it:

| Budget | Old | New | Why |
|---|---|---|---|
| Growth slope (#14), per scenario | `actionMs` p50 4x / p50 1x ≤ 1.2 | (arm p50 − no-op p50) at 4x / (arm p50 − no-op p50) at 1x ≤ 1.2; the 1x excess taken as at least 1 ms (`SLOPE_MIN_EXCESS_MS`) | the no-op's own raw slope is 2.75 (heartbeat), 5.57 (rename), 2.09 (stage move) on flatblock; 2.43, 4.47, 2.05 on ludovico |
| Unrelated heartbeat publish (#1) | publish ≤ 2 ms | `actionMs` p95 ≤ no-op p95 + 2 ms at 1x (24.6 ms on the POD-4560 flatblock floor; 23.5 on the superseded one) | the no-op's heartbeat is 12.7 ms p50, 21.5 ms p95 on flatblock (14.2 / 29.0 on ludovico) |

The 1 ms minimum: the no-op's per-round p50 moves by at most 0.3 ms on the
sub-millisecond scenarios (clock, click, rename at 1x), so a smaller 1x
excess is timer noise, and dividing by it would turn a 0.2 ms wobble into a
verdict. **This is a correction before measurement, not a re-reading after
it**: no round-three arm has been timed against either budget; the floor
that exposed them is the no-op page's. `summarize.ts` prints the raw ratio
beside the budgeted one, unbudgeted. Unit tests (`summarize.test.ts`,
"excessSlope"): constant work above the measured floor passes (raw 2.06,
excess 1.0) and work that grows with the corpus fails (excess 4.0); a mutant
that restores the raw ratio turns three of them red.

**The restated budgets can fail, old fixture, SUPERSEDED** (flatblock, the same matrix as the floor,
interleaved with it; n = 20 per cell). Two planted no-op arms
(`noop-arm.tsx`): `walk:2` walks every issue and session row of the feed twice
inside every notification (O(N) per change), `sync:5` busy-waits a constant
5 ms. Neither commits a row.

| Plant | heartbeat | rename | stage move | clock | click |
|---|---|---|---|---|---|
| `walk:2` (O(N)) — excess slope 4x/1x | 4.95 OVER | 5.36 OVER | 5.91 OVER | 5.25 OVER | −0.10 (no notification) |
| `sync:5` (constant) — excess slope 4x/1x | 0.79 within | 0.75 within | 0.83 within | 0.98 within | 0.00 |
| `walk:2` raw slope, for comparison | 3.87 | 5.38 | 5.34 | 5.14 | 1.00 |
| `sync:5` raw slope, for comparison | 2.11 | 1.78 | 1.20 | 1.00 | 1.20 |

The raw ratio would fail the constant plant on heartbeat and rename (2.11,
1.78) exactly as it fails the no-op; the excess passes it and fails only the
work that grows. A no-op click sends the arm no notification, so neither
plant runs on it. The restated publish budget fails too: `sync:5`'s
heartbeat p95 at 1x is 25.8 ms against 23.5 (a constant 5 ms over a 2 ms
allowance), and every `walk:2` wall at 1x is over its budget.

**The control's walls are not published** (POD-4558). Its 4x run FAILED: a
click's whole-list redraw (1384 row commits) landed after the 250 ms settle
and arrived as stray commits on the next change. Diagnosed and fixed in
POD-4559 (the step's mark-read settle, and unread click targets): see
"Browser parity, same click, settled mark-reads" below. The walls themselves
are for the next matrix.

**The timer can say NO** (planted mistakes on the no-op page, `--plant`,
summarised under their own label, never a floor run; 1x, functional runs):

| Plant | What it does | Timer result |
|---|---|---|
| `sync:20` | busy-waits 20 ms inside every feed/locals notification, commits nothing | charged: actionMs 20.6–28.9, `endedBy` drain |
| `late:30` | re-renders every drawn row from a 30 ms timer after every notification | charged: actionMs 32.5–38.6, `endedBy` commit, 51 commits. The first cut (settle after one quiet frame) missed it entirely — actionMs 0.3–5.0 with 0 commits, the 51 commits surfacing as strays on the next record — which is why the settle waits a quiet window and strays fail the run |
| `late:400` | the same, 400 ms late (past the quiet window) | run FAILED: 51 stray commits on the next record |

And the legacy control fails the budget it must fail: at 1x it commits 345–346
rows on every hot-path change (0 on the no-op page) — see the floor run.

**A low read count is not proof of constant work.** The reads fence counts
ENTITY rows; an arm that walks its own per-row caches on every change reads
few entity rows while its wall time grows with the corpus. The work-per-change
check (POD-4746, "Work per change") now counts those walks too, from outside
the arm (distinct elements iterated, derivations run), and compares 1x with
4x; the `actionMs` slope stays a measurement beside it.

**Scenario targets are drawn rows** ("Timings"). The proof, both ways
(`results/proof/`, SHA and table below):

Check-mode runs at `4a870d0dc` (warm-up + 5 samples per scenario, one page
per arm and scale; counts, not walls, so load was not gated — 7.5 to 11):

| Arm | 1x | 2x | 4x | Records where the redraw ≠ the oracle |
|---|---|---|---|---|
| hand | ok | ok | ok | 0 of 90 |
| MobX | ok | ok | ok | 0 of 90 |
| no-op | ok | ok | ok | every rename, stage move and click (draws nothing: under) |
| control | ok | ok | FAILED (1384 stray commits after a click: its whole-list redraw landed past the 250 ms settle) | every record (whole-list redraw: over, 146 / 292 / 584 drawn rows for 1 changed) |

Targets, identical on all four arms at each scale: rename i23 / i133 / i260;
stage move i74 / i581 / i145 (the same row every sample); clicks i300, i301,
i292, i274, i57, i50 at 1x, the pinned roots and i96, i55 at 2x, the pinned
roots i1200–i1207 at 4x. On hand and MobX each rename and stage move redraws
1 row (oracle 1), each click 2 (oracle 2; 1 on the page's first click), the
heartbeat and the clock 0 (oracle 0).

The other direction: `--offwindow` (rename aimed at the library's
`visibleRootId`, i17 at 1x, outside the first window) FAILS the run on hand
and on MobX at the first write: `target i17 is not drawn by hand (first window
i300,i301,i23,…); refusing to time an undrawn row`. Nothing is recorded.

## Browser parity, same click, settled mark-reads (POD-4559)

SUPERSEDED (POD-4560): old-fixture counts, kept as the record.

All on flatblock (`bench:flatblock` held, load 2.0–6.8), warm-up + 5 samples
per scenario, one page per arm and scale, at `48ef61692`; counts and
verdicts, not walls. OLD FIXTURE: every count here is on the pre-POD-4635
1x/4x fixture (not live-shaped) and is provisional. Records in the POD-4559 issue artifacts.

| Run | Result |
|---|---|
| control 4x, mark-read settle on | ok, 30 records, 0 stray commits; every click (6 of 6, unread targets i1202–i1210) commits 1384 |
| control 4x, `--no-mark-settle` | FAILED: heartbeat#3, heartbeat#4, click#4 each carry 1384 stray commits (a click's mark-read landing in the next record) |
| control 1x | ok, 0 strays, parity equal on 30 of 30 |
| no-op 1x / 4x | ok (parity exempt; 12 of 30 records differ: every rename and stage move, the floor draws nothing new) |
| no-op 1x `--strict-parity` | FAILED at the first rename: `first difference row i23: title arm="retire fold 23" oracle="retire fold 23 (renamed)"`; stage move: `row i74: progressDone arm=0 oracle=1; closed arm=false oracle=true` |
| hand 1x / 4x, MobX 1x / 4x | FAILED on parity from the first record, 30 of 30: `row i286` (1x) / `row i1150` (4x): `phase arm="waiting" oracle="queued"; asking arm=true oracle=false`. The round-two arms' known resume-twin ask (POD-4551 ruling; `mobx.clock.test.tsx` carries it as an expected failure): the runtime collapses resume twins, those arms do not. Round two's arms are no longer timeable through `run.ts`; round three's are the candidates |

Targets: the (scenario, sample) → target list is identical on all four arms
at each scale (one hash per scale over the sorted list). At 4x: rename i260,
stage move i145, heartbeat s8606, clicks i1206, i1207, i1204, i1203, i1202,
i1210. The oracle hash after each rename is the same on every sample
(`d355a2dc` at 1x): the samples are independent and titles do not grow.

**Oracle clock** (coordinator addendum from POD-4556). `snapshotFromStore`,
`rebuiltSnapshotFromStore` and `rowViewsFromStore` derive AND project at
`locals.coarseNow` (`legacyDerivationFromStore(store, coarseNow)`).
`harness/src/oracle/one-clock.test.ts`: each helper asked at clock X equals
the engine advanced to X through its tick path; red on the old helpers (row
views at +7 d and later; the snapshot helpers on a planted finished-unread
child whose 7-day window closes between the two clocks — the plain corpus's
`SliceSnapshot` does not move with the derivation clock at any offset up to
a year). Every caller that passed a clock other than the store's, found by a
tripwire over the whole package suite (60 files, 532 tests green with the
fix): the checker's stale-clock control plant (`check.test.ts`) and the
reference arm's deaf plant (`fences.planted.test.tsx`), both deliberate and
still caught; `tickCrossings` (`fence-scenarios.ts`), which projects the row
views at the advanced clock by design and now derives there too; and the
round-two MobX `+60d jump` test (`mobx.clock.test.tsx`, an `it.fails`), which
jumps only the arm's clock, so its expected snapshot was built on two clocks.
No live candidate's parity check was among them.

## Lifecycle walls (POD-4561)

Round two measured the lifecycle scenarios (#11 principal switch, #12 cold
bootstrap, #13 rescope) by counts only, in happy-dom; its browser walls and
heap were withheld. The driver now measures them in Chromium, the control the
same way as every arm.

```bash
# its own matrix, at 1x: the hot-path grid needs 1x/2x/4x, rescope refuses 4x
bun packages/worklist-proto/harness/browser/matrix.ts --host flatblock --remote-dir <checkout> \
  --arms control,noop,<arms> --scales 1 --rounds 4 --samples 5 \
  --scenarios coldBootstrap,principalSwitch,rescope --tag lifecycle
bun packages/worklist-proto/harness/browser/summarize.ts packages/worklist-proto/harness/browser/results/lifecycle
```

**One page load per sample.** A killed or repeated lifecycle step poisons
later renders in the same page, so every lifecycle sample (warm-ups included)
loads its own page in a fresh browser context: a fresh renderer, nothing
cached, a heap of its own. The page is HELD (`?hold=1`): the entry builds
the fixture and boots the engine, then the arm waits for the driver, and a
held page refuses hot-path changes and a second lifecycle step. The timer is
the hot path's (`timeWindow` in `entrylib.ts`: dispatch, drain, settle, last
commit signal).

| Step | Untimed setup | Timed window (`actionMs`) | `heapBefore` → `heapAfter` (forced GC) |
|---|---|---|---|
| `coldBootstrap` | — | navigation to the entry's first statement (`scriptMs`: the bundle fetched, parsed, evaluated) + build: row source, locals, the arm's store, its list, to the last commit signal (`buildMs`). The fixture and engine boot between the two (`engineMs`) are the harness's and the kernel's, the same on every page, reported and not charged; `loadToPaintMs` (navigation to the first frame after the list, the hold removed) is reported | engine booted, no arm → list drawn |
| `principalSwitch` | build the arm; boot the next principal's runtime over a FRESH replica and cache on the same corpus (`engineMs`) | dispose the arm (list, store, locals, source: `disposeMs`) and build it over the new runtime, to the new list's last commit signal; the old runtime is destroyed after the window (the kernel's) | built arm, next runtime booted → switched, old runtime destroyed |
| `rescope` | build the arm; stage the corpus at 2x the page's | the kernel's rescope install onto the 2x rows (`growMs`) + the install back onto the page's own rows (`backMs`); the cache writes before each install are untimed | built arm, 2x rows staged → back at 1x |

Page hooks (`window.__proto`): `build()`, `coldBootstrap()`,
`prepareRebuild(principal)`, `rebuild(principal)`, `prepareRescope(scale)`,
`rescope(scale)`, `lateSignals()`, `survivors()`. Every entry page builds its
arm through `createArm(boot)`, so the rebuild is the entry's own recipe over
the new runtime.

**A lifecycle run FAILS** on a parity mismatch after the step (rescope: also
at the grown state, `midParity`), on commit signals outside the step's window
(`strayCommits`, before it plus `lateSignals()` after `heapAfter`), and when
any object of the old principal — runtime, store, replica, cache, arm handle,
row source, watched through `WeakRef`s — is alive after the switch's forced
GC (`survivors`). An arm that keeps the old principal fails lifecycle outright.

**The harness held the old runtime, not the kernel (found here).** The first
switch measurements grew the heap by ~5 MB on the control and the no-op page.
A heap snapshot's retaining path showed the entry module's top-level `await
startEngineOnCorpus(...)`: an async module's generator keeps its awaited
values in registers after it completes, so the old `ScenarioEngine` (and
through its replica, client-core's store-stats `aliases` WeakMap, the old
runtime) stayed alive. The entries now boot with `.then(...)`, no top-level
await and no module binding, and `mountPage` keeps no reference to the old
runtime after a switch. After the fix, both runtimes are collected and a
switch shrinks the heap (control 24.6 → 22.9 MB).

**Budgets — SUPERSEDED by the growth test (POD-4747, 2026-09-28; see "Growth
test").** The operator rejected ratio budgets as arbitrary (decision I4); the
table below is what `summarize.ts` judged until then (methodology §1a, set
before any lifecycle run, each against the CONTROL's measured p50 at 1x from
the same matrix). `summarize.ts` now reports lifecycle and judges none of it:

| Check | Budget |
|---|---|
| coldBootstrap wall | `actionMs` p50 ≤ 1.1 × control |
| principalSwitch wall | `actionMs` p50 ≤ 2 × control |
| Retained heap | coldBootstrap `heapAfter.usedSize` p50 ≤ 1.1 × control |
| No growth (principalSwitch, rescope) | `heapAfter / heapBefore` p50 ≤ control's + 0.05: the kernel and harness grow on a rescope under every page (the no-op too), so growth is judged above the control's |
| rescope wall | reported; §1a sets no budget |

**Control numbers — flatblock, THE REFERENCE THE LIFECYCLE BUDGETS USE**
(POD-4561, 2026-09-23, `879fc74d8`, Chromium 148.0.7778.96, 8 cores, the
reshaped 1x fixture: 4,867 issues). `matrix.ts --host flatblock --remote-dir
podium-timing-4561 --arms control,noop,noop+build:300,noop+leak:8 --scales 1
--rounds 4 --samples 5 --scenarios coldBootstrap,principalSwitch,rescope --tag
lifecycle-4561`, interleaved, `bench:flatblock` per invocation: 16 runs `ok`,
none retried, n = 20 per cell, the 1-minute load on every record ≤ 5.39.
Every record: parity ok (the no-op's frozen list exempt), 0 stray commits, no
survivor after a switch. p50 (p95), ms and MB:

| Step | control `actionMs` | phases p50 | heap before → after | growth | no-op `actionMs` |
|---|---|---|---|---|---|
| coldBootstrap | 202.0 (245.1) | script 94.4 + build 108.7; engine 1,728.6 (not charged); load to paint 1,944.3 | 20.90 → 22.56 | — | 207.1 (270.3) |
| principalSwitch | 236.7 (286.5) | dispose 4.1, build 233.7; next runtime boot 1,246.7 (untimed) | 24.57 → 22.94 | 0.934 | 286.8 (371.7) |
| rescope | ~~795.1 (892.3)~~ SUPERSEDED, below | grow 483.9, back 308.7 | 37.06 → 43.84 | 1.183 | 275.7 (330.2) |

**Rescope cell superseded (POD-4572, 2026-09-24).** The rescope above staged
the 2x corpus's ROWS but not its SCANS: discovery kept answering the page's
own corpus, so every worktree the grown corpus adds was unscanned at the
grown state (262 issue worktrees; 7 visible rows differed from the oracle on
the round-three MobX pool). Coordinator ruling: stage both, as a real
rescope delivers them. `harness/src/rescope.ts` now publishes the scope's
scans through discovery (`worktreesChanged`), settles untimed, then stages the
rows before each timed install (grow and back); `harness/src/rescope.test.ts`
holds the grown state to one unscanned worktree (the corpus's own orphan).
Re-measured in one interleaved matrix with the MobX pool (`--arms
noop,control,mobx --scales 1 --rounds 4 --samples 5 --scenarios rescope --tag
mb4-rescope`, flatblock, runtimeSha ccc4ce075, 12 runs ok, n = 20, load ≤
6.29, parity ok at the grown state and after):

| Step | control `actionMs` | phases p50 | heap before → after | growth | no-op `actionMs` |
|---|---|---|---|---|---|
| rescope | 972.0 (1,088.8) | grow 634.4, back 328.5 | 39.85 → 47.02 | 1.180 | 368.2 (405.9) |

The rescope growth budget on these numbers is ≤ 1.230. OPEN (reported to the
coordinator): on the control page the grown state holds 735 visible rows,
where the oracle over the same staged state holds 1,464 on the no-op and MobX
pages (and in the count lane with the control mounted); the control's
mid-state parity passes because the control and the oracle read the same
store. Its unpatched oracle hash at the grown state (`a2bbb0a3`) differs from
the no-op page's (`ece60d30`) for the same staging, so the control page's
grown state is not the others'. This predates the scan staging (the first
Mb4 run recorded 735 too).

**Rescope grown-state heal (POD-4715; the OPEN item above, resolved).** Root
cause: the 735 is real current-app behaviour, filed as production bug
POD-4722 — not a staging difference. On a kernel rescope install the replica
facade notifies synchronously in subscription order: the replica binding
first, the issue-view cache second. The binding's publication synchronously
re-derives the mounted control list's snapshot check inside the cascade,
BEFORE the view cache invalidates, so models build against stale 1x views,
the grown-only rows are skipped, and the partial list is pinned under the
grown store. Every later derive on that page reads 735 rows. The pools never
derive inside the cascade (they read the row feed), so their first legacy
derive lands after invalidation and reads the true 1,464. Shrinking back to
1x self-corrects (the stale views still cover the smaller set), so only
growth poisons — which is why only the grown state diverged. The control
stays the unmodified app; nothing outside `packages/worklist-proto` changed.
The instrument heals instead: `harness/web/entrylib.ts` `rescope()` runs the
same untimed step on EVERY page (noop, control, mobx, hand) after each timed
install window and before `midParity`, `grownRows` and the driver's
after-step reads — a discovery refresh answering the already-staged repos
plus a settle, publishing a fresh store snapshot with no row changes so the
next derive rebuilds from refreshed views. Untimed; the install windows are
untouched. Rescope carries no wall budget, and the budgeted heap growth must
reflect a correct round trip, which the stale control never makes. The
control's timed grow wall stays the real app's behaviour, INCLUDING the stale
cheap derive: in every table it is flagged "stale derive (POD-4722)" and is
not comparable to the arms' grow walls. The driver (`harness/browser/run.ts`)
FAILS a rescope run unless the page's `grownRows` equal the grown truth
(1,464 at 1x; the floor draws its frozen boot snapshot by design and must
hold the 1x truth of 732). Regression cover:
`harness/src/legacy-control/rescope-grown.test.tsx` (healed: 1,464 rows and
the pristine oracle; unhealed: pins 735 as POD-4722's evidence).

**The lifecycle budgets, on these numbers:** coldBootstrap `actionMs` p50
≤ 222.2 ms; principalSwitch ≤ 473.4 ms; coldBootstrap retained heap ≤ 24.82
MB; heap growth ≤ 0.984 after a switch and ≤ 1.233 after a rescope. They are
recomputed from the control in every lifecycle matrix, never typed in; a
matrix without the control is refused.

**Each check can say NO** (same matrix; the plants are no-op pages, so their
verdict is on the instrument, not an arm). The unplanted no-op passes all
five checks. `build:300` (300 ms busy in the store's construction): cold
507.9 ms and switch 596.0 ms, both OVER; heap within. `leak:8` (an 8 MB
block dropped to a global at dispose and at every replace): retained heap
30.26 MB OVER; switch growth 1.203 and rescope growth 1.497 OVER; its cold
wall 250.8 ms is OVER too (building the block costs ~45 ms). `retain:1` (the
disposed store kept in a global), one run on flatblock: FAILED, "after the
switch and a forced GC the old principal's runtime, store, replica, cache,
armHandle, scenarioEngine still alive".

**Arms.** At the integration tip the round-two hand and mobx pages fail boot
parity (hand: `i1026` phase queued vs waiting; mobx: `i3117` missing), on the
base pages too, so their lifecycle runs fail and they are not in this matrix.
The round-three arms run the same command beside the control when they land.

## Work per change (POD-4746)

THE check that the work a change does does not grow with the amount of data.
It replaces the fixed per-scenario reads budgets below (POD-4557/POD-4609) and
G3's wall-clock slope budget: those budgets were tiny constants that forced
product code to fit the test (duplicate filings and split caches that avoided
counted reads) while missing the real risk. Operator decision I1,
`docs/decisions/pod-4545-round-three-mobx-linear-review.md`.

**The check** (`scale-check.ts`, run by `work-per-change.test.tsx`). Every
fence scenario (#1–#10, `FENCE_SCENARIOS`) runs on a 1x engine and on a 4x
engine, in order, with parity asserted at both. For each scenario and each
count:

    count at 4x − count at 1x ≤ the changed items' neighbourhood at 4x

**The counts**, all from outside the arm:

- **rows**: distinct rows whose DATA the arm read (`ReadStats.data`): a field
  of a borrowed row from the feed, however the arm reached it (for the MobX
  pool, every row its one reader, `MobxPool.row`, hands out is a borrowed row
  or an overlay spread of one), a per-row feed read, or a harness adapter's
  in-place read (the legacy control's store). Ids yielded by a table walk or
  a relation are not rows read: they are elements.
- **derivations**: MobX computed bodies recomputed and reaction bodies run
  (`observer` renders included), by patching `ComputedValue.computeValue_`
  and `Reaction.track` (`work-meter.ts`).
- **elements**: DISTINCT elements the arm iterated: Array/Set/Map iteration
  and `forEach`, the Array callback methods, whole-array methods (`indexOf`,
  `includes`, `sort`, `join`, `slice`, `concat`, …), `Object.keys/values/
  entries`; MobX's observable collections and its observer fan-out count
  through the native ones. Distinct like rows: a family walked by a roll-up,
  a sort and a filter counts once, because repeated passes are a constant
  factor. A Map entry is its key; a primitive other than a string is its
  position. `elementsBy` splits them by the derivation that walked them, to
  name a failure's source.

**Whose work** (`work-meter.ts`). The patches are process-wide; an
`AsyncLocalStorage` side follows the code through awaits and timers. The
scenario write, the feed's drain, React's reconciliation, happy-dom's DOM and
the harness's oracle run outside the arm; the feed's listener calls, a lazy
arm's `settleLoads`, an adapter's derive and every MobX derivation body run
as the arm. React is excluded because the count lane draws every row
(happy-dom has no layout), so React visits every sibling of a redrawn row,
which the browser's window bounds; the exact-commit fence holds what React
redraws.

**The neighbourhood** (`neighbourhood.ts`), read off the store and the oracle's
order before and after the write, never typed in: the rows the step's feed
events name plus the rows whose view the oracle changed, entered or left;
for each such issue (a session stands for its issue) its chain and each
level's children and sessions; and for each one that MOVED in the list
(entered, left, changed section or neighbour, or its section moved among the
sections) every row of the sections it left and entered. A family roll-up or
a scan of the lane a row lands in stays inside it; a walk of the issue table,
a re-sort of the whole list or a copy of a corpus-sized bucket grows by three
times its 1x size and does not.

**Known violations are named allowances** (`roster.ts` `allowances.work`): per
issue that fixes them, the scenarios and counts; the suite fails when an
allowed count passes, so a fix takes its allowance with it.

**Evidence, cells and plants**: `docs/measurements/POD-4746.md` (MobX and
control, old vs new; three planted defects red; the MobX pool's two real
violations, POD-4792 and POD-4757).

**What it cannot see**: an index loop over a plain array, and a walk inside a
closure-held native structure the patches do not reach (a typed array, a
string). A full walk written that way still reads rows, which the rows count
sees; a walk over ids only does not. That stays a review item, like the copy
sweep's blind spots.

## Reads per change (POD-4557)

> **Budgets RETIRED (POD-4746, 2026-09-28).** The shared fence no longer
> asserts the per-scenario budgets below; "Work per change" above replaced
> them. The feed door and the copy sweep stay (the sweep now also sees an arm
> through the borrowed rows it stores, so it needs no door in arm code); the
> table and relation doors and `READ_BUDGETS` stay only while arm-level tests
> still assert them, until POD-4759 removes both. The rest of this section is
> the historical derivation.

Rows committed says how much the screen redrew; it cannot see an arm that
walks the whole corpus to decide which one row to redraw. The reads fence
counts that walk. It is shared code (`shared/src/instrument/reads.ts`), owned
by the harness, and the arm cannot turn it off.

**What is counted.** `readsPerChange` is the number of DISTINCT `entity:id`
rows read between the scenario's reset and the end of its `act` — before the
harness calls `snapshot()` for parity, so the projection is never charged to
the arm. Three doors:

1. **Feed.** `mountArmForCounts` passes the arm's `RowSource` through
   `reads.wrapSource`. Every row value arrives as a borrowed, read-only
   counting proxy; any property read on it, at any later time, counts that
   row.
2. **Tables.** The arm wraps its entity tables with `reads.wrapTables(tables)`
   (a `ReadonlyMap` per entity). `get`/`has` count the id. Every iteration
   (`keys`, `values`, `entries`, `forEach`, `for…of`; array index reads)
   counts every element it yields. Any other member throws. A value that the
   feed did not hand out (a copy) throws.
3. **Relations.** Relation buckets are read only through the shared
   `RelationReader` (`one`, `many`, `size`), wrapped with
   `reads.wrapRelations`. The relation name must be declared in
   `shared/src/schema.ts`. `one` counts its target; `many` counts every id it
   yields; `size` is free.

A refusal throws AND is recorded. The feed swallows a throwing listener
(`row-source.ts` `emit`), so `stats()` re-throws the first recorded violation
for the rest of the fence's life, and a count run on a violating arm fails.

**What a round-three arm must do** (Ma1/Ha1 and later): take the third
`create` argument `reads`; store the borrowed row objects from the feed, never
a copy of their fields; read every entity table through
`reads.wrapTables(...)` and every relation bucket through
`reads.wrapRelations(...)`. Timing entries pass `DISABLED_READ_FENCE`, whose
wrappers are the identity (no proxy cost in the browser) and whose `stats()`
throws, so a count run with the fence off fails instead of reporting zero.

**What the runtime does not close.** An arm that copies each borrowed row
into an object of its own, keeps it in a second container the fence never
wraps, and reads only that is counted once at the copy. L6a (POD-4563) closes
the reachable form with the copy sweep (next section); closure-held copies stay
a review item.
The fence also counts ENTITY rows, not the arm's own derived values: a sort
over cached per-row rank keys reads no entity row, and neither does a walk
over any other per-row cache the arm keeps. That is legitimate for a sort
whose keys are cached (only the moved row's key is recomputed from its row),
and it is also how whole-collection work could hide from this count. The
growth slope across 1x/2x/4x (walls, L5b) and review catch the second case;
this fence does not.

**Budgets.** Fixed here before any round-three arm is measured, in
`READ_BUDGETS` (`count-harness.tsx`). None is re-read on another dimension
after measuring.

| Scenario | Budget (distinct rows read) | Why |
|---|---|---|
| #1 unrelated heartbeat | ≤ 3 | The changed session, and at most its issue and one relation hop. |
| #2 visible phase change | ≤ 3 × (ancestors + 1) (`phaseChangeReadBudget`) | 3 rows per level of the changed session's issue chain: the issue itself plus each ancestor. A roll-up that re-reads a level's siblings grows with the family, not the chain, and fails. |
| #3 selection click | ≤ 3 (corrected from 0, see below) | The selection local plus the engine's own reaction to it: an eager mark-read of the clicked issue, the #9a shape — the clicked issue and at most two rows to place or label it. |
| #4 visible title rename | ≤ 3 | The renamed issue, and at most two rows to place or label it. |
| #5 stage move across groups | ≤ 24 (`stageMoveNeighbourhood`) | The **visible neighbourhood**: the moved row, two neighbours at the old position and two at the new (5), plus the probes of a binary-search placement at 4x (211 visible rows at 1x, so ~850 at 4x: log2 ≈ 10), is 15; rounded up to 24 for a group-header lookup and the closed-fold boundary. A constant: it does not grow with the corpus. A re-sort of the visible collection reads every visible row and fails. |

**#6–#10 (POD-4609).** Fixed before any Phase M arm ran these scenarios,
the way L5a derived its five: from the rows the change necessarily touches,
never from a measured arm. Three terms, each already used above:

- **A level** (`phaseChangeReadBudget`, 3 per level): a roll-up input moved
  at one issue, so that issue and every ancestor re-compose from cached
  child results. Per level: the level's issue and at most two rows to label
  it (a session, the repo). Grows with the chain, never with a family.
- **One placement** (`READ_BUDGETS.placeOne`, 12): one row entering or
  leaving one position: two neighbours, plus the probes of a binary search
  at 4x (844 visible rows or 691 groups at 4x: log2 ≈ 10; a group re-places
  on its first member). #5 counts the same terms for its entering position.
  A constant: flat across 1x/2x/4x.
- **The rows the feed names**: always read; they are the change.

| Scenario | Budget | 1x / 2x / 4x | Derivation |
|---|---|---|---|
| #6a new issue | `newIssueReadBudget()` = level(0) + 1 + `placeOne` | 16 / 16 / 16 | The new issue's own level (the issue, its session, its repo: 3), the new session's lane (`session.worktree` is a prefix relation every session keeps, lazy: false: 1), and the new row entering one position (12). The scenario writes a root, so one level at every scale. |
| #6b archive | `removeOneReadBudget(ancestors)` = level(ancestors) + `placeOne` | 15 / 15 / 15 | The archived row's chain loses its contribution (an archived issue contributes no parent edge, schema `issue.parent` `where`), and the row leaves one position. The target is a childless root by rule (`pickTargets`), so level(0) = 3. A child would surface as a root; the rule rules that out. |
| #6c evict | `removeOneReadBudget(ancestors)` | 15 / 15 / 15 | The same shape through a delete: the stored row (read before it is dropped), its chain, one position. Evict carries no tombstone; dropping the row from its buckets reads nothing. |
| #6d evict keeper | `evictKeeperReadBudget(ancestors)` = level(ancestors) + 2 × `placeOne` | 30 / 30 / 30 | The evicted leaf's chain (the leaf, its rescue parent, their ancestors: 2 levels at every scale), and TWO rows leaving: the leaf and the parent that was visible only through it. Whether the parent still has a member is a `size` (free), not a read. |
| #7 parent reassignment | `parentReassignmentReadBudget(moved, newParent)` = level(moved) + level(newParent) + `placeOne` | 21 / 21 / 21 | The moved row's OLD chain loses its cached subtree roll-up (the row and its old ancestors: 2 levels), the NEW parent's chain gains it (1 level), and one placement (a row that becomes or stops being top-level changes fold eligibility). The subtree moves as one cached value: no descendant is read. |
| #8 clock tick (60 s) | `clockTickReadBudget(crossings)` = crossings × 24 | 0 / 0 / 0 | A local, like #3: the row feed emits nothing; the tick reaches the arm on the locals channel (POD-4608). The only rows a tick re-derives are those whose time-derived fields cross at this tick (a lapsing defer, the finished grace, retention windows); deadlines are derived keys, not entity reads. Each crossing row moves between lanes (or enters or leaves) with no row event: #5's shape, 24 per row. `crossings` is projected BEFORE the write, by the row-view oracle at the advanced clock over the same store (`tickCrossings`). This tick crosses none at any scale. |
| #8b grace crossing (24 h) | `clockTickReadBudget(crossings)` | 144 / 288 / 576 | The same rule. This tick crosses the grace rows, which fold: 6 / 12 / 24 crossings on the reshaped fixture (POD-4560; 4 / 8 / 16 before it). Flat per crossing; the crossings are the corpus's, not N's. An O(visible) walk still fails at every scale (732 / 1,464 / 2,928 visible). |
| #9a press, #9b echo, #9c rejection | `READ_BUDGETS.markRead` = 3 | 3 / 3 / 3 | An own-field change (`readAt`) of one issue that no row-view field reads — the #4 shape: the issue and at most two rows to place or label it. The rejection's two events name the same row; distinct counting makes it one. |
| #10 burst of 50 | `burstReadBudget(ancestors per issue)` = Σ level(ancestorsᵢ) | 168 / 177 / 180 | Fifty #2-shaped changes in one event: each new working session flips `working`/`phase` up its issue's chain. The sum of the #2 budget over the fifty chains; distinct counting only lowers it where chains share ancestors. No placement term: `rankOf` reads no activity. Bounded by fifty chains, not by N: at 4x, 180 against 2,928 visible rows. |

The per-scale values are what `FENCE_SCENARIOS` computes from the targets
before each write (#10 after #6–#7 reshaped the tree). #10 moves with the
depth of the fifty burst issues' chains (56, 59 and 60 levels at the step), not with the
corpus.

**Re-derived on the reshaped fixture (POD-4560, 2026-09-23, at `fe1745142`).**
POD-4635 (L2d) reshaped the fixture to the live workspace: 732 / 1,464 /
2,928 visible rows (open lanes 664 / 1,329 / 2,657, closed folds 68 / 135 /
271), 4,867 / 9,734 / 19,468 issues. Every value in the table above is what
`runFenceStep` computes there: each entry's `readsBudget(ctx)` taken before its
write, in `FENCE_SCENARIOS` order on one `startScenarioEngine(scale)` engine,
the writes applied as the step applies them (the budget reads only the engine
and the targets, never the arm). Only #8b (crossings 6 / 12 / 24, was 4 / 8 /
16) and #10 (levels 56 / 59 / 60, was 57 / 65 / 81) moved; #1–#8 and #9 are
the same at every scale. The old #8b (96 / 192 / 384) and #10 (171 / 195 /
243) are superseded. OPEN (sent to the coordinator, not changed here): the
placement terms were derived from ~850 visible rows at 4x (log2 ≈ 10); at
2,928 the binary search is log2 ≈ 11.5, so `placeOne` (12) and #5's
`stageMoveNeighbourhood` (24, from 15) rest on an old row count. Neither is
re-read here (pitfall g).

`assertReads(result, { readsPerChange })` throws with the per-entity
breakdown when the budget is exceeded, and also when the result has no reads
cell (fence disabled): a missing cell fails, never passes.

**The legacy control fails it.** `legacyControlArmFor` reads its store
through the fence (`legacy-control/fenced-store.ts`). The one corpus at 1x
(`startScenarioEngine(1)`): 4,867 issues, 4,304 sessions, 500 lanes. Measured
on the fixture BEFORE the POD-4635 reshape (not re-measured by POD-4560), 2026-09-22 at `da7e6c1b3` on this branch (`control.test.tsx`; happy-dom
counts, which box load does not move).

| Scenario | Legacy reads | Of which | Budget |
|---|---|---|---|
| #1 unrelated heartbeat | 9,671 | 4,867 issues, 4,304 sessions, 500 lanes | 3 |
| #2 visible phase change | 9,920 | the same plus 249 dep edges | 3 × (ancestors + 1) |
| #3 selection click | 9,920 | the same (the eager mark-read row republishes) | 3 (was 0) |
| #4 visible title rename | 9,671 | 4,867 issues, 4,304 sessions, 500 lanes | 3 |
| #5 stage move | 9,920 | 4,867 issues, 4,304 sessions, 500 lanes, 249 dep edges | 24 |

Every scenario reads the whole corpus: the derive is whole-world.
`control.test.tsx` asserts the heartbeat reads exactly every session and every
issue and that `assertReads` throws; a second case asserts all five scenarios
exceed their budgets; a third asserts that the fence changes nothing the
control does (rows committed, commits by row and `ArmStats` equal with the
fence on and off; parity true in both).

The adapter adds one thing in count runs only. The derive walks issues as
view models that the replica view cache owns privately, so no outside wrapper
can reach them. `fenced-store.ts` wraps `issues` and `issueProjections` fresh
per store snapshot. The cache then runs its per-snapshot identity pass over
every issue row (counted), reuses every unchanged model, and returns the same
array. That is one extra O(N) identity pass per derive, with the same output.

**Both directions** (`harness/src/reads-probe.test.tsx`, real engine, the
same mount path an arm takes). Three probe arms differ in one dimension:
- reads the changed session and its issue by id: 2 rows, `assertReads`
  passes;
- the same plus one walk over the sessions table: every session (4,304 at
  1x), throws;
- stores copies instead of borrowed rows: the count run throws on the sticky
  violation, although the feed swallowed the original throw.

`count-harness.test.ts` guards `assertReads` both ways on synthetic results,
plus the missing-cell rule. `shared/src/instrument/reads.test.ts` covers each
door and each refusal.

**#6–#10 in both directions (POD-4609).**

*NO — the legacy control exceeds every one.* `control.test.tsx` runs every
fence scenario in order with the budget each computes, and asserts that each
#6–#10 step reads at least the whole corpus and that `assertReads` throws.
Measured at 1x on this branch (happy-dom counts, 2026-09-22):

| Scenario | Legacy reads | Budget |
|---|---|---|
| #6a new issue | 9,922 | 16 |
| #6b archive | 9,922 | 15 |
| #6c evict | 9,921 | 15 |
| #6d evict keeper | 9,920 | 30 |
| #7 parent reassignment | 9,920 | 21 |
| #8 clock tick | 9,920 (the store publishes; the row feed emits nothing) | 0 |
| #8b grace crossing | 9,669 | 96 |
| #9a / #9b / #9c | 9,669 / 9,669 / 9,920 | 3 |
| #10 burst | 9,719 | 171 |

At 2x and 4x the control reads 19,338–19,880 and 38,676–39,752 on the same
steps (a one-off measurement, not a test).

*YES — the reference arm cannot carry it; a shape arm does.* The L6a
reference arm reads the engine store, never the feed or a fenced table: its
reads cell is 0 on every step (pinned in `fences.test.tsx`). It would meet
any budget blind, so it is the wrong arm for this fence (by design: it is
exempt and not a candidate), not evidence that the budgets are right.
`harness/src/reads-budgets.test.tsx` (deleted with the budgets by POD-4746) carried the YES instead: a probe arm
that stores the borrowed rows, reads them only through `wrapTables` and
`wrapRelations`, and on each event does exactly the reads the derivations
name — the named rows, the chains it climbs through `issue.parent`, the
neighbours it reads to leave a position, and a binary search that READS
every probed row to enter one. At 1x, 2x and 4x it meets every #6–#10 budget,
and each cell is at least the rows the change names (not a blind 0):

| Scale | #6a | #6b | #6c | #6d | #7 | #8 | #8b | #9a/b/c | #10 |
|---|---|---|---|---|---|---|---|---|---|
| 1x | 3/16 | 1/15 | 2/15 | 3/30 | 3/21 | 0/0 | 6/96 | 1/3 | 108/171 |
| 2x | 4/16 | 1/15 | 2/15 | 2/30 | 3/21 | 0/0 | 11/192 | 1/3 | 116/195 |
| 4x | 5/16 | 1/15 | 2/15 | 3/30 | 3/21 | 0/0 | 24/384 | 1/3 | 132/243 |

For the ticks the arm keeps each open-lane closure's fold deadline
(`issueFinishedAt` + 24 h) as a derived key and, on a clock notification,
reads and moves only the rows whose deadline passed. The test also holds each
tick's projected crossings to what the tick did (0 for #8; 4, 8, 16 for #8b).
The same arm plus ONE walk over the issue table per notification (a row event
or a locals change) fails every #6–#10 budget, the ticks included (1x: 4,866
to 4,919 rows read).

**Step isolation: every step settles its own writes** (POD-4618, replacing
POD-4609's frozen `Date`). The #3 click's eager mark-read used to be
acknowledged by the scenario server and never echoed as truth, so the runtime
kept it awaiting truth until its 60 s WALL-CLOCK sweep
(`AWAITING_TRUTH_TTL_MS`, `client-core/src/engine/overlay.ts`), which retired
it in whichever step was running then: at 4x it landed in #6b, #7 or #8, and
in #8 it read 1 against a budget of 0. That row is #3's, not the step's.
POD-4609 froze `Date` to hide it; a frozen clock hides exactly the clock
behaviour the fences exist to check, so the freeze is gone. Now:

- every scenario write's settle has the server acknowledge AND echo, within
  the step, each mark-read the write provoked (`scenarios.ts`, `settled`):
  `readAt` at the server's clock. Only the #9a press is left for #9b to echo;
- `runFenceStep` refuses a step that leaves the runtime's optimism ledger
  (`pendingOverlaysByRow`: queued, in flight or awaiting truth) holding a write
  the step does not declare (`leavesPending`, #9a only). With the echo removed
  it fails at #3 (`left writes pending: [issues:i17]`); it also caught #10 at
  1x, where the burst gives the still-selected row new activity and the
  runtime marks it read again;
- the shape-arm runs keep the real clock and assert that no step writing no
  read cursor (#1, #2, #4–#8b) moves one, and report how long the run went on
  after #3.

**Feeds changed:** #3 is 2 events (the painted read, then the server's echo)
where it was 1. At 1x and 2x #10 is 2 events too: the burst gives the
still-selected row new activity, the runtime marks it read again, and the
server echoes that within #10 (at 4x the clicked row is not a burst target, so
#10 stays 1). No reads cell moved (the table above holds at every scale): each
pair of events names the same row.

Evidence, 4x, real clock, three interleaved rounds against a control (the old
code with only the freeze removed), 2026-09-23: fixed green 3/3, #3's row
moving only in #3, #8 reading 0, 114–141 s of run after the click; control red
3/3, #3's row moving in #8 (twice, reading 1 against 0) and in #7. Every other
cell was identical in both arms.

**#3 corrected: 0 → 3** (POD-4609, coordinator ruling on POD-4619,
2026-09-22). L5a derived 0 from "selection is a local; no table read". That
derivation was wrong: the engine reacts to a selection by marking the
clicked issue read, so the click's feed event names the clicked row
(`issue:<visibleRootId>`, at every scale; since POD-4618 a second event, the
server's echo, names it again), and no arm that reads the
rows its events name could meet 0. A click is a local change plus a
mark-read of the clicked row: the #9a shape, 3. This is a correction of a
derivation made BEFORE any candidate arm was measured on #3 (the roster was
empty), so it does not re-read a budget after measurement. Both directions:
the shape arm reads 1 on #3 at 1x, 2x and 4x (`reads-budgets.test.tsx`, now
in its budgeted set, with 1 as the named-row floor); the legacy control
reads 9,920 and fails it (`control.test.tsx`); the shape arm plus one table
walk fails it.

```bash
bun run test:file -- packages/worklist-proto/shared/src/instrument/reads.test.ts \
  packages/worklist-proto/harness/src/count-harness.test.ts \
  packages/worklist-proto/harness/src/reads-probe.test.tsx \
  packages/worklist-proto/harness/src/legacy-control/control.test.tsx \
  packages/worklist-proto/harness/src/work-meter.test.ts \
  packages/worklist-proto/harness/src/neighbourhood.test.ts \
  packages/worklist-proto/harness/src/work-per-change.test.tsx
```

## Exact commits, the copy sweep and the lint fence (POD-4563)

Three fences every round-three arm meets identically, each proven to fail.

**Exact commits** (`assertCommits`, `harness/src/count-harness.tsx`). The rows
an arm redraws must EQUAL the rows whose row view changed: set equality, no
allowance list. The oracle is the row-view oracle
(`harness/src/oracle/row-views.ts`): every `RowView` field, projected from the
same legacy derivation as parity (the `SliceRow` half IS the parity row;
`selected`, the origin tick, `activityAt`, `workingSince` and the placement
inputs cite their legacy source). A `CountInput` supplies it as `views()`; the
harness calls it before and after the change and compares rows visible in
both. "Redrew" is a non-mount commit, or a REmount of a row visible before and
after (the commit log now records mounts). Over-commit is the work round two
hid behind "≤ budget"; under-commit is a stale screen parity cannot see,
because parity reads `snapshot()`, not what was drawn. No `views` = no commit
cell = the assertion throws. Round two's `allowOver` list (the #4 origin tick)
is gone: the tick is a view field.

`harness/src/fence-scenarios.ts` is the one scenario list (#1–#10 with the #9
steps and #8b, one engine, methodology order; row-view locals come from the
engine's selection and clock). Every fenced arm gets its feeds from
`openFenceFeeds`: the row source and the engine-backed LOCALS CHANNEL
(POD-4608, `LocalsSource` in `shared/src/arm.ts`), which notifies with the
keys that moved — `{selectedIssueId}` on the #3 click, `{coarseNow}` on a
tick, nothing on a row write. #8b ticks 24 h across the finished-grace
boundary, because the methodology #8 tick moves no view and so cannot fail an
arm deaf to the clock. `harness/src/fences.test.tsx` runs it:

- the REFERENCE arm (`harness/src/reference-arm/`: the oracle drawn through
  memoised `RowShell` rows) passes `assertCommits` on every step — the fence
  can say YES through a real React tree; `#2 #3 #4 #5 #7 #10` must change at
  least one visible row, so the pass is not 0 == 0. At 1x (seed 4443),
  changed = drawn: #2 1, #3 1, #4 1, #5 1, #7 2, #8b 4, #10 54, every other
  step 0. The locals channel notified on #3, #8 and #8b only, with only their
  own keys (asserted).
- every arm in `harness/src/roster.ts` must pass, on every step, the exact
  commit fence, parity, the reads budget (every step has one), and the copy
  sweep. The roster must name exactly the `arms/*` folders with a
  `fence.json`.
- the NO: the legacy control fails `assertCommits` on the heartbeat
  (`control.test.tsx`: changed 0, drawn every visible row).
- PLANTED ARMS (`harness/src/fences.planted.test.tsx`, `ReferencePlant` in the
  reference arm), each red with parity green: an unmemoised slot (#1: over,
  all 211 rows), a stale view (#2: under=[i17]), a remount per render (#1:
  over via 211 remounts, `rowsCommitted` 0 — and on the same run round two's
  `assertIsolation` passes, asserted), and an arm deaf to the locals channel
  (#3: under=[i17] with the notification delivered; #8b: under=the 4 grace
  rows) — each beside the same step passing when the arm follows the
  channel. Armed: removing the remount-to-redraw
  line reddens the remount test; forcing `over` empty reddens the unmemoised
  and remount tests; forcing `under` empty reddens the stale test.

**Which stamps are compared** (coordinator, from L4a: mark-read overlays
stamp `Date.now()`, so a PAINTED `readAt` differs between runs).

| stamp | compared? | where it comes from |
|---|---|---|
| `activityAt` (row view) | yes | sessions' `lastActiveAt`, else the issue's `updatedAt`: scenario writes stamp both from the corpus clock (`ctx.stamp()`), server truth |
| `workingSince` (row view) | yes | `agentState.since` / `lastActiveAt`, corpus clock |
| `foldAt` (row view) | yes | `tuckedAt ?? closedAt ?? updatedAt`, corpus clock |
| `createdAt` (row view) | yes | immutable |
| `readAt`, `unread` | NO | no row-view or `SliceRow` field carries them. A painted `readAt` reaches a comparison only through legacy visibility of FINISHED child issues (the read-grace anchor); the #9 target is an open root |

Proved, not argued: `fences.test.tsx` "wall-clock independence of the #9
steps" runs #9a–#9c under system clocks of 2026-09-21 and 2031-03-01, asserts
the painted `readAt` really differs (it carries each clock), and requires
identical row views, cells and parity in both.

**The copy sweep** (`fence.assertNoCopies(handle)`, `shared/src/instrument/
reads.ts`). Walks everything reachable from the arm handle by reflection (own
data properties, symbol keys, Map/Set entries; never a getter, never a
borrowed row or a fenced table) and fails on an object carrying a fed row's key
plus two or more of that row's own values outside the row-view vocabulary —
a copy the reads fence would count once and never again. It also fails when it
reaches no wrapped table: then it is blind, and silence is not a pass. It
cannot see closures, `#private` fields or weak collections; the lint forbids
module-scope state and `#private` fields, and closures stay a review item, as
do walks over an arm's own per-row caches.

**The lint fence** (`harness/lint/`, README there). One ESLint plugin over
every folder under `arms/` (frozen round-two `hand`/`mobx` get only the
wall-clock rule): a manifest per arm (`fence.json`: exactly one enumeration
module, named in the arm README), no table walk outside it, no store reached
from a component or row module by value import (transitively, chain named),
the `RowShell` component a module-scope identifier, no `Date.now` in `arms/`,
no module-scope state or `#private` fields. `bun run lint` in the package runs
it; `fence-lint.test.ts` runs in the test lane, plants each mistake next to its
clean twin, and lints the real `arms/` through the package config.

```bash
bun run test:file -- packages/worklist-proto/harness/src/fences.test.tsx \
  packages/worklist-proto/harness/src/fences.planted.test.tsx \
  packages/worklist-proto/harness/lint/fence-lint.test.ts \
  packages/worklist-proto/harness/src/count-harness.test.ts \
  packages/worklist-proto/harness/src/legacy-control/control.test.tsx \
  packages/worklist-proto/shared/src/instrument/reads.test.ts \
  packages/worklist-proto/harness/src/oracle/row-views.test.ts
```

## The correctness gate (POD-4556)

After every generated change, an arm's incremental state must equal a rebuild
of the same arm from scratch and the legacy oracle.

`checkArm(arm, sequence, opts)` (`shared/src/gen/check.ts`) boots the
generator's engine (`shared/src/gen/run.ts`, POD-4555), creates the arm over
the per-row feed and applies the sequence one change at a time. After the
bootstrap (`step: -1`) and after every settled step it compares:

| Comparison | Against | When (default) |
|---|---|---|
| `snapshot()` vs `rebuildFromScratch()` | the arm recomputed from the feed's CURRENT `snapshot(kind)` tables, so a change the feed never announces (discovery-only worktrees, POD-4606) still shows | every step (`rebuildEvery: 1`) |
| `snapshot()` vs `oracleSnapshot(store)` | the legacy derivation over the engine store (the app's paint), derived AND projected with the engine's own clock | every 10 steps and after the last (`oracleEvery: 10`) |

It compares the whole `SliceSnapshot`: every row's fields, the pinned ids,
and each group's key, label, row ids and closed ids, all order-sensitive.
`SliceSnapshot` carries no `readAt`, so the painted wall-clock stamp of a
pending mark-read (POD-4555 finding 5) is never compared. The first
divergence stops the run. The failing prefix is shrunk (`shrink.ts`, with
"the checker fails" as the predicate), and the result carries
`{ step, change, against, diff, shrunk, shrunkDivergence }`. Quote the shrunk
sequence in a report, not the raw run.

**Contract.** A checked arm is a `CheckableArm` (`shared/src/arm.ts`). Its
handle adds `rebuildFromScratch()`, which reads the feed's current tables and
`locals.get()`, and must read no incremental state and write none. The roster
(`harness/src/roster.ts`) requires a `CheckableArm`, so a round-three arm
without it is a type error. The checker hands the arm the engine-backed locals
channel (`createEngineLocals`, POD-4608), so a tick reaches the arm only there.
A `refresh` is a new page: the checker disposes the arm and creates a new one
over the new engine's feed and locals. An arm that closes over the engine is
therefore passed as a factory (`(ctx) => arm`). `mode` names the feed (default `overlaid`). A `truth` arm
owns its optimism and must still match the overlaid oracle.

**Sampling.** `rebuildEvery`/`oracleEvery` above 1 compare at checkpoints
only. A failure is then re-run densely over its prefix, so the step it names
is exact. A divergence that heals itself between two checkpoints goes unseen.
Sample only an arm whose snapshot or rebuild is expensive. The legacy control
is one: both are a whole legacy derivation.

**The control.** `legacyControlArmFor` is checkable. Its
`rebuildFromScratch()` is `rebuiltSnapshotFromStore`: the same derivation and
projection over copied collections and a fresh stub replica, so the
per-replica view-model cache starts empty. What it checks is the legacy cache
plumbing, not the rules. Until POD-4608 the control projected with its
create-time `locals.coarseNow` while the derivation read the engine's clock:
after a 25 h tick, rows the oracle closes kept `closed: false`. That
behaviour (reading `locals.get()` once, at creation) is the planted defect
below. `snapshotFromStore` still projects with the caller's clock, so a
caller whose clock differs from the engine's gets two clocks. The oracle here
is `oracleSnapshot`, which takes both from the store.

### Proof that it can fail (`shared/src/gen/check.test.ts`)

Measured at `407389b1a`, which became `a7450c223` when rebased onto `9279c2974` (that commit touched only native test files; the later biome pass is formatting). Corpus 1x (seed 4443).

| Subject | Run | Result |
|---|---|---|
| Tiny reference arm (a pool over the feed with one index, sessions by issue; output is not the worklist, so `oracleEvery: 0`) | `gen(7, 200)`, default weights | correct: pass, 201 rebuild checks, 1 reload |
| same, PLANTED: a removed session stays in its issue's bucket | same run | red at step 121 `remove session s875`, against the rebuild (`progressTotal` one too high on its issue's row). Shrunk in 18 runs to **1 step**: `[remove session s875]`. The correct arm passes the shrunk sequence |
| Legacy control, checkpoints every 10 | `gen(3, 120)` | correct: pass, 13 rebuild + 13 oracle checks, 1 reload. It crosses a 25 h tick, so the pass also shows the checker delivers the clock |
| same, PLANTED: reads `locals.get()` once, at creation | same run | noticed at the step-39 checkpoint, named at step 33 `clockTick 25 h` (the dense re-run), against the rebuild: 5 rows `closed: false (expected true)`, and group row and closed ids moved. Shrunk in 15 runs to **1 step**: `[clockTick 90000000]`. The correct control passes it |
| same, PLANTED stale in BOTH snapshot and rebuild (self-consistent) | same run | passes its own rebuild; red against the **oracle** at step 33, shrunk to the same single tick |

Mutations of `check.ts`, each planted alone and restored with `cp`. Each
turned the named test red:

| Mutation | Went red |
|---|---|
| the arm gets frozen locals (`fixedLocals`) instead of the engine's | the correct control: "rows differing (5)" |
| no dense re-run after a sampled failure | the planted control reports the checkpoint's step (`offline`), not `clockTick` |
| rebuild comparison always equal | "the planted bucket leak passed the checker" |

### The CI-sized run

20 seeds × 300 steps at 1x on the legacy control, rebuild and oracle
compared every 10 steps. It is split over four shard files, five seeds each
(`shared/src/gen/check-ci-{1..4}.test.ts`, one runner in `check-ci.ts`).
Opt-in: it runs for minutes. `test:file` runs one worker unless told
otherwise, so the shards need `PODIUM_TEST_WORKERS=4` to run in parallel:

```sh
POD_CHECK_CI=1 PODIUM_TEST_WORKERS=4 bun scripts/test-heavy.ts -- -- bun run test:file -- \
  packages/worklist-proto/shared/src/gen/check-ci-1.test.ts \
  packages/worklist-proto/shared/src/gen/check-ci-2.test.ts \
  packages/worklist-proto/shared/src/gen/check-ci-3.test.ts \
  packages/worklist-proto/shared/src/gen/check-ci-4.test.ts
```

(`test-heavy.ts` eats the first `--`; with one, it tries to execute the test
path.) Each shard asserts it finished in under 5 minutes. Per-seed counts and
times land in `harness/browser/results/check-ci-<n>.json`.

As of `407389b1a` (now `a7450c223`): **all 20 seeds pass**. Totals: 6,000 steps, 10 skipped
by the runner (target gone), 128 arms created (20 at boot, 108 on reloads),
620 rebuild and 620 oracle checks. **Wall 125 s** (the command's Duration;
the shards took 111, 113, 111 and 114 s). Load was 10.5 at the start and
13.9 at the end, so the wall is an upper bound, not a timing result. On one
worker the same run took 348 s (at `6d68b602c`, before the rebase). Summed
over the shards, the time went: apply 114 s, snapshot 124 s, rebuild 126 s,
oracle 81 s. That is ~0.2 s per control snapshot and per rebuild at this
load. Comparing every step would cost ~0.4 s a step, over 30 minutes, which
is why the control samples.

A round-three arm's snapshot is incremental and its rebuild is a pool
rebuild. The tiny arm's cost 14 ms and 25 ms a step at 1x, so run it with the
defaults:
`checkArm(entry.armFor, gen(seed, 300), { mode: entry.mode })`.

## The control and what its failure looks like

`legacyControlArmFor(engine)` reads the published `worklistSlice` through the
published-slice mechanism and renders groups and rows in the pre-Stage-0 shape:
unmemoized rows, whole `issues`/`sessions` arrays as props, fresh closures,
own O(N) scans, unwindowed, legacy nesting (formal children commit with their
parent — the slice is flat, the rendering is not). `snapshot()` projects the
live slice with the oracle's own projection, so parity passes exactly.
`ArmStats` are honest whole-world numbers: `rowsDerived` = visible rows per
derive, `rollupsDerived` = derives, `indexUpdates` = 0 (no incremental index —
zero is the finding), `notifications` = publications observed.

The armed failure (numbers below are from the retired SMALL corpus; the
fixture's are in the POD-4550 section of `packages/worklist-proto/NOTES.md`
and in `control-1x.test.tsx`, which pins 211 visible rows at 1x):

```
[control] heartbeat committed 39/37 visible rows;
  stats={"rowsDerived":41,"rollupsDerived":1,"indexUpdates":0,"notifications":1} parity=true
[isolation] unrelatedHeartbeat (#1): committed 39 rows, budget 0. ...
```

One publish, one whole-world derive, every row commits — including rows the
heartbeat cannot affect (the session belongs to an archived issue). That throw
is the detector proving it can say NO. Never weaken the test; a green run
without a control change means the detector is blind.

## Measurement hygiene (methodology §5.7, mandatory)

- `uptime` first. 1-minute load above 8: counts only, say so, publish no walls.
- Counts do not move with machine load and are the stronger evidence; wall
  times are the contaminated ones. Do not sum overlapping CPU buckets.
- Bench lease around timing phases only; release between scenarios; record
  uptime with every record; interleave (rotate) arms and scales.
- Record corpus counts and the commit SHA in every JSON.
- If Playwright cannot launch Chromium on the box, stop; never substitute
  happy-dom for browser numbers.

## Native lane

`harness/native/control.native.test.tsx` mounts `mountNative()` (RN
`View`/`Text`/`ScrollView`) under the package config, where `react-native`
resolves to `react-native-web`. Excluded from the root node/unit lanes
(`nodeTestExclude` — the POD-1220 Flow hazard); runs via
`bun run --filter @podium/worklist-proto test`. Same scenarios, same
assertion, same heartbeat failure shape as web (39/37 at SMALL).

## Growth test (POD-4747)

G6 compared cold start and heap to 1.1× the legacy control. The growth test
judges each arm against itself as the workspace grows along its two axes
(methodology §1a, revised 2026-09-28). The corpus is `buildCorpusCell`
(`harness/src/fixture/corpus.ts`; its axes proven in `cells.test.ts`); the
driver takes `--cell h10a1` and the matrix `--cells`:

```bash
# on flatblock, the checkout at the commit being timed, dist built there
bun --conditions=@podium/source packages/worklist-proto/harness/browser/matrix.ts \
  --host flatblock --remote-dir <checkout> \
  --arms noop,control,mobx,noop+hold:1 --cells h1a1,h10a1,h1a4 --rounds 4 --samples 5 \
  --scenarios heartbeat,visibleHeartbeat,rename,stagemove,clock,click,coldBootstrap,principalSwitch \
  --tag growth
bun --conditions=@podium/source packages/worklist-proto/harness/browser/growth.ts \
  packages/worklist-proto/harness/browser/results/growth
```

(Every driver imports the fixture, whose workspace packages resolve only to
source: run them with `--conditions=@podium/source`; the matrix passes it to
each `run.ts`.)

| Check | Cells | Passes when |
|---|---|---|
| history flat | `h1a1` → `h10a1` | the arm's retained heap (coldBootstrap `heapAfter − heapBefore`) and cold start (`actionMs`) grow by no more than the tolerance |
| active linear | `h1a1` → `h1a4` | the same metrics at `h1a4` ≤ 4 × their `h1a1` value + the tolerance |
| active flat (walls) | `h1a1` → `h1a4` | each hot-path wall, as the arm's per-round median minus the no-op's in the same round, grows by no more than the tolerance (the no-op's own wall is the kernel write and the feed: reported under `engine`); the history axis is judged the same way |
| switch vs cold (reported) | each cell | principalSwitch `heapAfter` against coldBootstrap `heapAfter`; never an arm failure: the two pages differ by more than the arm (the floor's switched page holds 2.2 MB less than its cold page at 1x). The leak gate is the driver's survivor check |

**Tolerance, from repeated runs.** Each check's tolerance is the larger spread
(max − min) of the per-round medians of the two series it compares: two
cells are "flat" when they differ by less than one cell differs from itself
across rounds. `growth.ts` refuses fewer than three rounds, a missing or
failed run, a short cell, two machines or two runtime SHAs. The booted page
before any arm (`heapBefore`, `engineMs`) is reported as `engine`, never as an
arm: it holds the fixture, the kernel's rows and indexes and the runtime, and
grows with history by spec until the memory cutoff exists.

**Can say NO.** `noop+hold:1` keeps one small object per known issue: its
retained heap must fail history ×10 while the plain floor passes (the summary
prints `PLANT NOT CAUGHT` otherwise); `growth.test.ts` proves every check
fails its planted shape (a heap that grows, a superlinear arm, a wall above
the floor, a switch that holds more than a cold build, marked as a report).

**The floor's rows (changed here).** The no-op draws the oracle's first window
over the boot store. Before POD-4747 it derived those rows inside `create`,
so a lifecycle step charged the floor a legacy derivation over every issue;
they are now derived once at page boot (`noopFrozenRows`, untimed), and a
floor build is only what building any arm costs.

**Memory by layer** (`harness/browser/layers.ts`, heap only, not timing):
one held `?layers=1` page per (arm, cell) stops at each boot stage (the
bundle, the fixture, the durable cache, the kernel replica and runtime, the
arm); at each the driver reads the forced-GC heap and takes a V8 heap
snapshot, and a layer is what its stage added, by constructor (objects new
since the previous snapshot: heap object ids only grow). A layers page gives
the kernel its own copy of each row (`ownRows`), as a kernel decoding its disk
holds; timing pages hand it the fixture's objects. The pages must be the
unminified build (`PROTO_LAYERS=1`, into `dist-layers`), so every class keeps
its source name.
