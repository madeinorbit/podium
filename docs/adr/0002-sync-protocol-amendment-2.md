# ADR 2 — Amendment 2: model bootstrap and feed retention

Status: chosen by the operator, 2026-11-10; disk limits confirmed on the bench, 2026-11-11.
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

The limits balance a month of ordinary offline use against a bounded retained row count
under a flood. The design workload after slimming is 4,600 actions in 7.1 hours:
about 15,549 a day, or 466,479 in 30 days. At that rate age is the stricter limit;
the cap reaches about 32.2 days. Faster feeds reach the cap earlier.

The bench measurement on 2026-11-11 replayed 10,000 slim candidate actions
(9,350 session and 650 issueProjection) to the proposed cap in a temporary SQLite
file with the production columns and both indexes, then compacted it with
`VACUUM`. At 500,000 rows it allocated **549,388,288 bytes (523.94 MiB)**,
or **1,098.74 bytes per action** above the empty file's 20,480 bytes. The
projected design-rate 30-day window is **512,557,571 bytes (488.81 MiB)**.
These measured costs confirm the starting **30-day / 500,000-row** limits.

This is a compacted feed allocation estimate, excluding other model tables and
WAL files; record sizes and steady churn can change the allocated file size.
The [measurement report](../measurements/pod-6771-copy-retention.md) records the
source revisions, method and A/B results. Reproduce the cap measurement with
`scripts/server-data-bench/retention-disk.ts` against a stopped candidate arm.
Revisit the limits from measured feed size and activity; no snapshot cache is
introduced by this decision.
