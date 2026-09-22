# Round-two audit: is the MobX conclusion earned? (architect's review, 2026-09-22)

Scope: everything on `integrate/4441-round-two` @ `4e8a98836` (155 commits, 18 issues, 2 days).
Read: the decision document and its re-decision, the shape review, the three exercise
documents, the six milestone notes, the quiet-window re-run. Code: all three arms, the shared
ground and the harness, audited independently by four reviewers with file:line evidence, and
the strongest claims re-checked by me by reading or by running the reviewer's probe.

## 1. The conclusion as drawn

**Rewrite the frontend read model as a MobX tracked object graph.** Decided once, reopened when
a quiet-window timing re-run showed every arm missing the absolute hot-path and click budgets,
then re-affirmed on the ground that safety is the only gate that separates the arms.

| Gate | Hand-rolled | MobX | TanStack DB |
|---|---|---|---|
| Safety (planted mistakes loud) | FAIL on one of three (render-path scan silent) | PASS | FAIL on one of three |
| Performance (budgets + slope) | FAIL walls, PASS counts | FAIL walls, PASS counts | FAIL walls, bundle, clock; PASS counts |
| Fidelity (parity, lifecycle) | PASS | PASS | PASS |

The document ranks MobX first, hand second, TanStack third, and names the rewrite's enforcement
checklist, the screen coverage map, the migration order and two open decisions.

## 2. What genuinely holds

- The parity oracle really runs the legacy derivation (`worklistSlice.derive` +
  `allIssueViewModels`) and projects it; the same projection for all arms.
- The row source really uses the kernel replica and the runtime, carries post-optimism values,
  and coalesces one event per publication. Scenarios 1–10 drive the real kernel and the real
  command path for optimism.
- The legacy control really fails the isolation fence, in both directions, and passes parity.
- All three arms commit only the affected rows on every scenario, at every corpus scale, and
  are roughly 5–15× faster than the control on hot-path walls under quiet conditions.
- The one planted mistake that separated the arms is real and was verified by planting it:
  an O(N) scan inside a row component re-renders every row in MobX (the observer subscribes the
  row to everything it read) and is caught by exact per-row commit assertions; the other two
  arms read without subscribing, so nothing fires.
- TanStack DB's elimination is well supported: 1.5–2 s per clock tick, the bundle over budget,
  and (below) the arm is half hand-written JavaScript anyway.

## 3. What does not hold, ranked by how much it moves the decision

### 3.1 The counts were not taken on the live-shaped corpus

Every count table, parity gate, growth slope and the control's count record run on the scenario
library's own generator (`shared/src/scenarios.ts` `GROWTH_CORPORA` + `seedCorpus`): 4,867
issues but ~3,230 visible rows, parent chains of depth one, discovered-from edges on five
issues, no prefix-overlapping worktree paths. The live-shaped fixture (211 visible, depth to
four, prefix overlap) feeds only the browser pages. Both are labelled "1x". The methodology
required the fixture for both. The "cost follows the change" and "row plus ancestors" counts
were therefore proved on a corpus fifteen times more visible-heavy and structurally shallower
than the one the walls use. Arms remain comparable with each other; the "live-shaped" framing
of the count verdicts is false.

### 3.2 The growth budget passes only because it was re-read on counts

The methodology defines the slope on per-event cost. On rows committed every arm is flat. On
walls, hand goes 9.6 → 14 → 30 ms and TanStack 38 → 53 → 94 ms from 1× to 4×; MobX at 4× was
withheld. The decision document reinterprets the budget on counts, where it passes, and calls
the wall growth "inherent per-read rebuilds". The raw tables say what those are: order snapshot
= visible set per event, groups bucket = visible set per event, rollup batch of 11,162 per
rename in hand, visible enumeration of 4,868 per new/archive/evict in MobX, 1.1 million
prefix-probe visits per new issue in TanStack. No arm achieved "cost follows the change" on the
dimension the methodology defined.

### 3.3 None of the three arms is the arm it was defined to be

**Hand-rolled** (3,988 lines, 2.7× the envelope). Its correctness guarantee was the exhaustive
delta handling plus a rebuild oracle. The oracle runs only on the fixed scenarios. A reviewer's
probe over small shapes, which I re-ran, turns the arm's own rebuild oracle red on:
a clock tick that should decay a session out of the live set (rollup reads the clock at
`rollup.ts:400` but `ClockChanged` is a no-op at `:577` and `:622`); an offer removed from a
session on a finished child (chain early-stop is unsound because a parent's aggregate depends
on the root); a single rank move inside a group (group row order goes stale); an evicted row
re-added (relations never re-seated); and two rank moves in one batch (binary search over live
keys of rows still at old positions). It also carries hand-maintained sensitivity sets, which
are input lists by another name, and a snapshot-identity order cache. About 150 lines are dead
or duplicated.

**MobX** (2,516 lines, 1.7× the envelope). The rollup is not compositional: the comment says it
walks child computeds, the body walks the whole visible subtree per ancestor, so "3 bodies" for
a phase change is 3 × O(subtree). The visibility getter uses a plain `Set` as a re-entrancy
guard read inside a computed; a row that hits the guard caches `false` with no tracked
dependency on the row it deferred to. That is the "plain state read inside a derivation"
mistake the exercise was built to catch, sitting in the winner's core, unexercised by any corpus.
Two of the four enforcement flags only warn, and the suite drowns in thousands of expected
warnings per snapshot, so they gate nothing. The arm's own UI parity test compares the arm with
itself. `rollupsDerived` excludes `visible`, `closed`, `rankKey` and every list-level body.

**TanStack DB** (4,127 lines, 2.8× the envelope). "Everything is a query" is false: prefix
ownership, the rollup (1,278 lines with 22 private maps and a second bootstrap algorithm), the
commit layer, order and groups bucketing, the tick re-dirtying and the selection latch are
hand-written JavaScript. Of 14 live queries, 9 are function bodies the engine merely schedules
and 2 (`groupsQ`, `visibleQ`) have no consumer beyond a counter. Rows do not subscribe through
TanStack at all: the React layer is `useSyncExternalStore` over the arm's own store; `react-db`
is imported only in a test. Replace is a teardown and rebuild of 19 collections because the
library throws on bulk reseeds. Two of the shape review's PASS lines cite code that is false at
HEAD.

### 3.4 Stats are arm-defined and cannot be compared

Each arm increments its own counters; nothing cross-checks them. `rollupsDerived` counts
bodies, not work, in all three arms, and every arm has uncounted whole-table walks on ordinary
deltas (hand: `resolveAllUnbound`, `visible.purge`, two full session walks per worktree seat;
MobX: 500-row seat scans per ingest, subtree walks per ancestor; TanStack: 2N function runs
per tick or keyspace change). The decision document concedes this and falls back to "rows
committed" as the only cross-arm currency. Rows committed measures the commit layer's
equality check, not the engine, and every arm gets it from a hand-written dedup.

### 3.5 The browser harness has defects that the verdict leans on

- `taskMs` includes a 50 ms-quantised notification poll plus two animation frames, so the
  8 ms budget is unreachable by construction; the document discards the performance gate on
  that basis and then reads the remaining walls as "calibration".
- The control's clock scenario is a no-op (the control has no `store`); its 0.0 ms row is not
  a measurement.
- The browser "heartbeat" bumps the first session, which sits on a visible row; arms commit
  zero because `lastActiveAt` is not projected, not because the change is unrelated.
- "Input-to-paint" is `performance.now()` two animation frames after a synthetic click, not a
  paint entry; a cold first click on every page drives every p95 over the line.
- Target rows are chosen by arm-defined key order; parity is never checked in the browser;
  successive samples mutate the corpus; the native lane is react-native-web under happy-dom.
- Lifecycle walls (principal switch, bootstrap, heap) were never measured in a browser; MobX
  at 4× and the control at 4× are withheld.

### 3.6 The safety verdict is real but narrower than PASS/FAIL

Three planted mistakes. The omitted-input case was silent in all three arms except through
a probe the examiner wrote (the hand arm additionally fails to compile, which is a genuine
lead). The eviction case was loud in all three through existing unit tests. Only the render-path
scan separates them, and it does so because MobX's observer over-subscribes rows, which the
document itself notes would go quiet again for a variant that re-renders without committing.
Meanwhile the winner carries a D-class mistake of its own (3.3). The lead is one mechanism, not
a category.

### 3.7 The gates that were supposed to catch structural drift did not fire

The shape review passed all three arms with claims that are false at HEAD and did not check
whether queries were consumed, whether the rollup was compositional, or whether the enforcement
flags could fail anything. The size envelope was waived. Both reviewers and builders were
agents under time pressure; the documents grew to 883 dense lines of hedged prose that a cold
reader cannot verify without the tables I extracted.

## 4. Rating

| Question | Answer |
|---|---|
| Were the arms built to best practice for their idiom? | No. Hand: incremental-view-maintenance with five confirmed correctness bugs and input lists in disguise. MobX: competent but with a non-compositional rollup, an untracked guard in its core and enforcement that cannot fail. TanStack: a hand-rolled store with a query engine upstream of half of it. |
| Was the comparison fair between arms? | Mostly yes on inputs (same seed, same oracle, same fence); no on instruments (arm-defined stats, arm-dependent target rows, a control clock that does nothing). |
| Does the evidence support "all three beat the current store and achieve row isolation"? | Yes, strongly. Commit counts, the armed control and the quiet walls all agree, and the margin is an order of magnitude. |
| Does it support eliminating TanStack DB? | Yes. Clock cost, bundle, and the fact that the idiom could not carry the slice without becoming a hand-rolled store. |
| Does it support choosing MobX over hand-rolled? | Not yet. Hand is faster by 2× on every quiet wall but is incorrect under ordinary deltas; MobX is safer on one mechanism but carries the same class of hazard internally and its per-body cost grows with the subtree. Neither arm is the arm the plan described, so the decision compares two flawed implementations, not two shapes. |
| Does it decide "how exactly we rewrite the frontend"? | It decides the shape (per-entity, incremental, windowed, one model layer) and eliminates one library. It does not yet decide the substrate, and the enforcement checklist it hands the rewrite includes two flags that do not enforce. |

## 5. What it would take to close the decision (bounded, not a round three)

1. **One corpus.** Retire the scenario generator's corpus; run counts and walls on the
   live-shaped fixture at 1×/2×/4×; re-assert the fixture's visible counts at all scales.
2. **A correctness gate both survivors must pass.** A property test: random sequences of a few
   hundred deltas (upsert, remove, reparent, phase, clock, evict, re-add, batch) against each
   arm, incremental snapshot equal to rebuild-from-scratch after every step. This would have
   caught all five hand bugs and exposes the MobX guard hazard if it is real. Zero divergence
   or the arm is out.
3. **Fix the two survivors to their definitions, bounded.** Hand: clock sensitivity in the
   rollup, sound chain invalidation, order and group maintenance under batched rank moves,
   re-seat on re-add. MobX: compositional rollup through child computeds, a real fixpoint for
   visibility (no untracked guard), enforcement flags asserted as errors in tests.
4. **A valid performance instrument.** Measure `actionMs` and long tasks only, drop `taskMs`,
   check parity in the browser after every sample, pick target rows from the oracle's order,
   make the browser heartbeat genuinely unrelated, add lifecycle walls, complete the withheld
   cells. Re-derive the budgets from what a no-op page scores.
5. **Equalise the safety fences before re-testing.** Per-row exact commit assertions and a
   component-enumeration lint in every arm, then re-plant the three mistakes plus the guard
   mistake. Score which detector fired, not which arm happened to have one.
6. **Cap the documents.** Recommendation, gate table, ranking table, evidence tables, then
   prose. A document a cold reader cannot verify from its tables is not a decision base.

Estimated lane time: one to two weeks for two arms, using the existing harness.

## 6. Decision criteria to adopt now

Gates first, in this order; an arm that fails a gate is out regardless of the rest.

| # | Criterion | How it is measured | Pass line |
|---|---|---|---|
| G1 | Correctness under arbitrary deltas | property test, incremental vs rebuild, ≥ 300 random steps × 20 seeds, live-shaped 1× | zero divergence |
| G2 | Fidelity | oracle parity on all scenarios, live-shaped corpus, browser included | green |
| G3 | Work follows the change | per-event main-thread time (`actionMs`, long tasks) in Chromium, live-shaped 1×/2×/4×, quiet box, interleaved | p95 within a budget derived from a no-op page; wall slope ≤ 1.2 |
| G4 | Row isolation | rows committed on unrelated heartbeat and on selection, with a control that fails | 0 and 2 |
| G5 | Safety with equal fences | same fences installed in every arm, then the four planted mistakes | every mistake loud, detector named |
| G6 | Lifecycle | principal switch, cold bootstrap, rescope, heap, in the browser | within the control multiples |
| G7 | Bundle and platform | production chunk delta, native lane on the real RN renderer | within budget, mounts |

Ranking among arms that pass all gates:

| # | Criterion | How |
|---|---|---|
| R1 | Cost to change | the change exercise by non-builders, with per-change recipes, places to remember and first-attempt correctness |
| R2 | Reading burden | concepts a newcomer must hold, named from the code; lines excluding tests |
| R3 | Performance headroom | wall slope and 4× walls |
| R4 | Dependency risk | new production dependency, upgrade churn, React 19 and RN fit, how well coding agents write it correctly (the exercise data already says something here) |
| R5 | Bundle and heap | tie-breakers |

Two rules. Every number in the decision comes from an instrument shown to fail on the control.
No budget is re-read on a different dimension after the measurement.

## 7. What Linear's two sync-engine talks change (added 2026-09-22)

Sources: Tuomas Artman, React Helsinki 2020 ("Real time sync") and the 2023 follow-up
("Scaling the Linear Sync Engine"); transcripts and annotated write-ups in
`~/Resources/LinearTalk`.

How Linear is wired: one normalised object pool, one instance per entity; relationships declared
once as model metadata (a reference id resolves to an instance and the pool maintains the inverse
collection on every insert, update and delete); the UI reads the graph through MobX and a list
re-renders when its collection changes; a local edit is applied to the in-memory model at once,
recorded as a transaction that is persisted and sent, and the model reaches disk as truth only
when the server's broadcast of the accepted change returns (the broadcast is the receipt, even to
the originating client); rejection rewinds from the old values the transaction kept; reload from
IndexedDB first, then delta-sync from the last sync id. Their MobX cost was construction: making
80–100k objects observable at bootstrap. Fixes: partial bootstrap (universal core only), cold
collections stay on disk until touched, observability on first access, a batch loader that
deduplicates on-demand loads, Suspense over the empty intermediate state, type-level marking of
unhydrated relations.

What already matches: the kernel (persistence, cursors, delta sync, outbox as persisted intent,
optimistic apply, rollback, dead-letter, echo) is the same family of sync engine.

What we do wrong: (1) pool without graph: consumers rebuild relationships by scanning arrays,
which is the epic; (2) each round-two arm reinvented relationship maintenance inside its own
derivations, where most of its bugs and lines went, instead of one metadata-driven pool layer;
(3) optimism lives beside the pool as folded arrays, which is why the shared feed re-indexes a
collection per change; Linear's answer to the open decision is optimism on the model in memory,
transaction log separate, disk on receipt; (4) every issue is instantiated at bootstrap,
including ~2,600 closed ones.

Where Linear is looser than our plan: sorted and grouped views are computed at render time over
the collection and the list re-renders, virtualised. On live data the visible set is ~200 rows;
per-change sorting is sub-millisecond. The whole-list finding in 3.2 was inflated by the
3,230-visible test corpus. Roll-ups are ours alone: compute them lazily and memoised for visible
rows over declared relations, never for the corpus.

Consequences for the close-out (§5): the next build is a pool-and-graph layer with declared
relations that either surviving substrate binds to; optimism moves onto the models with the
outbox as transaction log; closed issues and cold data stay on disk until opened; objects become
observable on first access; the list gate is "visible set sorted at view time, virtualised"; the
random-delta correctness gate targets the relation layer, which is now one generic piece.
