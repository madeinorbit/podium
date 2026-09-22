# worklist-proto — package notes

## POD-4563 (L6a) — equal commit and lint fences · 2026-09-22

What landed and how each is proven: `docs/plans/pod-4441-harness.md`, "Exact
commits, the copy sweep and the lint fence".

### Decisions

- **The commit oracle is the ROW VIEW, not `SliceSnapshot`.** Set equality
  with an empty allowance list is only honest against every field a row
  draws; `SliceSnapshot` omits selection, the origin tick and the stamps
  (round two's `allowOver`). New `harness/src/oracle/row-views.ts`; the L1b
  differential test now reads its views from it.
- **A remount of a row visible before and after counts as a redraw.** Without
  it a list that remounts every row on every change commits nothing and passes.
  Kept as a planted arm (`fences.planted.test.tsx`, coordinator review): it
  fails the new fence and passes round two's isolation fence on the same run,
  and removing the remount-to-redraw line turns that test red. The commit log
  records mounts; `CommitBoundary` reports them.
- **Rows entering or leaving are not compared** (a mount is not a redraw).
- **Under happy-dom an arm must draw every visible row** (no layout: the
  round-two lists already degrade to a full render). A windowing arm that
  drew fewer would read as under-commit.
- **Row-view locals come from the engine** (`selectedIssueId`, `coarseNow`),
  because #3 and #8 are engine writes. Parity stays the unselected baseline.
- **No new reads budgets.** L5a fixed #1–#5; #6–#10 carry none, and this issue
  did not invent any (pitfall g).
- **Copy sweep threshold:** key + 2 raw field values outside the row-view
  vocabulary. A RowView shares title/seq/createdAt/sortKey/pinned by contract,
  hence the exemption list.
- **Lint scope:** every folder under `arms/` except frozen `hand`/`mobx`; a
  new folder without `fence.json` is red, and a `fence.json` without a roster
  entry is red in `fences.test.tsx`, so an arm cannot skip either fence.

### Open questions (for the coordinator)

1. `ArmHandle`/`Arm.create` has no channel for locals after creation. The
   fence's #3 (selection) and #8 (clock tick) expect the rows the ENGINE's
   selection and clock change; a round-three arm cannot follow them through
   the contract as it stands. Needs a contract decision before Ma1/Ha1 run
   the fence (a locals subscription on the create call, or a `setLocals`).
2. `RowView.workingSince` cites `workingSinceMs`, which has no production
   caller in the web app (only its own test). The oracle mirrors the function
   over the row's own working seats.
3. The fence suite is web-lane only; the native lane (`harness/native/`) has
   no row-view oracle wiring yet.

## POD-4550 (L2a) — one corpus everywhere · 2026-09-22

### What changed

- `shared/src/scenarios.ts` seeds from `buildCorpus(scale, FIXTURE_SEED)`. Gone:
  `CorpusSpec`, `SMALL_CORPUS`, `GROWTH_CORPORA`, `seedCorpus`, `scenarioRepos`,
  the hand-seeded keeper pair (`seedKeeperPair`, `KEEPER_*`).
- Scenario functions take a fixture scale (`1 | 2 | 4`, default 1).
- `harness/src/scenario-writes.ts` folded into the library: each write exists
  once, as `write*` (settles; count runs) over `apply*` (synchronous; the web
  pages time this half). Scenario functions are "boot, one write under a row
  source".
- `harness/src/engine-bootstrap.ts` folded into the library as
  `startEngineOnCorpus` (the one boot path for scenarios, count runs, web
  entries).
- `ScenarioCache` is a `Map` keyed `entity:id`: `read`/`put`/`drop` O(1);
  `records` materialised on demand.
- Targets picked by rule (`pickTargets`), exposed on `ScenarioEngine.targets`
  and `ScenarioResult.targets`; each checked against the oracle in
  `scenarios.test.ts`. Rules: `docs/plans/pod-4441-harness.md` "One corpus".
- Clock: new runtime seam `coarseClock` (client-core `runtime.ts`). The scenario
  engine pins it to `FIXED_NOW` and `writeClockTick` advances it through the
  runtime's own tick path. Scenario #8 used to synthesise
  `after.coarseNow = before.coarseNow + 60_000` without touching the engine.
- `arms/tanstack/` deleted with its native test, web entry, tsconfig include,
  vite input, driver arm, and the `@tanstack/db` / `@tanstack/react-db`
  dependencies of this package (other packages' TanStack use is untouched).
- Fixture: `corpus.unscannedWorktree` (handover from POD-4546; see below).
- Fixture: sibling sort keys (POD-4547's request, relayed by the coordinator;
  see below).

### Decisions

- **Engine clock = corpus clock.** The engine used to seed `coarseNow` from the
  wall clock, so engine-backed counts drifted with the date the test ran (the
  mobx clock test's "+60d is the smallest jump that moves rows, probed
  2026-09-21" was a wall-clock fact). Engine-backed runs and the oracle now
  read the same `FIXED_NOW`. Writes stamp rows from that clock too
  (`ctx.stamp()`, strictly increasing), never `new Date()`.
- **#6d uses the fixture's own rescue pairs.** The fixture has ten; the rule
  picks an open leaf that is the only child of a sessionless backlog parent
  (at seed 4443, 1x: `i5` under `i326`). The oracle test proves that
  evicting it drops the parent.
- **#1 heartbeat target.** No fixture session is bound to an archived or
  deleted issue, so the rule is "session on a closed, childless agent root".
  The oracle test proves the bound issue is not visible.
- **Browser pages use the library's writes and targets**: heartbeat, rename and
  click aim at the rule-picked targets; stagemove still moves a fresh open row
  per sample, now through `applyStageMove`. FINDING: the page's heartbeat used
  to bump `sessions[0]`, a session on a VISIBLE vWork root, so the browser
  "unrelated heartbeat" was never unrelated. L5c owns the driver and should
  re-read that number.
- **Unscanned worktree case (POD-4546 handover).** The last `vSessless` root
  gets `worktreePath = /w/unscanned-<id>`, in no repo's `worktrees` and in no
  session's cwd; the first live working orphan session moves to
  `<path>/sub`. Nothing else in the fixture changes: the transform draws no
  random numbers. The row reads `working` only through that seat. The oracle
  seats it; moving the orphan away turns it off (both asserted in
  `oracle.test.ts`). Visible count at 1x: still 211.

- **#2 root rule is effect-stable across scales.** A first rule ("root with a
  live working session") picked roots whose row stays `working` through a
  child's or a prefix-seated session at 2x/4x, so #2 committed 1 row at 1x
  and 0 at 2x/4x: the flatness gate compared different workloads. The rule
  now requires exactly one working session in the root's whole subtree, and
  `scenarios.test.ts` proves with the oracle that #2 changes the root's row
  at 1x, 2x and 4x.
- **Sort keys (R-ORDER step 2).** At 1x the worklist shows ~24 sibling groups
  of two or more rows (children of one parent, or roots sharing a repo
  group). In each, the oldest row gets key `a0` (jumps ahead of newer
  unkeyed siblings); in groups of three or more the second-oldest gets `a1`
  (keyed order against creation order); every third vWork root is keyed for
  share. 56/211 visible rows keyed. rng-free. Control: stripping every key
  changes the oracle order, so an implementation ignoring `sortKey` fails
  parity (`oracle.test.ts`, "manual sort keys among siblings").

### Targets (seed 4443)

| scale | heartbeat | root / phase session | stage | archive | evict | keeper leaf / parent | reparent | mark-read |
|---|---|---|---|---|---|---|---|---|
| 1x | s2135 | i17 / s34 | i11 | i44 | i47 | i5 / i326 | i85 → i17 | i54 |
| 2x | s4288 | i39 / s78 | i27 | i76 | i85 | i4 / i646 | i170 → i39 | i100 |
| 4x | s8606 | i69 / s138 | i73 | i91 | i102 | i9 / i1293 | i340 → i69 | i104 |

### Re-pinned counts (happy-dom counts, box load > 8: no walls)

| test | was (retired corpus) | now (fixture) | why |
|---|---|---|---|
| control 1x heartbeat | 3,230 visible, all commit | **211 visible**, 346 commits (legacy nesting re-renders children), parity exact | one corpus |
| arm heartbeat (#1) derivations | 0 | mobx 1, hand 2 (flat 1x/2x/4x); 0 rows commit | target is a session of a closed agent issue the arms hold (the retired target was archived, skipped outright); a member's activity can decide a closed row's retention |
| #2 phase change | mobx 0 commits (R3 orphans kept the root working) | 1 commit, the root, at every scale | effect-stable root rule |
| #4 rename (mobx) | 2 (i0 + spin-off i1) | 1 + visible spin-offs (0 here) | computed from the fixture |
| #6b archive | 1 commit / 2 derived (i4 was a child) | 0 / 1 | target is a childless root |
| m3 cold bootstrap visible | > 1,000 | 211 | one corpus |
| m3 growth #1/#2/#3/#5 (committed, derived+rollups) | — | hand 0/0+2, 1/1+3, 0/0+3, 1/1+3; mobx 0/0+1, 1/1+3, 0/0+3, 1/1+3 — identical at 1x, 2x, 4x | flat |
| commit counts #3/#6a/#6c/#6d/#7/#9 | 0/1/2 shapes | unchanged | — |

Suites: package lane 29 files / 189 tests green; strict m2 (`PROTO_M2_STRICT=1`)
green for both arms; client-core `runtime.test.ts` 136/136.

### Open questions

- None blocking. L2b adds the 2x/4x oracle range; this issue asserts 211 at 1x
  only.

## POD-4555 (L4a) — random-change generator · 2026-09-22

Doc: `docs/plans/pod-4545-round-three-change-generator.md` (vocabulary, L1c §5
mapping, audit §3.3 shapes, seed-1 coverage table, findings).

### Decisions

- **Changes are intents; the runner resolves them.** `gen` is pure data from a
  seeded PRNG. `run.ts` re-resolves every target on the engine and SKIPS (with a
  reason) a change whose target is gone, so any subsequence the shrinker tries
  runs. Write-path changes name their edit by a `handle` the `edit` minted.
- **Production queue, scripted server.** The generator's engine runs
  `openKernelEngineOutbox` (web's queue) over an in-memory store, and a
  `GenServer` holds every `issues.update`/`issues.markRead` until a change
  answers it. Options on `startEngineOnCorpus` are additive; the 21 engine-using
  test files are green unchanged.
- **Server writes read the cache**, never the folded snapshot (which carries
  the pending overlay).
- **The model mirrors the kernel drain** (single-flight pass, per-issue FIFO,
  parked titles block their partition). Without it half the answers missed.
- **Duplicate receipt comes from a reload**, not from a transient retry: the
  kernel's retry backoff runs on the injected clock plus a real timer, which
  would make step timing wall-clock dependent.

### Findings (sent to the coordinator)

1. Kernel outbox: a write enqueued while the single drain pass waits on a held
   call is not sent when it answers, even on another issue.
2. Row source: discovery worktree changes publish no event (documented by L3a as inherited).
3. Fixture sort keys `a0` fail the model's `isSortKey` (trailing minimum digit).
4. `scenarios.ts` `patchIssue`/`patchSession` build from the folded snapshot.
5. Mark-read overlays stamp `Date.now()`: painted `readAt` differs run to run.
