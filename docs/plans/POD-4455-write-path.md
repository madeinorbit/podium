# POD-4455 — TanStack DB arm write-path sketch

One optimistic title rename through the arm's own write idiom. Spike at
`packages/worklist-proto/arms/tanstack/spike/` (separate entry, excluded from
line counts, never imported by the production path). Production keeps the
kernel as the only writer; this sketch judges what the idiom would express
if optimism ever moved onto the arm.

## How a write enters

`PendingTitles.applyPending(id, title)` (spike-only helper, same shape a
production `store.write` would take): open a `createOptimisticAction` whose
`onMutate` stages the title with a direct
`entities.issues.collection.update(id, draft => …)` — transaction-local
optimistic state, never the sync interface (that channel is the kernel's;
bare `collection.update` outside a transaction throws `MissingHandlerError`,
verified by probe). The rowsQ subscription marks the row dirty exactly like
a kernel write; one commit pass (`finishCycle` — production would expose it
as `flush()`) commits the pending row: 1 row / ordinary derivations, parity
red against the oracle while pending (the divergence IS optimism).

## Pending representation

The Transaction itself (`isPersisted` pending → persisted/failed). No side
map: the tables' synced state is untouched, the shadow lives in the
transaction. A render-time pending indicator would read transaction state
through a row check (not built in the spike) — one new read, no new level.

## Echo reconciles

The kernel echo arrives as an ordinary stream `update` carrying the title
the pending write set. The transport resolves only after the echo synced
back (the docs' sync-back rule); the shadow drops onto the identical value
with zero commits (`rollupsDerived` 1 — the echo's summary fold re-runs and
settles equal) and parity green. No special-case code runs on this path.

## Rejection reconciles

The kernel rejects (no echo ever arrives). The transport rejects, the
TRANSACTION rolls back by itself — the spike re-applies nothing — and the
rollback's change events (surfacing as `insert`, the M2 finding) mark the
row dirty; the same commit pass recommits the prior value with parity
green. One observable difference from the MobX arm: rollback restores the
prior VALUE with fresh row identity (1 restoring commit), not the original
object — the commit layer assembles rows anew instead of borrowing
references. Components re-render the restored row; nothing goes stale.

## What the kernel still owns

Transport, retry, ordering, authority, persistence, conflict resolution,
readmission replay. The arm never writes to the replica, never synthesises
server timestamps, never queues. A write the kernel replays later arrives
as an echo the arm cannot distinguish from a fresh edit — correct, because
after readmission it IS the effective row.

## Judgement

Rollback is fully expressed without special cases: pending-stage and
transaction-rollback are the same collection-update channel the stream
already speaks, and the commit pass is shared — zero new levels, zero
restore code (against the MobX arm's one-map-plus-restore, which is also
zero levels but hand-rolled). Dead-letter is half-expressed: a rejected
transaction can hold its error, but surfacing it needs a row-visible field
plus a render read — no new level, one new read. Readmission needs nothing
in the arm: the kernel owns the queue. Two prices, both named: optimism
needs a public commit flush (one method — transaction-local state emits
change events pre-commit, verified, but nothing drives the commit pass
outside `dispatch`), and rollback costs one restoring commit where MobX
pays zero (fresh identity vs borrowed reference). Net: the idiom covers
optimism's steady state and both exits with no side map and no restore
path; only the flush bridge and the failure surface are new work.
