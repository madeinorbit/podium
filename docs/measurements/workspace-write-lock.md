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

## Instrumentation

`store/executor/workspace-write-metrics.ts` records process-local diagnostics,
keyed by workspace. The optional `PerfSnapshot.workspaceWrites` type lives in
`packages/protocol/src/perf.ts`; the existing `perf.snapshot` query selects only
its transport-derived workspace. There is no wire-version change. Internal
measurement probes can read all workspace entries in their own server process.

The recorder retains at most 128 workspace entries, evicting the least recently
written entry. Each duration histogram has fixed bucket counters and a ring of
512 recent samples. Lifetime count/sum/max and recent nearest-rank p50/p95/p99
are separate quantities. The rate histogram covers complete one-second intervals
in the last minute, including idle seconds; the partial current second is
excluded. Its 60 slots need no timer. `writesPerSecond` is committed workspace
write transactions divided by time since that entry was first observed, not row
mutations or application operations. Eviction/restart resets an entry's history.

No statement, round trip, timer, capture write or transaction boundary is added.
Only existing driver pipelines are timed. The baseline is the minimum of the
last 32 successful single-step pipelines in that driver's pool; no calibration
query is sent. Estimated database lock wait is the BEGIN-plus-lock reply time
beyond that baseline. It includes residual lock-statement processing and local
scheduling, so submillisecond values must not be read as exact Postgres wait-event
measurements. Before a baseline exists the wait is absent, not zero, and
`uncalibratedWaits` counts it. Hold is BEGIN request to COMMIT/ROLLBACK reply minus
that estimated wait: a conservative client-observed duration, including normal
BEGIN/COMMIT transport. Root writes use the existing lock reply in their single
pipelined unit. Failed acquisitions, confirmed rollbacks and other failures have
separate counters; only acknowledged commits count toward throughput.

Scheduler queue wait ends at workspace-slot admission and excludes connection-pool
acquisition. A lease's queue is charged once even if its post-commit work opens
another transaction. `writeWaitMs` is the distribution of the **paired sum** per
write, not the sum of two independently computed percentiles.

## Load method

The script creates one disposable Postgres template clone per configuration; it
does not accept a live database URL. One or two child processes compose independent
production `SessionRegistry`/`SessionStore` graphs, schedulers and 10-connection
pools on that database. Within a process, four workspace stores share the pool
and scheduler exactly as the server does. Stores and members are provisioned
before service composition. The fake daemon launches no real agents or PTYs.

Each active writer owns a running, bound session and repeatedly performs four
operations: an assistant runtime transcript event through the daemon gateway,
`messages.send` through the tRPC caller, `effects.create` through `sync.submit`
and the real claim/run/settle runner, then terminal output and the coalesced
activity flush that upserts sessions. The effect executor performs no external
work. This measures server/store paths, including their permission checks,
capture, record builds, feed appends and post-commit work, without HTTP or real
daemon execution latency. Every source table must receive writes; a refused
effect, failed acquisition or rollback makes the configuration fail.

Setup and one warm cycle per writer are excluded. Each writer runs without think
time for 15 seconds, completes its admitted cycle, then drains broadcasts, feed
delivery and effects. Elapsed time includes that drain. Percentiles in the tables
use **all** committed writes in the window, rather than the production ring's
last 512. Full JSON also carries per-workspace window statistics, operation counts,
the revision, and cumulative production metric snapshots (which include setup).
With one writer, only one workspace can be active in the four-workspace control.

The existing round-trip probe injects the selected latency before each waiting
driver call, with fractional milliseconds preserved. The script uses its same
timer-plus-yield method and records the actual injected time inside explicit
writes. Injection before BEGIN or an atomic root unit is outside its hold.
Native driver time includes pipeline execution and response handling, without the
injection. Native statement time is a subset of it, counted once per batch.
Capture drain wall time includes its injection and is another **overlapping
subset** of hold, not a term to add to the native/injected breakdown. It measures
`SyncRepository.drainCapture`, not all later record building and feed appending.

Run on the agent VM, taking the approved remote lane lease. Each call below runs
eight configurations sequentially and emits `WORKSPACE-LOCK-RESULT` after each,
so an interruption preserves completed results. Each lease must remain under
20 minutes; do not run calls concurrently.

```sh
bun --conditions=@podium/source scripts/measure-workspace-writes.ts --matrix --processes 1 --latency-ms 0 --seconds 15 --recorder-cost
bun --conditions=@podium/source scripts/measure-workspace-writes.ts --matrix --processes 1 --latency-ms 2.6 --seconds 15
bun --conditions=@podium/source scripts/measure-workspace-writes.ts --matrix --processes 2 --latency-ms 0 --seconds 15
bun --conditions=@podium/source scripts/measure-workspace-writes.ts --matrix --processes 2 --latency-ms 2.6 --seconds 15
```

## Results

Pending measurement on the agent VM.
