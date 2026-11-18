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
write, not the sum of two independently computed percentiles. The scheduler slot also
spans post-commit publication. The four-workspace control measures the current
combined scheduler/database serialization policy, not a measured relaxation of
the database lock alone.

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
Native driver time sums pipeline execution and response handling, without the
injection. Native statement time is a subset, counted once per batch. These and
the injected-delay measurements are aggregate call budgets: independent calls or
delays can overlap, so they are not an exclusive wall-time partition. The
reported residual (hold minus native and injected sums) can therefore be negative
and must not be interpreted as CPU time.
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

**16 of 32 configurations complete.** The one-process runs below passed all
source-table controls and reported no acquisition failures or rollbacks. The
two-process runs and final focused validation remain pending; this is not the
final handoff.

Measured runtime and load sources: `6a43434583`, unchanged through
`d1978ce6f4` (the later commit refreshes generated test metadata). All timings
come from the same agent VM, on the Postgres 17 test container. Duration triples
are p50 / p95 / p99 in milliseconds. Throughput is committed write transactions
per second. With one writer, only one of four configured workspaces is active.

### 1 process(es), 0 ms injected latency

| Writers | Workspaces | Total tx/s | Mean tx/s per active workspace | DB wait p50 / p95 / p99 | Queue p50 / p95 / p99 | Total wait p50 / p95 / p99 | Hold p50 / p95 / p99 | RT/tx |
| ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: |
| 1 | 1 | 76.65 | 76.65 | 0.91 / 3.02 / 5.80 | 0.00 / 16.00 / 35.00 | 1.30 / 19.63 / 40.51 | 8.53 / 26.80 / 43.82 | 9.99 |
| 1 | 4 | 73.82 | 73.82 | 0.89 / 3.10 / 5.54 | 0.00 / 16.00 / 29.00 | 1.40 / 18.35 / 34.19 | 8.65 / 28.10 / 42.24 | 9.99 |
| 4 | 1 | 83.59 | 83.59 | 1.25 / 3.51 / 6.41 | 38.00 / 136.00 / 198.00 | 39.70 / 138.32 / 199.10 | 8.25 / 25.53 / 37.63 | 10.30 |
| 4 | 4 | 224.73 | 56.18 | 0.98 / 2.96 / 5.16 | 0.00 / 21.00 / 37.00 | 1.82 / 23.93 / 39.84 | 11.97 / 41.79 / 58.58 | 9.99 |
| 16 | 1 | 90.23 | 90.23 | 1.17 / 3.04 / 4.70 | 185.00 / 453.00 / 658.00 | 186.97 / 453.90 / 659.50 | 7.78 / 25.48 / 34.24 | 10.28 |
| 16 | 4 | 224.10 | 56.03 | 1.20 / 3.25 / 5.66 | 59.00 / 187.00 / 246.00 | 60.98 / 188.11 / 248.85 | 12.93 / 42.03 / 63.33 | 10.25 |
| 64 | 1 | 98.52 | 98.52 | 1.09 / 2.78 / 4.23 | 694.00 / 2253.00 / 2494.00 | 694.70 / 2254.09 / 2495.04 | 6.99 / 22.38 / 31.83 | 9.98 |
| 64 | 4 | 228.82 | 57.20 | 1.17 / 3.12 / 6.09 | 286.00 / 840.00 / 948.00 | 287.23 / 840.89 / 949.19 | 13.09 / 39.73 / 56.47 | 10.25 |

Mean aggregate call timings in ms/transaction. These are not an exclusive wall-time partition: calls/delays may overlap, and statement/capture columns are subsets. Residual may be negative.

| Writers | Workspaces | Hold | Native driver | Native statements | Injected waits | Capture drain | Residual |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 10.21 | 9.32 | 7.20 | 0.00 | 0.72 | 0.89 |
| 1 | 4 | 10.51 | 9.54 | 7.38 | 0.00 | 0.67 | 0.97 |
| 4 | 1 | 9.94 | 9.54 | 7.46 | 0.00 | 0.61 | 0.40 |
| 4 | 4 | 14.79 | 14.77 | 10.49 | 0.00 | 1.19 | 0.02 |
| 16 | 1 | 9.26 | 8.23 | 6.13 | 0.00 | 0.61 | 1.02 |
| 16 | 4 | 15.96 | 16.02 | 11.53 | 0.00 | 1.21 | -0.06 |
| 64 | 1 | 8.42 | 7.61 | 5.60 | 0.00 | 0.56 | 0.81 |
| 64 | 4 | 15.57 | 15.68 | 11.28 | 0.00 | 1.19 | -0.11 |

### 1 process(es), 2.6 ms injected latency

| Writers | Workspaces | Total tx/s | Mean tx/s per active workspace | DB wait p50 / p95 / p99 | Queue p50 / p95 / p99 | Total wait p50 / p95 / p99 | Hold p50 / p95 / p99 | RT/tx |
| ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: |
| 1 | 1 | 23.16 | 23.16 | 0.75 / 2.05 / 3.94 | 0.00 / 44.00 / 77.00 | 1.37 / 45.12 / 78.33 | 30.44 / 104.95 / 126.55 | 9.97 |
| 1 | 4 | 22.19 | 22.19 | 0.79 / 2.50 / 9.06 | 0.00 / 53.00 / 86.00 | 1.46 / 54.68 / 86.51 | 31.78 / 109.57 / 127.22 | 9.96 |
| 4 | 1 | 25.17 | 25.17 | 0.84 / 1.90 / 3.65 | 138.00 / 402.00 / 459.00 | 139.06 / 403.22 / 459.54 | 30.69 / 103.27 / 117.35 | 10.22 |
| 4 | 4 | 99.09 | 24.77 | 0.60 / 1.66 / 3.21 | 0.00 / 34.00 / 54.00 | 0.98 / 35.17 / 55.00 | 29.31 / 104.38 / 119.34 | 9.97 |
| 16 | 1 | 26.45 | 26.45 | 0.85 / 2.61 / 7.73 | 636.00 / 1708.00 / 2184.00 | 637.07 / 1709.44 / 2185.37 | 30.26 / 103.28 / 114.29 | 10.06 |
| 16 | 4 | 102.39 | 25.60 | 0.80 / 2.41 / 5.26 | 133.00 / 390.00 / 469.00 | 134.55 / 390.77 / 469.24 | 30.70 / 106.57 / 118.16 | 10.23 |
| 64 | 1 | 27.89 | 27.89 | 0.91 / 2.56 / 5.63 | 2701.00 / 6178.00 / 7080.00 | 2702.04 / 6179.44 / 7081.34 | 29.21 / 101.11 / 111.90 | 9.59 |
| 64 | 4 | 102.39 | 25.60 | 0.79 / 1.99 / 5.73 | 625.00 / 1937.00 / 2464.00 | 625.76 / 1940.95 / 2466.02 | 29.87 / 100.78 / 118.29 | 10.06 |

Mean aggregate call timings in ms/transaction. These are not an exclusive wall-time partition: calls/delays may overlap, and statement/capture columns are subsets. Residual may be negative.

| Writers | Workspaces | Hold | Native driver | Native statements | Injected waits | Capture drain | Residual |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 35.85 | 12.40 | 9.71 | 24.16 | 2.88 | -0.71 |
| 1 | 4 | 37.36 | 13.66 | 10.91 | 24.45 | 2.87 | -0.74 |
| 4 | 1 | 35.53 | 11.69 | 8.89 | 24.67 | 2.69 | -0.84 |
| 4 | 4 | 33.55 | 10.01 | 7.28 | 24.83 | 2.84 | -1.29 |
| 16 | 1 | 33.56 | 9.90 | 7.15 | 24.33 | 2.58 | -0.67 |
| 16 | 4 | 34.79 | 10.44 | 7.59 | 25.60 | 2.80 | -1.24 |
| 64 | 1 | 31.51 | 9.10 | 6.34 | 23.09 | 2.43 | -0.69 |
| 64 | 4 | 33.74 | 9.81 | 7.06 | 25.10 | 2.70 | -1.18 |

### 2 process(es), 0 ms injected latency

| Writers | Workspaces | Total tx/s | Mean tx/s per active workspace | DB wait p50 / p95 / p99 | Queue p50 / p95 / p99 | Total wait p50 / p95 / p99 | Hold p50 / p95 / p99 | RT/tx |
| ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: |
| 1 | 1 | 76.06 | 76.06 | 0.88 / 3.03 / 5.44 | 0.00 / 16.00 / 36.00 | 1.37 / 18.58 / 40.51 | 8.16 / 28.49 / 48.92 | 9.99 |
| 1 | 4 | 83.19 | 83.19 | 0.84 / 2.89 / 4.78 | 0.00 / 15.00 / 28.00 | 1.36 / 18.31 / 31.19 | 7.63 / 24.62 / 37.10 | 9.99 |
| 4 | 1 | 75.59 | 75.59 | 10.41 / 36.04 / 49.28 | 36.00 / 108.00 / 158.00 | 47.87 / 134.84 / 177.72 | 11.03 / 36.64 / 48.74 | 10.11 |
| 4 | 4 | 226.32 | 56.58 | 0.96 / 3.00 / 5.52 | 0.00 / 19.00 / 33.00 | 1.81 / 21.79 / 35.83 | 12.01 / 40.76 / 58.40 | 9.99 |
| 16 | 1 | 85.68 | 85.68 | 9.02 / 32.75 / 40.43 | 177.00 / 556.00 / 674.00 | 187.69 / 576.45 / 692.97 | 9.74 / 32.84 / 41.33 | 10.26 |
| 16 | 4 | 300.69 | 75.17 | 9.96 / 36.26 / 52.08 | 35.00 / 112.00 / 145.00 | 47.61 / 130.03 / 167.85 | 10.21 / 36.26 / 51.16 | 10.16 |
| 64 | 1 | 95.07 | 95.07 | 8.12 / 29.52 / 37.64 | 647.00 / 2269.00 / 2788.00 | 659.31 / 2283.74 / 2804.75 | 8.69 / 29.95 / 37.52 | 10.17 |
| 64 | 4 | 299.98 | 75.00 | 9.81 / 34.89 / 50.38 | 201.00 / 592.00 / 687.00 | 213.10 / 608.39 / 707.91 | 10.50 / 34.81 / 49.07 | 10.32 |

Mean aggregate call timings in ms/transaction. These are not an exclusive wall-time partition: calls/delays may overlap, and statement/capture columns are subsets. Residual may be negative.

| Writers | Workspaces | Hold | Native driver | Native statements | Injected waits | Capture drain | Residual |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 10.23 | 9.43 | 7.32 | 0.00 | 0.62 | 0.80 |
| 1 | 4 | 9.36 | 8.54 | 6.58 | 0.00 | 0.62 | 0.81 |
| 4 | 1 | 13.16 | 11.34 | 8.76 | 0.00 | 0.78 | 1.81 |
| 4 | 4 | 14.58 | 14.45 | 10.15 | 0.00 | 1.17 | 0.13 |
| 16 | 1 | 11.62 | 9.91 | 7.41 | 0.00 | 0.73 | 1.71 |
| 16 | 4 | 13.11 | 12.52 | 8.90 | 0.00 | 1.02 | 0.59 |
| 64 | 1 | 10.47 | 8.99 | 6.56 | 0.00 | 0.69 | 1.48 |
| 64 | 4 | 12.98 | 12.46 | 8.97 | 0.00 | 0.97 | 0.52 |

### 2 process(es), 2.6 ms injected latency

| Writers | Workspaces | Total tx/s | Mean tx/s per active workspace | DB wait p50 / p95 / p99 | Queue p50 / p95 / p99 | Total wait p50 / p95 / p99 | Hold p50 / p95 / p99 | RT/tx |
| ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: |
| 1 | 1 | 23.78 | 23.78 | 0.71 / 1.54 / 4.27 | 0.00 / 41.00 / 76.00 | 1.06 / 41.83 / 78.35 | 30.38 / 105.63 / 117.31 | 9.97 |
| 1 | 4 | 23.37 | 23.37 | 0.74 / 2.04 / 5.78 | 0.00 / 37.00 / 62.00 | 1.28 / 38.03 / 63.14 | 30.02 / 104.29 / 123.22 | 9.97 |

Mean aggregate call timings in ms/transaction. These are not an exclusive wall-time partition: calls/delays may overlap, and statement/capture columns are subsets. Residual may be negative.

| Writers | Workspaces | Hold | Native driver | Native statements | Injected waits | Capture drain | Residual |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 35.02 | 11.93 | 9.35 | 23.84 | 2.72 | -0.75 |
| 1 | 4 | 35.48 | 12.09 | 9.35 | 24.04 | 2.77 | -0.65 |

## Provisional interpretation

The one-process hosted result meets the predeclared criterion: at 16 writers,
p95 total workspace write wait is **1,709.44 ms**, above both 50 ms and the
uncontended median hold of 30.44 ms. The four-workspace control raises throughput
from **26.45 to 102.39 transactions/s (3.87×)**. Most of this one-process wait is
in the scheduler; the two-process runs are still needed to quantify contention
at the database lock itself.

For the same 16-writer workload, removing the added 2.6 ms latency raises the
one-workspace rate from 26.45 to **90.23 transactions/s (3.41×)**. The measured
four-workspace control therefore provides more throughput than this
latency-removal proxy. The result does not demonstrate that POD-7030 would move
capacity more than lifting the one-writer policy. Batching also changes native
work and potentially transactions per application operation, so the proxy is
not an implementation or a hard ceiling for POD-7030. Its proposed 25-round-trip
budget (versus the existing 134-trip message pin) has not been implemented or
measured here.

Even with no added latency, the one-workspace rate saturates near 90–99
transactions/s, and the four-workspace control is 2.48× faster at 16 writers.
Round-trip reduction is valuable, but this experiment gives no basis for treating
the remaining workspace limit as already solved by it. A final verdict awaits
the two-process comparison and validation. No stage 2 design is included.
