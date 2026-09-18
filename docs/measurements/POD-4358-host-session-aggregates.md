# Host session aggregate scans

B13 follows B8's component-local material cache (07d2f50fb). HeaderHostIndicators
and LoadPanel each retain their latest session scope. Same-array renders return
without reading a session; replaced arrays compare machineId, status, cwd, archive
membership, resume capability and agent phase. Changed material builds all machine
counts and the occupancy key in one pass. Host names and idle-policy targets are
formatted separately so renames and settings take effect immediately.

## Armed scan control

The production selector and legacy facts helpers run against 4,304 sessions, two
named machines and an undefined-machine request. Three renders follow excluded
warmup. A Proxy counts numeric row reads, including both filter and iterator
access. Every output is compared against the legacy result. The legacy arm must
exceed the optimized replacement budget: disabling the cache cannot pass it.

| Three renders after warmup | Legacy row reads (asserted) | Cached row reads (asserted) | Cached aggregate builds |
| --- | ---: | ---: | ---: |
| Same session array (disconnected/clock control) | >12,912 | 0 | 0 |
| New arrays/entities, titles only (connected churn control) | >12,912 | 12,912 | 0 |

These are deterministic scan-count controls, not live elapsed-time measurements.
The legacy calls perform nine full scans per frame for this fixture (116,208
row reads over three frames by inspection); the test deliberately asserts the
budget rejection rather than freezing that legacy implementation detail.

Material-change tests compare results with the old helpers after machine, status,
archive, cwd, resume and phase changes, missing phase, removal, reorder and empty
scope. They also check independent selector scopes, immaterial title/agent-kind
changes and hostname/target formatting. Archived residents still occupy worktrees;
undefined machines still return zero counts; starting/reconnecting sessions count
as resident but not idle-live. No wire, data or policy semantics change.

## Validation

Committed implementation before validation. The initial attempt could not load
Vitest in this fresh checkout; `bun run setup:worktree` installed local links.
Then ran:

```
bun run test:file -- packages/client-core/src/viewmodels/host-session-aggregates.test.ts packages/client-core/src/viewmodels/slices/machines/host-pressure.test.ts apps/web/src/features/machines/multimachine-indicators.test.tsx
```

Result: node group 2 files / 23 tests passed; web group 1 file / 16 tests passed.
Three named files, 39 tests, zero failed groups. This is focused unit/component
evidence, not a full suite, typecheck, browser or live CPU result. No external
interaction boundary changed.

## Baseline and attribution

The pre-fix live evidence is `POD-4286-post-b-live.json` at post-B c728e9c25:
connected machine-facts inclusive 1,283.95 ms / 66.210 s; disconnected 715.41 ms /
66.080 s; second connected 1,626.54 ms. Those measurements are not replaced by this
hermetic fixture. The [refreshed baseline](POD-4358-post-b-baseline.md) now pins integrated B13
candidate 4b9d7618b, including connected/disconnected and cold/warm-switch windows.
Later pilot comparisons must use that baseline rather than inherit these gains.

## Revert and limits

Revert this issue's commits to restore direct facts calls in both components.
The legacy helpers remain available as the counterfactual; no migration or state
cleanup is needed. A2 `hostSessions.materialScan` and `hostSessions.aggregateBuild`
counters use the component selector as owner and are disabled by default. Enable
with `__podiumStoreStats.enable()`; disable with `.enable(false)`.

New arrays still require O(sessions) comparison. Material changes additionally
build O(sessions) aggregates and sort resident cwd entries, as occupancy did before.
The cache assumes immutable session arrays, like the repository usage selector.
