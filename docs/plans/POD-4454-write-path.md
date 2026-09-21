# POD-4454 — MobX arm write-path sketch

One optimistic title rename through the arm's own write idiom. Spike at
`packages/worklist-proto/arms/mobx/spike/` (separate entry, excluded from line
counts, never imported by the production path).

## How a write enters

`PendingTitles.applyPending(id, title)` (spike-only helper, same shape a
production `store.write` would take): capture the model's borrowed value as
`prior`, call `store.apply({ type: 'update', rows: [{ kind: 'issue', id, value:
{ ...prior, title } }] })`, and record `pending.set(id, { prior, title })`.
`store.apply` IS the action — one publication, one notification pass — so the
pending row flows through the ordinary dataflow (tables → buckets → summary →
rollup → order/groups → row) and commits exactly like a kernel write: the
renamed row plus i1's origin tick, which quotes i0's title and rides the
commit (2 rows / 2 derived, the same pair M2's rename commits). No separate
optimistic layer exists.

## Pending representation

A side map `pending: Map<id, { prior, title }>` beside the tables. The tables
themselves hold the pending value (borrowed by reference like every stream
row); the mark lives outside them so reconciliation can tell "this table value
is mine" from "this table value is the kernel's". A render-time pending
indicator would read the same map through an `observer` row check (not built
in the spike); the flag is plain state, never observable, so it adds no
subscriptions.

## Echo reconciles

The kernel echo arrives as an ordinary stream `update` (scenario 9's
transport: `writeTitleRename` dual-write, flushed through the row source). It
carries the title the pending write set — a real echo confirms the value the
client sent — so it settles with zero commits, and the helper clears the mark
when the echoed title matches the pending title. Parity with the legacy oracle
goes red during the pending window (the arm shows what the user typed, the
kernel has not confirmed it — that divergence IS optimism) and green again at
echo. No special-case code runs on this path.

## Rejection reconciles

The kernel rejects (no echo ever arrives). The helper re-applies the captured
`prior` row object through `store.apply` — the same action the stream speaks —
and clears the mark. The model's borrowed value is the `prior` object again;
parity never diverged from the kernel's view because the kernel never moved.
Parity green at all three states (pending is self-consistent by construction,
echo and rejection match the oracle).

## What the kernel still owns

Transport, retry, ordering, authority, persistence, conflict resolution,
readmission replay. The arm never writes to the replica, never synthesises
server timestamps, never queues. A write the kernel replays later (offline
readmission) arrives as an echo the arm cannot distinguish from a fresh edit —
which is correct, because after readmission it IS the effective row.

## Judgement

Rollback is fully expressed without special cases: pending-apply and
prior-restore are the same `apply(update)` the stream already speaks, and the
action boundary makes the two writes atomic with the flag. Dead-letter is
half-expressed: the pending map can hold a rejected write with its error, but
surfacing it needs a row-visible field plus a render read — no new level, one
new read. Readmission needs nothing in the arm: the kernel owns the queue and
the arm owns applying whatever the stream says, so a replayed write reconciles
like an echo. Net: the idiom covers optimism's steady state and its two exits
with one map and zero new levels; only the user-visible failure surface is new
work, and it is one read, not a layer.
