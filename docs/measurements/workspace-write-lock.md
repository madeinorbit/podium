# Workspace write lock measurement

Stage 1 of POD-7029; parent: `integrate/6951-cloud-hosting`. Stage 2 is outside this
change and requires an approved design through the coordinator.

## Decision rule, recorded before measurement

Use 16 concurrently active sessions as the busy-workspace decision point; 64 is a
stress case, not an assertion about typical use. Each writer repeatedly drives real
server paths without think time. This is an intentionally busy upper bound.

Amended before any load measurements at the coordinator's direction: the
scheduler already serializes writers in one process, so database lock wait
alone would hide the one-process limit. The decision uses the per-transaction
sum of scheduler queue wait and database lock wait (workspace write wait).

Stage 2 merits design consideration if, at 16 writers with 2.6 ms injected per
database round trip, p95 **workspace write wait** exceeds both 50 ms and
the median uncontended write transaction hold time, and spreading the same total
load across four workspaces improves total write throughput by at least 50%.
Waiting longer than one normal transaction means contention compounds transaction
cost; 50 ms avoids treating submillisecond noise as a product bottleneck. The
four-workspace control distinguishes workspace serialization from a shared CPU or
database ceiling. Report scheduler queue, database lock wait and their paired
sum separately, for both one and two independent server processes on one database.
Exceeding the threshold is evidence for a design review, not authorization
to lift the lock.

Compare 0 ms and 2.6 ms injected latency before deciding priority: removing round
trips shortens both the work and the lock hold. Quantify the portion of hold time
spent awaiting injected round trips and the four-workspace throughput headroom;
do not present that headroom as a measured implementation of concurrent writes.

## Method and results

Pending measurement on the agent VM.
