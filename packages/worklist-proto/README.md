# @podium/worklist-proto

Round-two worklist prototypes (POD-4442, methodology `docs/plans/pod-4286-prototype-methodology.md`
rev 4). Three independent, first-principles implementations of the frozen slice
(`docs/plans/pod-4441-round-two-slice.md`), each as good as its approach allows, none bolted
onto the current code, all fed only by the kernel's per-row change stream.

## Folders and who may write in them

- `shared/` — owned by the slice spec (POD-4442). Frozen shapes every arm, the fixture,
  the oracle and the harness build against. Changes need the coordinator (POD-4286 session A).
  No imports from legacy view-model / slice / mission / presentation / replica-view code.
- `arms/hand/` — owned by the hand-rolled arm (POD-4446). Incremental view maintenance
  with typed deltas; no whole-table enumeration on ordinary deltas.
- `arms/mobx/` — owned by the MobX arm (POD-4447). Tracked object graph with enforcement on.
- `arms/tanstack/` — owned by the TanStack DB arm (POD-4448). Everything relational is a query.
- `harness/` — owned by the measurement harness (POD-4445). The fixture + oracle (POD-4443)
  and the row stream + scenarios (POD-4444) land here unless those issues relocate them with
  coordinator approval.

## Rules for every folder

- Greenfield: no imports from `packages/client-core/src/viewmodels/`, `slices/`, `mission.ts`,
  `presentation/`, `replica/issue-view*` (H4 shape review gate).
- The coarse clock is data (`SliceLocals.coarseNow`), never `Date.now()` in a derivation.
- Selection is a local, never a row field.
- No app imports this package: it must not enter the web bundle budget or the app builds.
