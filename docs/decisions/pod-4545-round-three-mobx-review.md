# Round three: MobX implementation review (M5, POD-4600)

Independent review of the finished MobX arm at `f5a7e8f52` (tip of
`integrate/4545-round-three` at review time), by reading AND by running the
instruments. Every claim cites `file:line` at that SHA; a README claim is
never used as evidence (the two places the README drifts are filed below).

**Non-builder statement.** I built no part of the MobX arm. No commit by
this session touches `packages/worklist-proto/arms/mobx/`: the three
in-arm plants (P5 `relations.ts`, P3 `react/list.tsx` twice) were
copy-aside/mutate/run/restore with an empty `git diff` verified after each;
the P4 plant lived in a scratch test under `harness/review/` (deleted after
the run, with its results file). The tree at review time is `f5a7e8f52`
plus this document (browser run at `0f882ce3f`, a doc-only delta).

**Verdict: READY FOR JUDGEMENT. MUST-FIX list: empty.** No correctness
defect, no silent-failure class, no whole-table walk on an ordinary change,
no instrument that cannot fail, no measurement claim without a complete run.
Three SHOULD-FIX items are filed under POD-4599 (dead export, README drift,
a/b provenance pins); none blocks N1a (POD-4592). All NOTE items stay in
this document and are not filed.

## 1. Schema-driven relations — PASS

| Check | Result | Evidence |
|---|---|---|
| Buckets derive from `shared/src/schema.ts` | PASS | `pool/relations.ts:346-395` loops `schema[entity].relations`; header `:6-11` "NO RELATION IS NAMED HERE"; `tables.ts:83-92` builds from `Object.keys(SCHEMA)`; `models.ts:81-99` installs fields from schema |
| No hand-coded relation maintenance outside `pool/relations.ts` | PASS | Grep: every relation name outside `relations.ts` is a generic-engine call — `views.ts:314,347` (`one`), `visible.ts:275,435,480,528,530,548,552,723,956,960` (`one`/`many`/`size`/`issueless`/`relationRef`), `pool.ts:817,858,912,915,1073` (maintenance-only `rawOne`/`rawMany` wrappers `:874-896`, "derivations keep reading fenced"), `rebuild.ts:145,148,191,194` (oracle, generic) |
| Extra relation needs zero arm code | PASS | `relations.test.ts:1288-1289` "a relation added to the schema needs no arm code" (fixture schema + `issue.coordinator`): ran green |
| Seat mirror follows the engine delta | PASS | `pool.ts:381-400` `onBucket` files one element per `issue.sessions` move into the maintained sorted list, in the same action; `seatList` O(1) `:483`, fenced `seats` counted `:469-478` |

## 2. Derivation capability — PASS

| Check | Result | Evidence |
|---|---|---|
| Combines take `(own, children)` only | PASS | `rollup.ts:321-324` `aggregate`, `:440-449` `unitsOf`, `:505-509` `latestOf`; type proof `rollup.types.test.ts:68-111` (exact inputs, plain-data, `@ts-expect-error` store-handle negatives) |
| Row components take `RowView` only | PASS | `pool/react/row.tsx:12`, `pool/native/row.tsx:10-11`; `row-shell.tsx:194-195,214-220` (`RowOnly` rejects extra props) |
| No store handles into components/rules | PASS | Handles stop at slot/list level: `react/list.tsx:81-93,136`, `native/list.tsx:23-47,78-82`; models hold `ModelHost` (`models.ts:61-65`), nodes hold `VisibleHost` (`visible.ts:924-931,964-973`). Plant proof: passing `pool` into `PoolRowView` plus a `values()` walk fails the suite (see §13, P3) — the boundary is enforced, not conventional |

## 3. Untracked state — PASS

| Check | Result | Evidence |
|---|---|---|
| No `Date.now` in pool non-test | PASS | Clock is `coarseNow` locals (`pool.ts:424,1128-1133`); per-deadline atoms `clock.ts:51-83` |
| No `keepAlive` | PASS | `enforce.ts:16`, `pool.ts:33` |
| No `autorun`/`reaction` for derivation | PASS | `autorun` only in `tracked()` (`pool.ts:241-258`, transient, for `snapshot()`); `reaction` only node-filing (`visible.ts:1312-1352`) |
| No plain Set/Map/variable read inside a computed | PASS | All `new Set/Map` are maintenance/action-local (`relations.ts:340-372,521,814-939,1049-1054`; `residency.ts:181-572`; `pool.ts:209,344,384-426,809,1170`; `visible.ts:542,1187-1193,1392`); no module-level `let` in derivations. Round-two hazard fixed: observable node registry `visible.ts:1164-1170` + regression test (seed-1 step-112 shape) |
| P4 plant caught | PASS | In-memory guard-Set + plain-Map cache on `IssueModel.view`: history fires step 3 `row i214: title "Probe first title" (expected "Probe second title")`, gate fires live-vs-rebuild; clean pool silent (§13) |

## 4. Enforcement — PASS

| Check | Result | Evidence |
|---|---|---|
| Four flags configured | PASS | `pool/enforce.ts:21-28` (`always`, `computedRequiresReaction`, `observableRequiresReaction`, `reactionRequiresObservable`); asserted on global state `pool.test.tsx:150-155` (ran green) |
| `console.warn` trap throws and fails | PASS | `pool/mobx-trap.ts:24-47`; installed by every pool test; `pool.test.tsx:156-165` proves an out-of-reaction `model.view` read throws (ran green) |
| Violation fails a suite (my run) | PASS | P3 plant failed `counts.test.tsx` via the trap: 2× `[mobx] Derivation 'observerPoolRowView' is created/updated without reading any observable value` (§13) |

NOTE (not filed): the exact subscription mechanics — a walk through the
fenced wrapper apparently subscribes the derivation to nothing, so the trap
(rather than the reads budget) fired first. The suite is red either way;
the reads cell was unreached. Owner question, one line for NOTES.

## 5. Whole-table work — PASS

| Check | Result | Evidence |
|---|---|---|
| Enumeration only in the declared module | PASS | `pool/enumerate.ts:2-5` (lint `no-table-walk` elsewhere): `issueIdsOf:64-65`, `knownIssueIds:73-78` (sole hot caller: replace path `pool.ts:1016`), `reseed:95-111`, scan/diff gate-only `:159-357`, `diffResidency:367-428` |
| Reads fence 1x and budgets | PASS | My run: every step within budget, incl. `#5: 1/24`, `#10: 101/168` (§13). No `JSON.stringify` equality on large values (`fieldEqual` per-row `pool.ts:181-197`; overlay equality `edit.ts:193-198`, ≤3 fields) |
| Groups keys O(change) | PASS | Buckets + per-group head ranks (`groups.ts`); order-iteration proxy count (`scaling.test.ts`); coordinator's verbatim order-walking mutation fails it (POD-4686 close) |
| Seat re-list O(1) | PASS | Maintained sorted mirror; coordinator's `[...seats].sort()` plant fails #10 at both scales (POD-4678 close) |

NOTE (not filed): per-change expansion reads rows through raw (unfenced)
doors (`issueRowOf:783-787`, `rawOne/rawMany:874-896`, `sessionLinkedIssues`).
Bounded by the node-construction bound (`visible-lazy.test.ts:47-68`,
closure-count test), both armed by coordinator mutations — reviewed, no gap.

## 6. Lazy loading — PASS

| Check | Result | Evidence |
|---|---|---|
| Cold rows kept out | PASS | `residency.ts:17-22,319-352`; engine links by id; no slot/model/observable |
| Hydration through per-row feed with batching | PASS | `residency.ts:259-295` (per-id atoms, 50 ms window, dedupe), `:308-317` take; `pool.ts:935-948` one-action `hydrate`; `:955-967` `settleLoads` (cap `:234`); `snapshot()` settles `:1146-1166` |
| Cold reads counted, loading queued | PASS | `coldRow:619-624` (fenced + tracked), `loaded:631-635`, `visibleInputs.issueRow/sessionRow:490-493`; plain pass never queues `:747-760` |
| Rescope re-partitions | PASS | `reseed` (`enumerate.ts:92-108`), `reindex/place/forget` (`residency.ts:359-432`), `syncReplace` + `forgetSessions` (`pool.ts:1035-1038`) |
| Observables follow access, not corpus | PASS | `visible-lazy.test.ts` green (ran); native bootstrap 121,631 observables / 2,112 closure nodes / 21 drawn cells (Mc5 tip verification) |

## 7. Write path — PASS

| Check | Result | Evidence |
|---|---|---|
| Edits paint once; equal writes skipped | PASS | `write/edit.ts:290-311` (one action, fire-and-forget send), `:193-198` (no equal rewrite); overlay transient at row-reader boundary `:46-58,205-267` |
| Rejection rewinds from the log | PASS | `edit.ts:313-323`; shared reference log `pending.ts:12` |
| Receipts idempotent; echo zero-commit; remote-keeps-local; TTL; duplicate no-op | PASS | `edit.ts:325-361`; `settle.test.tsx` 5/5 + `edit.test.tsx` 6/6 green (ran) |
| Pending survives rebuild/reload | PASS | `edit.ts:363-433`, `write/arm.ts:64-132` (outbox re-apply, optimism-aware rebuild) |
| Kernel's optimistic fold never consulted | PASS | Truth-mode feed; Mc2 record: 20×300 green with per-seed kernelDiffers tallied (close at `b6f57cab0`) |

Scope note: my 10-seed L4b ran the phase-a/b gate; the write-truth gate
rests on Mc2's 20×300 record plus the re-run unit suites above.

## 8. Lifecycle — PASS

| Check | Result | Evidence |
|---|---|---|
| Dispose leaves zero reactions | PASS | `pool.ts:1174-1188`, `visible.ts:1424-1435`, `groups.ts:573-578`, `relations.ts:762-780`, `residency.ts:410-420`, `clock.ts:105-107`; `pool.test.tsx:414-466` green (ran): listeners 0, tables empty, models 0, observer trees empty, `pendingReactions` 0 (`:461`) |
| Replace atomic | PASS | One `runInAction(reseed+flush+syncWorklist)` (`pool.ts:980-993`, contract `enumerate.ts:80-86`); every L4b reload exercises it |
| Principal switch on a fresh replica | PASS | Mc3 c3: switch 570.5 ms vs 219.4 control (OVER budget, recorded as finding for the decision, not this arm's correctness) |

## 9. Stats honesty — PASS (drift filed)

| Check | Result | Evidence |
|---|---|---|
| `rowsDerived` defined and single-sited | PASS | `models.ts:166` (view bodies, incl. structurally-equal); parts uncounted per README `:204-206` |
| `rollupsDerived` from three compositions | PASS (code) | `pool.ts:524-526` via `rollup.ts:696,723,742`. DRIFT FILED: `pool.ts:39-40` + README `:220` still say "two" |
| Maintenance counters in maintenance only | PASS | `relations.ts:1066-1069`, slots `:905-919,1020-1043,755-756`, elements `:732,756,1039,892,900` |
| Reads counted by the fence, never the arm | PASS | `reads.ts:556-601`; arm `touch()` only for wrapper-invisible seams (`pool.ts:474,516,622`, `relations.ts:953`). Fence cells carry arm counters beside reads (my run) |

## 10. Parity — PASS

| Check | Result | Evidence |
|---|---|---|
| Every assertion vs oracle or rebuild | PASS | `gate.test.ts:355,410-429` (rebuild + scan + partition + whole-view `diffViews`); `rollup.test.tsx:129-131` (oracle AND rebuild); `visible.test.tsx:119`; `fences.test.tsx:169-178` |
| Zero live allowances | PASS | `roster.ts:92-100` (no allowances; "POD-4671 fixed"); `known-gaps.ts` deleted; `entries.test.ts:31-35` guards the deletion. My fence run: parity true on all 16 cells, `allowed` all null |
| Self-referential parity absent | PASS | No arm-vs-arm comparison found; rebuild is from-scratch over feed rows (`rebuild.ts:129-207`) |

## 11. Size and dead code — PASS (dead code filed)

Non-test lines: `visible.ts` 1436, `pool.ts` 1196, `relations.ts` 1092,
`rollup.ts` 768, `residency.ts` 589, `groups.ts` 580, `views.ts` 499,
`write/edit.ts` 452, `enumerate.ts` 429, total ≈12k.

| Check | Result | Evidence |
|---|---|---|
| Unreferenced exports | FILED | `rebuildOrder` (`rebuild.ts:210`) has no importers in code or tests — SHOULD-FIX |
| Duplicated bootstrap/replace paths | PASS | Layered, not duplicated: feed `replace` → `reseed` (`pool.ts:984`) → `syncWorklist` (`:1013`) → `syncReplace` (`visible.ts:1391`) / `ensure` (`:1105-1106`); write layer `ensureIssues` (`pool.ts:1117-1121`) |

NOTES (not filed): the fenced `seats()` doors have no production readers
(all readers use `seatList`: `views.ts:377`, `visible.ts:508`) — deliberate
permanent-plant infrastructure, documented in code; `plainScope.seats`
(`pool.ts:770`) is vestigial-documented ("unused since POD-4678").

## 12. Measurement notes — PASS (provenance pin filed)

| Note | Result | Evidence |
|---|---|---|
| Mc3 lifecycle (POD-4575-c3) | PASS | runtimeSha, load ≤5.38, n=20/cell, 180 records named in-doc |
| Mc4 growth (POD-4576-c4) | PASS | runtimeSha `69d032cd9`, Chromium 148, load ≤6.84, 36/36 ok, recomputed from raw records by coordinator |
| Ma4 a-phase (POD-4568-a), Mb4 b-phase (POD-4572-b) | FILED | Corpus+instrument+cells named, but no runtime SHA and no per-record load; results git-ignored — SHOULD-FIX (pin SHAs, e.g. b's browser `e640f7dd9`, or mark superseded) |
| No budget re-read on another dimension | PASS | b reports stagemove p95 OVER as over; Mc4 note explicitly declines re-read on the ill-conditioned slope |

## Mobile lane — NOTE

Mc5 verified at this tip: native fence + entries 11/11, `#1-#3` counts plus
parity, renderer limitation stated (react-native-web alias, no real RN
renderer in any lane). My tool layer blocks the native-lane command (raw
vitest path refused; `test:file` excludes `harness/native/`), and the tree
is byte-identical to the verified tip outside this document — so the lane
rests on that verification, not a re-run by me.

## 13. Instrument runs by this review

All at `f5a7e8f52` unless noted (browser at `0f882ce3f`, doc-only delta).
Load was above 8 for most of the session (correctness runs need no quiet
box); the browser matrix enforced load ≤ 8 itself, retrying overloaded
attempts (5 failed tries excluded, listed in the summary).

1. **L4b, 10 fresh seeds × 300** (never seeds 1–20):
   `POD_POOL_GATE_SEEDS=<n> POD_POOL_GATE_FIRST_SEED=<k>
   POD_POOL_GATE_STEPS=300 bun run test:file --
   packages/worklist-proto/arms/mobx/pool/gate.test.ts -t "passes every seed"`.
   101, 102–103, 104–105, 106–107, 108–109, 110 — all green (9–22 min each).
   Cells (`harness/browser/results/mobx-pool-gate-1x-*.json`, git-ignored):
   300 steps, 31 oracle checks, 301 relation checks, 215–225k views compared
   per seed; all 7 plants (removal-deaf, cold-deaf, relink-skipped,
   promote-skipped, activityCached, presenceUntracked, chainUntracked) failed
   every seed.
2. **Reads + commit fences, scenarios 1–10 at 1x**:
   `bun run test:file -- packages/worklist-proto/harness/src/fences.test.tsx
   -t "MobX pool"` — green (39 s). Cells (`fences-mobx-1x.json`):
   `#1` 0 commits 2/3 reads; `#2/#3/#4` 1 commit 1/3; `#5` 1 commit 1/24;
   `#6a` 0/5/16; `#6b` 0/1/15; `#6c` 0/1/15; `#6d` 0/2/30; `#7` 2 commits
   1/21; `#8` 0/0/0; `#8b` 6 commits 6/144; `#9a/b/c` 0/1/3; `#10` 48
   commits 101/168. Parity true everywhere; `allowed` null everywhere.
3. **L6b P3 (scan in a row)**: plant — `pool` passed into `PoolRowView`
   plus a `pool.fenced.issue.values()` walk per draw (cp-restored). `counts
   .test.tsx` "meets the shared reads budget" FAILS (trap first: 2×
   "Derivation 'observerPoolRowView' … without reading any observable
   value"). A misplaced plant (`keys()` in the non-redrawing slot) passed —
   plant placement matters, not an instrument hole (verified by the above).
   Reference P3 (`-t "P3-row-scan"` on `probes.test.tsx`): 3 passed.
4. **L6b P4 (untracked state)**: plant — in-memory guard-Set + plain-Map
   cache on `IssueModel.view` (scratch file, deleted). Full `runProbe
   (untrackedState, mobxPoolArm)`: clean pool behaviour passes; planted pool
   behaviour FAILS — history fires step 3 `row i214: title "Probe first
   title" (expected "Probe second title")`, gate fires live-vs-rebuild.
   Reference P4 (`-t "P4-untracked-state"`): 3 passed.
5. **L6b P5 (missing inverse)**: plant — forward-only move on update in
   `point()` (`relations.ts:905-919`, cp-restored). `relations.test.ts`
   reparent test FAILS; restored green. Probe relation-check on the clean
   MobX pool (`-t "P5-missing-inverse"`, incl. "every declared relation
   agrees… >1000 edges"): 4 passed.
6. **Lint**: `bun run lint` in `packages/worklist-proto` — exit 0;
   `fence-lint.test.ts` 29/29; `probes-lint.test.ts` 9/9 (each lint plant
   asserts its exact rule ids — a blind rule fails the suite).
7. **Browser, rename/stagemove/clock/heartbeat at 1x under lease**:
   built web entries (`test-heavy -- bunx vite build`), `entries.test.ts`
   4/4, then `test-heavy -- bun …/browser/matrix.ts --arms
   noop,control,mobx --scales 1 --rounds 2 --samples 3 --scenarios
   rename,stagemove,clock,heartbeat --tag pod4600-review`. 72 ok records,
   max 1-min load 7.67, runtimeSha `0f882ce3f`, Chromium 148. MobX parity ok
   on all 24 records, strayCommits 0. Observations (n=6/cell, NOT budget
   verdicts — the summarizer correctly refuses p95 on n=6): actionMs p50
   mobx clock 0.5 / heartbeat 16.65 / rename 4.25 / stagemove 9.65 against
   noop floors 0.4 / 14.4 / 2.75 / 3.05; control 130–146 with 275–276
   commits. Stagemove commits 0 drawn (target outside the window).
8. **Warning trap**: `pool.test.tsx` "is configured, and an untracked read
   trips the trap" green; `dispose` test green; write `settle` 5/5 + `edit`
   6/6 green; extra-relation fixture test green; `visible-lazy` +
   `visible-closure-count` green; `typecheck -- --filter
   @podium/worklist-proto` green (8/8).

## Filed findings (POD-4599)

- SHOULD-FIX ×3 (dead export; README drift ×2; a/b provenance pins). None
  blocks N1a; no `dep-add` wired.
- NOTE items (§4, §5, §11, mobile) stay in this document.
