# Refreshed post-B comparison baseline

B13 is included in runtime **4b9d7618b**, on `integrate/4286-frontend-perf`.
This baseline supersedes c728e9c25 for subsequent pilot timing; C1 remains a historical report.
The host aggregate fix is Phase B work and must not be credited to a later pilot.

## Method

Reused the archived C1 collector and seven-line temporary publication/derive timer
patch. Built this checkout under `bun scripts/test-heavy.ts -- bun .b13/build.ts`,
then ran cold and warm captures sequentially under the same heavy wrapper.
Production React, Chromium 148.0.7778.96, 1600×1000, no throttling, service workers
blocked; loopback preview :55658 proxied the unchanged live backend :18787.
Fresh authenticated contexts; ten-second settle, 65.8-second connected/disconnected/
reconnected windows, 30 cold switches across six session-backed rows, then 14 warm
switches across two of those rows, with 1500 ms dwell. Preview and browsers stopped;
temporary source instrumentation removed. Bundle `index-BC3ykpj3.js`, build hash
`02f62ccb6eeb36bf`. Source maps resolve 1 ms CPU samples offline.

The refreshed cold corpus has 4,887 issues, 4,323 sessions, 501 repositories, six
machines and 211 visible rows. C1 had 4,884 issues and 4,321 sessions. Live events,
targets and shared-host load are not frozen: these timings describe each run, not
an isolated causal milliseconds-saved estimate. The armed unit control in the
[implementation report](POD-4358-host-session-aggregates.md) supplies causal scan evidence.

## Host work comparison

The new column is the union of `facts.ts` and `host-session-aggregates.ts` stacks,
so moving work into a new module cannot remove it from the accounting. Buckets
overlap other application/React work and must not be summed with those timings.

| Window | Old duration s | New duration s | Old machine facts ms | New host total ms | Material scans / builds |
| --- | ---: | ---: | ---: | ---: | ---: |
| connected-idle | 66.21 | 66.48 | 1283.95 | 2.99 | 0 / 0 |
| disconnected-idle | 66.08 | 66.11 | 715.41 | 1.07 | 0 / 0 |
| activity | 66.17 | 66.10 | 1626.54 | 7.52 | 0 / 0 |
| cold-rotation | 145.12 | 136.20 | 3029.31 | 427.55 | 3 / 0 |
| warm-rotation | 52.29 | 50.93 | 849.56 | 127.10 | 4 / 0 |

The disconnected control received exactly one `coarseNow` publication, with zero
material scans, zero aggregate builds and zero dropped diagnostics. Connected
idle and reconnected activity also recorded no host material scans/builds and no
dropped diagnostics. This confirms the clock-only repeated-scan failure is removed.
Cold switching had 118 generic diagnostic drops; its counter totals are retained
with that limitation, not treated as an exact zero-build acceptance claim. CPU
profiles and publication/derive arrays are independent of that bounded counter log.

## Remaining baseline measurements

| Window | Publications | Worklist derives / ms | Switch traces / timeouts | Switch p50 / p95 ms |
| --- | ---: | ---: | ---: | ---: |
| connected-idle | 28 | 1 / 89.50 | — | — |
| disconnected-idle | 1 | 1 / 104.80 | — | — |
| activity | 30 | 1 / 57.10 | — | — |
| cold-rotation | 195 | 75 / 9676.20 | 30 / 0 | 1172.00 / 1959.80 |
| warm-rotation | 68 | 28 / 4098.10 | 14 / 0 | 1046.80 / 4471.20 |

All numeric counters, CPU buckets, largest self-time frames, native metrics and
heap endpoints are retained in [the numeric baseline](POD-4358-post-b-live.json).
Switch quantiles exclude timed-out traces. These results do not establish that
the epic performance budgets pass or approve a reactive-library pilot.

## Evidence and reversal

Raw collectors, patch, profiles and captures are archived locally at
`/home/mgw/pod4286-evidence/b13-post-b/raw-evidence.tar.gz`. Raw session identifiers
and traces are not uploaded; the attached report and numeric summary omit them.
The preview bundle/source maps remain checkout-local. Revert implementation
commit `4c503f88a` to restore direct scans; the legacy helpers remain the armed
counterfactual. No migration or installed-runtime change is involved.
