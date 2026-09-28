# N1b work log (`POD-4593`)

Scratch. Transcribed into `docs/decisions/pod-4545-round-three-n-mobx-probes.md`;
deleted before landing.

## Seams (clean tip)

- P1 omitted input: `IssueModel.displayTitle` (`arms/mobx/pool/models.ts:128`)
  reads the tracked row via `displayTitlePartOf(host.inputs, id, sessionIds)`.
  Plant: read the issue untracked in the computed.
- P2 evict cleanup: `drop()` (`tables.ts:185`) deletes the slot, then
  `relations.changed(entity, id, prev, undefined)` (`relations.ts:536`) relinks
  (detach from buckets). Plant: forward-entry drop only, skip the bucket detach.
- P3 row scan: `PoolRow` (`pool/react/row.tsx`, in `fence.json` rows) is
  `memo` + plain data. Plant: aliased walk over `pool.fenced.issue` through a
  type-only context module, provided in `pool/react/list.tsx`; row must be an
  observer for the MobX commit-fence leg.
- P4 untracked state: deterministic refreshed-set shape. Plant: plain
  `Set` + `Map` instance fields on `MobxPool`, consulted in `IssueModel.view`,
  cleared in `applyLocals` on `coarseNow`.
- P5 missing inverse: `PoolRelations.point()` (`relations.ts:905`) detaches
  then attaches. Plant: updates (old !== undefined && target !== null) move
  the forward entry only.

Subject: `{ mode: 'overlaid', armFor: () => mobxPoolArm, lintFolder: 'mobx' }`
(oracle on; same wiring as `pool/gate.test.ts:610`).

## Runs

Clean baseline (`n1b-mobx-all.json`, on issue branch before any plant): all
five probes SILENT everywhere run, none blind (relation check looked,
checkable). Arm ready.

### P1 omitted input (branch `n1b-p1-omitted-input`, patch `n1b-p1-omitted-input.patch`)

Plant: `IssueModel.displayTitle` reads the issue row through
`untracked()`; other inputs (sessionIds) stay tracked. First variant isolated
the title with zero tracked deps and tripped MobX's own
"derivation without observable" warning under the arm's warn trap — a
plant-shape artifact, reshaped to the faithful form (heals when another input
moves); warn-trap episode recorded in the doc as a shaping note.

- typecheck SILENT (8/8 green). lint-fence SILENT (clean).
- commit-fence FIRED — #4 `visibleTitleRename`: drew 0, oracle changed 1,
  `under=[i214]`, `rowsCommitted=0`.
- reads-fence SILENT (#4 reads 1/3). parity FIRED (#4, stale title).
- gate FIRED via the #4 fence-step rebuild (`title: "collapse rail 3"
  (expected "Renamed visible row")`); the write-path sequence leg green.
- relation-check SILENT. history-check SILENT — FINDING vs catalogue
  (reference FIRED): bare-arm snapshots recompute unobserved computeds on
  every read, so staleness shows only under a mounted observer.
- behaviour-test FIRED (via #4 parity+gate).
- arm-tests FIRED — `counts.test.tsx` "meets the shared reads budget":
  `[commits] visibleTitleRename (#4): drew 0 rows… under=[i214]`.
- Screen: renamed row keeps its old title until another input of the same row
  moves. Notice: immediate (the row never redraws on rename).

### P2 missing index cleanup on eviction (branch `n1b-p2-evict-index`, patch `n1b-p2-evict-index-cleanup.patch`)

Plant: `PoolRelations.changed` on a delete drops the forward entry only and
returns before the row leaves its targets' inverse buckets (the one generic
maintenance path, so every relation is affected).

- typecheck SILENT (green). lint-fence SILENT (clean).
- commit-fence SILENT, reads-fence SILENT (#6c reads 1/15, #6d 1/30),
  parity SILENT, gate SILENT, history-check SILENT — fail-soft on the real
  arm, as in K MobX E: every view re-checks the table, the screen stays right.
- relation-check FIRED — #6c `ghost: issue:i516.spinOffs holds issue:i57,
  which the feed no longer has`; #6d `ghost: issue:i390.children holds
  issue:i430…`; sequence steps 0/2/4 ghost, re-add steps 1/3 ok (24,228
  edges seen per step).
- behaviour-test FIRED (via the relation check).
- arm-tests FIRED — `relations.test.ts`, 8 failures, first:
  `issue.parent/children > delete removes the row from every inverse:
  expected [ 'I2', 'I3' ] to deeply equal [ 'I3' ]` (plus evict/re-add,
  M3-F1 upkeep, 3/3 random-sequence seeds vs the from-scratch scan).
- Screen: right throughout (ghost visible only to a graph check). Notice: a
  developer watching the screen never would; the relation check / arm suite
  fires at once.

### P3 O(N) scan inside a row (branch `n1b-p3-row-scan`, patch `n1b-p3-row-scan.patch`)

Plant (3 files): `pool/react/pool-context.ts` (new, pool type only),
`pool/react/row.tsx` (observer row, aliased walk over `pool.fenced.issue`
counting children), `pool/react/list.tsx` (provides the context).

- typecheck SILENT (green). lint-fence SILENT on the planted alias; the
  direct form (`pool.fenced.issue.values()`) FIRED `fence/no-table-walk`
  (1 error; `no-store-in-component` silent — the context indirection already
  defeats it). Restored via cp; lint clean again.
- commit-fence FIRED — #4 drew 732 rows, oracle changed 1 (K MobX F: the
  observer row subscribes to every issue it walks). #2 commits ok (a session
  change touches no issue slot).
- reads-fence FIRED — #2 read 2,821 rows vs budget 3; #4 2,820 vs 3.
- parity SILENT, gate SILENT, relation-check SILENT — screen right, cost wrong.
- behaviour-test FIRED (via the reads fence).
- arm-tests FIRED — `counts.test.tsx`: `[reads]
  visibleSessionPhaseChange (#2): read 2821 rows, budget 3.
  byEntity={"session":1,"issue":2820}…` (2 tests fail; the probe run proves
  the #4 commit leg fires too).
- Screen: right (the count is even correct). Notice: nobody — until the
  reads fence or a budget test runs; then immediate with the exact attribution
  (`issue:2820` iterates).

### P4 untracked state (branch `n1b-p4-untracked-state`, patch `n1b-p4-untracked-state.patch`)

Plant: plain `refreshed: Set` + `refreshedViews: Map` instance fields on
`MobxPool` (`false` annotations), consulted in `IssueModel.view`, cleared in
`applyLocals` on `coarseNow`. Two shapings on the way: (1) a zero-tracked-dep
variant tripped MobX's own "derivation without observable" warning under the
arm's warn trap (artifact, not P4); (2) fill-on-every-recompute made even the
mount history (fence steps fired) and broke the ticked pair (post-tick
snapshot refilled). Final: the derivation always runs tracked (enforcement
ON=OFF, per K MobX D) but plain state picks previous-vs-fresh; a row joins
the set only when a pass gives it a NEW value — the reference `guardSet`
semantics exactly.

- typecheck SILENT (green). lint-fence SILENT (instance field + `false`;
  module scope is the separate measured `no-hidden-state` record).
- commit-fence SILENT, reads-fence SILENT, parity SILENT — the fixed steps
  (one change per fresh mount) cannot carry history, as catalogued.
- gate FIRED — `same row twice, nothing between step 3 vs rebuild:
  title: "Probe first title" (expected "Probe second title")`, shrunk to 2
  changes (catalogue §8 verbatim).
- relation-check SILENT. history-check FIRED — step 3 only
  (`[false,false,false,true]`, the reference pin); the `tick between`
  sequence fully green (gate ok, history ok): history, not inputs.
- behaviour-test FIRED (via history + gate).
- arm-tests FIRED — `counts.test.tsx`: `[commits] selectionClick (#3):
  drew 0 rows, the oracle changed 1, under=[i214]` (#1–#4 run on ONE mount,
  so history accumulates); `pool.test.tsx > a click re-derives exactly the
  old and the new selection`: stale `selected=true` after the second click.
- Screen: a row changed twice with nothing between shows the first value;
  heals on the next clock tick. Notice: only a two-change test sees it —
  every single-change view passes.

### P5 missing inverse (branch `n1b-p5-missing-inverse`, patch `n1b-p5-missing-inverse.patch`)

Plant: `PoolRelations.point` — updates (old defined, target non-null) move
the forward entry only, skipping both bucket moves (the one generic path, so
every relation is affected, incl. prefix re-files).

- typecheck SILENT (green). lint-fence SILENT (clean).
- commit-fence SILENT, reads-fence SILENT (#7 reads 1/21), parity SILENT,
  gate SILENT, history-check SILENT — fail-soft: views resolve forward, the
  screen stays right.
- relation-check FIRED — #7 `one-way: issue:i635.parent = issue:i214, but
  issue:i214.children does not hold i635` (24 problems); every sequence step
  one-way (reparents, archive, and session worktree moves).
- behaviour-test FIRED (via the relation check).
- arm-tests FIRED — `relations.test.ts`, 30 failures, first:
  `issue.parent/children > insert attaches both directions; a reparent
  detaches the old and attaches the new: expected [ 'I3', 'I4' ] to deeply
  equal [ 'I4' ]` (plus R4 edges, lanes/repos, 7/7 random-sequence seeds vs
  the from-scratch scan).
- Screen: right throughout. Notice: never from the screen; the relation
  check / arm suite fires at once.
