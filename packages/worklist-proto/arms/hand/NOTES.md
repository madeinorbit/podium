# POD-4446 NOTES — hand-rolled arm, milestone 1
## Decisions

- **Buckets hold ids, not objects.** A content-only session change moves no
  bucket, so the unrelated heartbeat costs zero index writes, zero
  derivations, zero commits. Objects are borrowed by reference from the
  stream and never spread on the hot path.
- **Archived sessions sit in membership buckets, filtered at read.**
  `membersOf` excludes archived + shells + headless (the legacy ownership
  read); the unread rollup reads explicit seats minus shells with archived
  included (the replica `indexSessionsByIssue` rule). One seat system, two
  reads — verified against the oracle (i49: archived member session,
  replica-derived unread keeps the finished row visible in its 7-day window).
- **Issue `unread` is derived, never trusted from the wire.**
  `derivedUnread` replays `deriveIssueRollups` exactly (readAt vs updatedAt
  vs member activity; deleted reads as read). The seed wires carry a static
  `unread: false` that disagrees with the replica derivation — trusting it
  failed parity on i49 at SMALL.
- **Subtree = visible formal subtree for attention, live formal subtree for
  progress.** Started-by provenance nesting is out (spec §6); the corpora
  carry no `startedBySession`, so formal-only matches legacy exactly here.
  Spin-off tip / vacated-origin / continuation machinery is still
  implemented (fixture + seeds carry `discovered-from` edges and it feeds
  rollup units + review-withdrawal), reading the maintained R4 adjacency —
  never a table scan.
- **Snapshot is the unselected baseline.** `snapshot()` always projects with
  `(null, false)` selection like the oracle; the closed-fold latch applies
  to rendered placement only (`setSelection` recomputes the two rows'
  lanes). Engine-driven selection is invisible by row-source design
  (locals-only publications emit no event), so the engine-backed click
  commits 0 rows; the UI click path commits exactly the two rows whose
  selected-ness flips, with 0 derivations (both evidenced in tests).
- **Agent-audience rows need a visible formal host.** The legacy nesting
  pass drops top-level agent rows ("internal issues: nested only"), and the
  oracle flattens what survives — so the flat slice drops agent rows with
  no visible formal ancestor (250 at 1x fixture: 211 rows, matching the
  control exactly). Walk passes through invisible intermediates; the
  started-by fallback is out (spec §6) and absent from the corpora.
  Rescued rows host in a second round (legacy nests after rescue).
- **Merge decisions and awaiting-merge never fire in the worklist.** Both
  read `branch`/`gitState`, which the navigation model never carries
  (`deriveIssueViews` drops them), so the legacy slice only ever decides
  `review`. The arm matches legacy (spec: legacy wins over shorthand) —
  reading the richer wire would fail parity. Same for `dependents`, which
  the arm re-derives from outgoing edges like the model does.
- **`closed` is the fold predicate, not the lane.** Pinned settled rows
  read `closed: true` while rendering in PINNED (the oracle projects
  `rowInClosedFold` directly).
- **Notifications count batches.** `notifications` = dispatch passes (one
  batch = one pass), including no-op passes — the heartbeat records
  `notifications: 1` with zero commits and zero derivations.
- **`rollupsDerived` counts every derivation body execution** (own-summary,
  subtree-aggregate, visibility-predicate). `rowsDerived` counts committed
  rows (new + changed + removed). `indexUpdates` counts mutating bucket
  writes. Bootstrap counts are reset after construction.
- **Native renders full in a ScrollView for M1** (same as the control lane,
  so counts compare directly); the web list is genuinely windowed.
  FlatList recycling is named M3 hardening (open question below).
- **No `@tanstack/react-virtual`.** Windowing is ~40 lines hand-rolled;
  a new dependency for that would cost more than it saves and risk the
  native-incompatible budget.

## Count tables

### 1x engine-backed (GROWTH_CORPORA.x1; 4,867 issues / 4,304 sessions / 500 repos; 3,230 visible rows; `hand-1x-counts.json`)

| Scenario | Rows committed | rowsDerived | rollupsDerived | indexUpdates | notifications | Parity |
|---|---|---|---|---|---|---|
| #1 unrelatedHeartbeat | 0 / 3230 | 0 | 0 | 0 | 1 | green |
| #2 visibleSessionPhaseChange | 1 (i0) | 1 | 3 | 0 | 1 | green |
| #3 selectionClick (engine path) | 0 | 0 | 3¹ | 0 | 1 | green |

¹ The eager mark-read row: readAt moves no summary/visibility/aggregate
value, but the three input checks proving that execute. Zero value changes.

### UI click path (happy-dom, `hand.ui.test.tsx`)

| Action | Rows committed | rowsDerived | rollupsDerived |
|---|---|---|---|
| setSelection A→B | 2 (A, B) | 0 | 0 |
| Phase change on B (chain A+B) | 2 (A, B) | 2 | chain |

### SMALL engine-backed

Identical shape: heartbeat 0/37 all-zero, phase 1 row (i0) + chain of 1,
click 0 rows + 3 evaluations, parity green throughout, rebuild oracle green
after every scenario.

### G2 fixture at 1x (engine-booted, `hand.fixture.test.ts`)

211 visible rows — exactly the control's set. Full-snapshot deep-equal with
`snapshotFromStore` (rows, order, groups) plus the rebuild oracle. This is
the corpus the browser pages measure; the scenario corpora above exercise
the change paths, this one exercises the rule surface (nesting drops,
decay windows, closed fold, defer bands, pinned lanes).

### Browser (1x click input-to-paint)

- Readiness + parity in Chromium (no timing): hand page boots at 1x
  fixture, `snapshotHash` **matches the control exactly** (`6365b567`,
  211 rows), 17/211 rows mounted (windowing verified: 1000px viewport,
  18kpx scroll height).
- Wall timing: first attempt 01:31 at load 14.78 (refused — above 8);
  second window 02:05 at load 5.0 but the G4 driver's serve path 404d
  (fixed: `entries/` fallback in `run.ts`, committed); load then 9.15.
  p50/p95/max table lands when a quiet window holds — counts above are
  the verdict meanwhile.
- Driver note for other arms: `run.ts` `serveDist` did not match vite's
  `dist/entries/` layout (`/hand.html` 404d, page never ready). Fixed
  with an `entries/` fallback; control page unaffected.

## Line count (arm folder, `wc -l`; tests excluded)

3,237 total / 2,801 code-only vs the 800–1,500 budget — OVER, openly.
Breakdown (total): rules ~500, indexes ~480, rollup ~470, visible ~340,
store ~340, groups ~220, summary ~170, order ~150, react ~180, rows ~130,
rebuild ~90, deltas ~80, tables ~70, arm ~50, native ~70.

Where the weight is: faithful transcription of 8 legacy rules with decay
windows, continuation/vacated spin-off graph, rescue chains, closed-fold
grace, prefix containment, merge decisions (defensive wire reads) — plus
~250 lines of exhaustive-switch arms the brief's own definition mandates
(one per handler per kind). Compression applied: archived-in-bucket killed
a whole seat system; member lookup shared; store dispatch unified. Further
compression is comment-trimming, not structure — deferred to H4 review.

## Open questions for H4

1. Line budget vs fidelity: is 3,237 lines (2,801 code) acceptable for a
   parity-exact slice, or should M2 compress (and what may be dropped)?
2. Native windowing: ScrollView-full is fine at 211–3,230 rows in the unit
   renderer; does H4 want FlatList recycling with device evidence?
3. `rollupsDerived` semantics: currently every body execution (including
   vacuous input checks). Keep, or split classification from derivation?
4. Engine-driven selection is invisible to arms by row-source design — the
   #3 budget's "2 rows" only manifests on the UI click path. Confirm this
   reading for the MobX/TanStack arms before they build the wrong probe.
5. Defensive wire reads (`branch`, `gitState`, `name`, `busy`,
   `supersededBy`, `dependents`) are absent from `SliceIssue` but present
   on engine rows and required for parity (merge decisions, draft titles).
   Should the slice type grow them, or is defensive reading the idiom?

---

# POD-4450 NOTES — hand-rolled arm, milestone 2 (structural scenarios 4–10)

## Arm changes (each: did it add a place to remember?)

1. **`summary.rebuildAll` populates `timeSensitive` (the M2 gap).** No new
   place: the set already existed, the bootstrap just never filled it, so
   every tick after boot skipped deferUntil carriers and bands went stale
   past a defer boundary. Found because the 1x tick showed 45 re-evals
   (decay only) with zero summary refreshes. Regression test per
   sensitivity set in `hand.test.ts` ("clock sensitivity sets"); the band
   test fails without the fix.
2. **Order drops its clock sweep.** No new place: summary precedes order in
   topology order and every band flip arrives as `SummaryChanged`, so the
   `timeSensitive` re-rank loop (541 rows × O(visible) probes per tick at
   1x, zero moves) was pure waste. After: tick pays zero order probes.
3. **Order membership set + rank-key memo.** No new place: both live inside
   `order.ts` beside the array they mirror (members on insert/remove/
   rebuild; ranks compared by exactly the fields `compareRank` reads).
   Kills the R-H1 `includes`-per-dirty-row and all no-move re-ranks
   (burst50 paid ~1,100 wasted probes before).
4. **Issue prev-seat map (`issueSeats`).** No new place: the `sessionHome`
   precedent, same diff shape. Kills the `moveSeat` full-map scan per
   issue ingest (O(repos) buckets walked for every issue delta); `moveSeat`
   itself is deleted.
5. **R-H2/R-H3.** `rebuildRootsAfterIssue` (dead) removed;
   `store.tableApply`'s kind switch ends in `assertNever`, so a new stream
   kind is a compile error, not a silent drop.
6. **`scan(name, visits)` vocabulary in `deltas.ts`.** Extended place #1
   (README), not a new one: names the remaining multi-row walks so the M2
   run prices them per scenario. Counts are asserted exactly by the M2 run;
   the rebuild oracle does not cover counts (values only).
7. **Reverted before landing: seeding ancestor chains on
   `VisibilityChanged(false)`.** Tracing the exhibiting shape showed it is
   unreachable (a finished row with a pending decision is stage-review,
   hence `activeHuman`-kept, hence never decays; decay/rescue leavers carry
   no sessions and no pending decisions; archive/evict already seed via the
   edge change). It would have added a redundant compute to every
   visibility loss for zero scenario benefit. The adjacent real holes are
   findings F1–F2 below, not M2 fixes.

## Count tables (1x: 4,867 issues / 4,304 sessions; 3,230 visible rows)

BEFORE (no arm changes; parity + rebuild oracle green throughout):

| Scenario | Rows committed | rowsDerived | rollupsDerived | indexUpdates | notif |
|---|---|---|---|---|---|
| #4 rename | 1 (i0) | 1 | 3 | 0 | 1 |
| #5 stage move | 1 (i3) | 1 | 3 | 0 | 1 |
| #6a new | 0 (mount¹) | 1 | 3 | 2 | 1 |
| #6b archive | 1 (i3²) | 2 | 1 | 1 | 1 |
| #6c evict | 0 (unmount¹) | 1 | 0 | 1 | 1 |
| #7 reparent | 2 (i2, i8) | 2 | 5 | 2 | 1 |
| #8 tick | 0 | 0 | 45 | 0 | 1 |
| #9a press / #9b echo | 0 / 0 | 0 / 0 | 2 / 2 | 0 / 0 | 1 / 1 |
| #9c rejected press | 0 | 0 | 4 | 0 | 2 |
| #9d rollback quiet | 0 | 0 | 0 | 0 | 0 |
| #10 burst50 | 21 | 32³ | 143 | 50 | 1 |

¹ Arrivals mount and departures unmount; mount-phase renders are excluded
by the RowShell by design, so the harness logs 0 — the work (order + one
row derivation) is in `rowsDerived` and the visible count (+1 / −1).
² The leaving row unmounts; its parent i3 (lost subtree member) commits.
³ 21 updates + 11 arrivals (visible 36→47): mounts explain the whole gap,
no double-commit (key-dedup would be the other mechanism; not observed).

AFTER (budgets beside each number; scans per step):

| Scenario | Rows committed | derivations | scans (visits) |
|---|---|---|---|
| #4 (1 row, 1 deriv) | 1 ✓ | 1 + 3 bodies⁴ | batch 11,162; snapshot 3,230 |
| #5 (affected + order) | 1 ✓ | 1 + 3 | walk 2+2; batch 11,162; snapshot 3,230 |
| #6a (order + row) | 0 mount ✓ | 1 + 3 | batch 11,165; groups 3,231; rowgrp 9; snapshot 3,231 |
| #6b (order + row) | 1 ✓ | 2 + 1 | batch 11,165; order-idx 3,229; groups 3,230; rowgrp 7; snapshot 3,230 |
| #6c (order + row) | 0 unmount ✓ | 1 + 0 | order-idx 3,228; groups 3,229; rowgrp 6; snapshot 3,229 |
| #7 (both chains) | 2 ✓ | 2 + 5 | walk 2; batch 11,162; snapshot 3,229 |
| #8 (band-movers only) | 0 ✓ | 0 + 558⁵ | snapshot 3,229 |
| #9 each step phase-like | 0 ✓ | 2/2/4/0 | snapshot only (no walks, no batch⁶) |
| #9 suppl. visible press | 0, identity kept ✓ | 3 | batch 11,162; snapshot 3,229 |
| #9 rollback identity | echo object ✓ | — | — |
| #10 (one event, ≤50+chains) | 21 ✓ | 32 + 143 | walk 3+24; batch 11,268; groups 3,240; rowgrp 83; snapshot 3,240 |

⁴ Derivation bodies are arm-relative (methodology Q-H3/M3): own-summary +
visibility + aggregate = 3 per single-row change. Cross-arm metric is rows
committed. ⁵ 513 live deferUntil carriers + 45 decay rows; every number
reconciles (27 archived carriers excluded before counting). ⁶ i6 is
invisible in the seed corpus (unbound session, no audience), so optimism
steps touch summary + visibility only — trivially identity-safe. The real
mechanism: `readAt` feeds no derived value, and the kernel restores the
echo object by reference on rollback (G3 covered truth). The visible-row
supplement (#9 suppl., i0, all three bodies) carries the non-vacuous half.

Scan judgments (H4's handed-down slope question — inherent or removable):

- `rollup-batch` ~11.2k per computing dispatch (2× session seats +
  staffed ancestor steps): REMOVABLE via incremental open/lastActive/
  staffed seats; kept as one-build-per-dispatch for M2. The biggest slope
  item — J-phase.
- `groups-rebuild` ~V per affecting batch: INHERENT to rebuilding group
  sequence from the global order (contents already scoped to touched
  groups). J-phase slope item.
- `order-index` now only on removals (~V per removal): INHERENT to
  array-order maintenance short of a maintained index map (priced,
  deferred).
- `rows-group` (touched-group members), `visible-walk`/`rollup-walk`
  (subtree-bounded): INHERENT — the derivation work itself, value-compared.
- `index-resolve`: 0 on all M2 paths (no lane/worktree deltas); priced for
  the lifecycle phase (resolveCwd is O(roots) per unbound ingest,
  resolveAllUnbound O(sessions) per lane change).
- `order-snapshot` ~V per order read (list + parity): INHERENT to serving
  the view — one build per change per reader, never per row.

## Findings (latent holes with the mechanism named; beyond the 7 scenarios)

- F1. Agent-row hosting is not re-synced on pure clock ticks, and
  visibility loss seeds no ancestor recompute. Exhibiting shape: an agent
  row with live sessions hosted under a decaying finished formal host,
  plus a boundary-crossing tick. Absent from the seed corpora (no
  `audience` field → no agent rows) and day-scale jumps are outside #8.
  For J-phase: recheck hosting for the affected subtree on clock, then the
  chain seeding reverted in (7) becomes load-bearing.
- F2. `sessionRetains` day-windows are read inside computes but tracked in
  no clock set: a day-scale jump (not #8's +60 s) goes stale the same way
  the defer gap did. Same scope note as F1.
- F3 (harness, G4). Browser commit logging never worked: production
  react-dom disables `Profiler onRender`, so every browser page on every
  arm logs zero commits — counts were never affected (happy-dom uses the
  dev build). The documented `react-dom/profiling` alias breaks page boot
  (`TypeError` at init, mechanism not yet traced). Browser evidence in M2
  is therefore walls + arm stats + mounted rows, not commits. Recommend a
  G4 follow-up: fix or bless the profiling bundle before J-phase walls.

## Browser (1x fixture corpus, 211 visible rows)

Pending a quiet window (box above load 8 through the count phase): rename,
stagemove, clock × 20 per arm (hand + control interleaved) via the
extended G4 driver (`rename,stagemove,clock` page scenarios new in this
issue). Verdict metric is in-page `actionMs` (sync pipeline + microtask
drain, no paint, no poll); `taskMs` bounds the wall to paint.

## Line count (arm folder, `wc -l`, tests excluded)

3,723 non-test total (+486 over M1's 3,237, per-file in the M2 diff stat):
order +71 (members, ranks, probes), indexes +67/−(moveSeat) (seats),
deltas +31 (scan vocabulary), store +21 (scan totals, assertNever),
rollup +17 (walk/batch counts), groups +14/− (set membership, rebuild
count), visible +9, summary +6, rows +2. Test growth: m2 run (308) + tick
sets (part of hand.test.ts +119).
