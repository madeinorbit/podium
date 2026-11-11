# ADR 2 — Amendment 2: model bootstrap and feed retention

Status: chosen by the operator, 2026-11-10; disk validation recorded before landing.
Issue: POD-6771, under POD-6253. Replaces ADR 2 D5's 20,000 rows / 3 days.

The model tables are the only source of current records. Bootstrap streams them
in one read snapshot stamped with the feed head, and sharing checks build their
subjects from those tables. Every kind compares records around its source write.
The `change_latest` copy, its write path and its repository reads are removed.
There is no boot reconciliation or declared-change fallback. This supersedes the
POD-678 materialized copy and the proposed POD-6228 batching fix.

Keep catch-up actions for at most **30 days** and at most **500,000 rows per feed**,
whichever removes more. A fixed plan chooses the larger sequence cutoff, then
maintenance deletes bounded batches from the head. Event clocks that move
backwards may shorten the contiguous window further; trimming never creates
holes inside the retained range. Empty logs preserve the highest assigned number.

This deployment has one database feed. Both budgets belong to that feed, not to
an aggregate of tenant feeds. The hosting phase partitions retention by tenant
alongside the tenant key and sequence allocator; a busy tenant must shorten only
its own catch-up window. This amendment does not add a shared multi-tenant store.

A cursor whose next required number is below the retained floor reloads current
model rows. Pruning every log row therefore loses no current data. Existing
covered-range watermarks, evictions, visibility checks and cursor boundary rules
remain in force. The client wire version stays **5** for the epic.

The limits balance a month of ordinary offline use against a bounded disk cost
under a flood. The design workload after slimming is 4,600 actions in 7.1 hours:
about 15,549 a day, or 466,479 in 30 days. At that rate age is the stricter limit;
the cap reaches about 32.2 days. Faster feeds reach the cap earlier.

Before landing, measure the allocated SQLite file and indexes at the cap using
slim actions from the bench candidate (`scripts/server-data-bench/retention-disk.ts`).
Record the measured bytes per row, total at 500,000 rows, and projected 30-day
cost in the issue's attached measurement report. This measures allocation rather
than JSON length alone. Revisit the limits from measured feed size and activity;
no snapshot cache is introduced by this decision.
