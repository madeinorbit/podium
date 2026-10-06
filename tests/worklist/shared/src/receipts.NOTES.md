# POD-4554 (L3b) receipts — notes

## Decisions

- **accepted = outbox `applied`, not the echo.** Per the L1c write contract (W7):
  the v2 wire row carries no mutation id, so an echo cannot name its
  transaction. The acceptance line "a press yields exactly one accepted on
  echo" is met as: the press yields exactly one `accepted` (at apply), the echo
  and a duplicate echo yield nothing.
- **Kernel seam (additive).** `ClientRuntime.subscribeOutboxOutcomes(listener)`
  reports `applied | rejected | superseded` per mutation id, fired AFTER the
  runtime's own handling; a throwing listener is logged and skipped.
  `ClientRuntime.enqueueOverlayed(kind, input, { mutationId })` is the same
  seam `EngineActions` uses, now public with an optional caller-named id.
  `EngineOutboxCallbacks` gains `onSuperseded` and a `reason` argument on
  `onDropped`; both queues report them. No existing caller changes behaviour.
- **Superseded carries kind/id** because the kernel adapter snapshots the
  queued entries an enqueue may collapse (same collapse key) before the kernel
  removes them. Only the kernel queue collapses.
- **One outcome per txId per subscription.** A later outcome for the same id is
  dropped (recovery-surface retry that applies; a throw racing the drain). The
  set grows by one uuid per write for the subscription's life: fine for the
  prototypes.
- **Enqueue failure → rejected** only when the entry is in neither the queued
  nor the awaiting home; otherwise the kernel still owes the outcome.
- **pending().base** is parsed from the entry's enqueue-time `baseline`
  fingerprint (the replica row), for the patched slice fields only. The kernel
  queue keeps `baseline` in memory, so entries restored by a reload have no
  base (the contract allows it: "when the kernel kept them").

## Known limits

- The compatibility (legacy) queue's `sweepExpired` never calls `onPoison`, so
  an aged-out entry there yields no `rejected`. Nothing in production calls
  `sweepExpired`; the kernel queue (web) reports `max-age` dead letters through
  `dead-lettered`, which does produce `rejected`.
- `rejected` error `message` is built from the refusal code; the raw server
  error text is not carried (the kernel queue does not keep it).
