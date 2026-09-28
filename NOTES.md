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
