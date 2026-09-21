# POD-4453 — hand-rolled arm write-path sketch

One optimistic title rename through the arm's own write idiom. Spike at
`packages/worklist-proto/arms/hand/spike/` (separate entry, excluded from line
counts, never imported by the production path).

## How a write enters

`applyPendingTitle(id, title)` (spike-only helper, same shape a production
`store.write` would take): read the current table row as `prior`, dispatch a
synthetic `update` event carrying `{ kind: 'issue', id, value: { ...prior,
title } }`, and record `pending.set(id, { prior, title })`. The pending row
flows through the ordinary dataflow (tables → indexes → summary → visible →
rollup → order/groups → rows) and commits exactly like a kernel write — one
row, one derivation, one notification. No separate optimistic layer exists.

## Pending representation

A side map `pending: Map<id, { prior, title }>` beside the tables. The tables
themselves hold the pending value (borrowed by reference like every stream
row); the mark lives outside them so reconciliation can tell "this table value
is mine" from "this table value is the kernel's". A render-time pending
indicator would read the same map through a `pending:<id>` subscription key
(not built in the spike).

## Echo reconciles

The kernel echo arrives as an ordinary stream `update` (scenario 9's
transport: `writeTitleRename` dual-write, flushed through the row source).
The store applies it over the pending value; the helper clears the mark when
the echoed title matches the pending title. Parity with the legacy oracle
goes red during the pending window (the arm shows what the user typed, the
kernel has not confirmed it — that divergence IS optimism) and green again at
echo. No special-case code runs on this path.

## Rejection reconciles

The kernel rejects (no echo ever arrives). The helper dispatches an `update`
carrying the saved `prior` row object and clears the mark — a re-apply of the
prior row through the same dispatch path. The committed row object is the
`prior` object again; parity never diverged from the kernel's view because the
kernel never moved.

## What the kernel still owns

Transport, retry, ordering, authority, persistence, conflict resolution,
readmission replay. The arm never writes to the replica, never synthesises
server timestamps, never queues. A write the kernel replays later (offline
readmission) arrives as an echo the arm cannot distinguish from a fresh edit —
which is correct, because after readmission it IS the effective row.

## Judgement

Rollback is fully expressed without special cases: pending-apply and
prior-restore are the same `dispatch(update)` the stream already speaks, and
the rebuild oracle covers both states (spike asserts incremental-equals-rebuild
at pending, echo and rejection). Dead-letter is half-expressed: the pending
map can hold a rejected write with its error, but surfacing it needs one new
delta kind plus a row field — the exhaustiveness check turns that from a
silent omission into a compile error, which is the idiom working as designed.
Readmission needs nothing in the arm: the kernel owns the queue and the arm
owns applying whatever the stream says, so a replayed write reconciles like an
echo. Net: the idiom covers optimism's steady state and its two exits with
one map and zero new levels; only the user-visible failure surface is new
work, and the compiler prices it.
