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

(clean baseline + per-probe records go here)
