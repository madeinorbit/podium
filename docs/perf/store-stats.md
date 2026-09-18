# Store boundary counters

The A2 collector is local, bounded, and **off by default**. It does not change publish
suppression, callback ordering, batching, reactions, cache keys, or React scheduling.
No snapshot values, draft text, prompts, entity IDs, mark metadata, or feed payloads
are recorded. Runtime IDs are anonymous process-local numbers. Switch IDs are copied
from POD-701 solely to join the two reports.

## Capture one operation

In devtools after the store module has loaded:

```js
const stats = globalThis.__podiumStoreStats
stats.enable()
stats.reset()
// Perform one session-switch gesture, then wait for its interactable mark.
const report = stats.snapshot()
stats.enable(false)
```

`beginSwitch` opens a gesture window; accepted `markSwitch` calls attach cumulative
counter checkpoints; switch finalization (including timeout/replacement) closes it.
Join `report.windows[].switchId` with `__podiumSwitchTraces.recent()[].switchId` for
POD-701 timings. Enabling mid-switch does not retroactively open a window.

For an explicitly driven feed batch or A3 fixture:

```ts
import { storeStats, readRuntimeStoreStats } from '@podium/client-core/perf'
storeStats.enable()
storeStats.reset()
const window = storeStats.begin('feed')
try {
  // Apply the batch, and await/act through React's commit before ending.
} finally {
  storeStats.end(window)
}
const counts = readRuntimeStoreStats(runtime)
const report = storeStats.snapshot()
storeStats.enable(false)
```

The importable `readStoreStats()` and `readRuntimeStoreStats(runtimeOrReplica)` are
A3's test-side readers. Reads return detached copies; reset clears diagnostic data
without touching stores, selector caches, slice caches, or the older projection
counters. Reset preserves enabled state. Disable stops accumulation and closes the
current window; it preserves captured data until reset.

Only one capture window is active at once. Opening another closes the previous one;
there is no async context propagation. Attribution means work observed **during**
that window, not proof that the gesture caused every concurrent feed/timer event.
Per-runtime rows and publish key sets help distinguish that work. Work after the
window closes remains in runtime totals and uncorrelated publication records.

## What each counter means

| Field | Counted event |
| --- | --- |
| `publishes` | Snapshot accepted by the subscription store after its existing equality check |
| `nestedPublishes` | Accepted publish while that runtime is inside `react()`; subscriber reentrancy alone does not set this flag |
| `publishes[].changedKeys` | Names from the existing `apply()` changed-key set, never values; generic standalone stores may omit this metadata |
| `subscriberWakes` | Callback invocation, immediately before the call, including callbacks that throw |
| `publishes[].subscriberWakes` | Callback invocations belonging to this particular publish, even during reentrant publishes |
| `selectorRuns`, `selectorCacheMisses` | Actual `useStoreSelector` execution after a snapshot/closure cache miss; currently one execution per miss |
| `slices[name]` | Actual slice derivation, after the existing identity/dependency guard; shared readers do not multiply it |
| `rowBuilds` | Same row-build attempt boundary as `issueViewModelProjectionStats(replica).rowBuilds`, attributed via the owning runtime |
| `reactCommits` | Explicit React Profiler callback for the measured subtree, independent of selector evaluations |

To measure commits, mount **one** `StoreStatsProfiler` from
`@podium/client-core/react` inside `StoreProvider` around the measured subtree, or
call `recordStoreReactCommit(runtime)` from an existing Profiler `onRender`. No
Profiler is automatically inserted into the product. Use development React or a
profiling-enabled build. Without that boundary, zero means **unmeasured**, not zero
React work. Multiple/nested profilers count multiple observations, not unique root
commits. Mount commits count if capture is already enabled; reset after mounting
when measuring updates. Aborted render work can increase derivations/selectors
without increasing commits.

## Bounds and disable path

The collector retains at most 32 runtime aggregates, 32 capture windows, 256 publish
records, 64 slice names per aggregate, 32 runtime aggregates per window, and 64
scalar checkpoints per window. Each publication retains at most 256 key names.
Diagnostic names and switch IDs are capped at 80 characters. These are fixed bounds,
independent of session length. Owners/replicas are weakly associated; diagnostic
records hold no runtime, snapshot, subscription, or entity references.

`dropped` signals eviction or a capacity refusal. After it moves, retained detail
must not be treated as a complete event log. The recent publish ring may wrap while
retained runtime totals still count every publish. A runtime aggregate evicted after
32 distinct runtimes starts fresh if it later records again. Reset before bounded
comparisons and inspect `dropped` when interpreting details.

`enable(false)` is the immediate disable path. Reload also restores off. Nothing
persists or sends these stats to the server. Reverting this issue removes all hooks;
it does not require a schema migration or data cleanup.

## Evidence and overhead

The focused React fixture exercises the real `useStoreSelector`, `useSlice`, and
Profiler bridge, with a fake provider runtime backed by the real subscription
store. Two readers each use one selector and one shared slice. One feed window
changing `view` records one publish, four wakes, two selector runs/misses, one slice
derivation, zero row builds, and one React commit. A fresh snapshot with the same
selected value records the same store work and **zero** commits. An equal snapshot
records no additional work at all. This is a controlled fixture, not a live-client
latency or navigation baseline.

Projection tests independently connect the actual issue-model cache's positive
row-build count to the new counter and prove that rereading the cache adds zero.
The runtime test drives a controlled synchronous reaction and proves two publishes,
one nested publish, two callbacks, and the exact changed-key sets. Existing store
and switch-trace tests cover unchanged subscription/trace behavior. Positive exact
counts fail if hooks are removed; zero ceilings alone are never the evidence.

Disabled overhead is a boolean-guarded call per instrumented boundary (including
per subscriber), plus reaction-depth increment/decrement/`finally` and one weak
replica ownership association at construction. No counter records or changed-key
arrays are allocated while disabled. Enabled capture adds bounded aggregate updates,
publish records and changed-key copies; switch checkpoints sum the bounded runtime
aggregates. Snapshot reads clone the bounded report and are deliberately outside
the hot path. SlicePublisher's pre-existing derivation map remains unchanged.

The focused counter test includes a local microbenchmark: seven rotating-order
rounds of 20,000 primitive publishes with two subscribers, comparing the original
loop, disabled instrumentation and enabled instrumentation with a feed window.
All modes must invoke exactly 40,000 callbacks per round. The measurement isolates
the store loop; it excludes real snapshot construction, key copies, selector/slice
CPU, React, report cloning, and instrumentation in runtime reactions. It is not an
end-to-end overhead percentage or a timing regression gate on this shared host.

Measured on this checkout (2026-09-18, Bun 1.4.2, shared Linux host):

| Mode | Median µs/publish | Added µs vs original | Callbacks / 20,000 publishes |
| --- | ---: | ---: | ---: |
| Original loop | 0.02954 | — | 40,000 |
| Instrumentation disabled | 0.21960 | 0.19006 | 40,000 |
| Instrumentation enabled, active feed window | 0.99369 | 0.96415 | 40,000 |

The disabled primitive-loop cost is about 7.4× this extremely small baseline;
enabled is about 33.6×. These ratios are **not** whole-runtime slowdowns. Absolute
added costs and the benchmark exclusions above are the useful scope of this result.
The enabled microbenchmark wraps the detail ring intentionally; runtime totals still
assert all 20,000 publishes and 40,000 wakes.

Validation: scoped `bun run typecheck -- --filter @podium/client-core` passed.
`bun run test:file --` over `perf/store-stats.test.ts`, `react/store-stats.test.tsx`,
`engine/runtime.test.ts`, `replica/issue-view-cache.test.ts`, `store.test.ts`, and
`perf/switch-trace.test.ts` (all under `packages/client-core/src`) executed **139
passing tests in six files**, not the full suite. The numerical console output was
suppressed by interception in that run; the single overhead case was rerun through
`test:file` with `-t 'measures disabled' --disableConsoleIntercept`, executing one
case (four skipped) to obtain the table above. No browser or production runtime was
driven: this task changes instrumentation, not an external interaction boundary.
