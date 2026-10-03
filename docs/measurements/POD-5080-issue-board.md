# Issue board and explorer pool reads

The board and explorer read issues, session membership, parentage, dependencies and
rollups through the existing MobX pool when the startup switch `mobxBoard=1` is enabled.
The default remains legacy. The existing shared pilot preference and URL precedence
are latched at startup; pool attachment cannot change which hooks run. UI components
and the existing store actions/outbox keep their roles.

## Browser measurement

Captured on flatblock in minified production Chromium 153.0.8010.12, with Bun 1.4.2
and the checkout-local toolchain. The existing fixed 4× corpus contains 19,468 issues
and 17,208 sessions. The board has 8,696 root cards; Planning selects 178 cards.
Each capture uses a trusted pointer event, observes the selected DOM and reads the
first actual Paint from the browser trace. The final arms run legacy, pool, pool,
legacy in separate browser contexts. Both arms use the existing sidebar pool.

| Capture | Source | Board open, ms | Planning filter, ms |
| --- | --- | --- | --- |
| Before, legacy | `5df5c0de0e` | 711.376, 634.325 | 105.256, 106.310 |
| Final, legacy controls | `4307f338eb` | 1242.068, 645.105 | 115.433, 104.594 |
| Final, pool | `4307f338eb` | 673.379, 599.898 | 108.356, 88.263 |

The two samples per arm describe these captures. The final legacy open values have
a wide spread; the counters establish the change in work independently of that
spread. On the pool path the board and explorer rendered output equals legacy for
initial and Planning views, including row positions, totals and selection attributes.
The final count-only Chromium check repeats those views after rebasing at
`dc86cc8e74`: rendered parity and both diagnostics remain equal, with zero
legacy board derivations and the same initial/final residency census.

### Work and residency

| Work | Open | Planning change |
| --- | ---: | ---: |
| Pool ID queries | 1 | 1 |
| Resident index candidates examined | 8,718 | 180 |
| Matched IDs | 14,337 | 179 |
| New rich row models | 96 | 3 |
| Cold summary visits | 10,578 | 10,578 |
| Cold summary traversal, ms | 100.1, 66.6 | 19.9, 15.7 |
| Facet cold visits | 10,578 | 0 |
| Facet traversal, ms | 96.1, 71.9 | 0 |
| Legacy board/explorer derivations | 0 | 0 |
| Legacy issue row builds | 0 | 0 |

The legacy controls record two board derivations and 19,468 issue row builds on
open, and one board derivation on filtering. The pool starts and ends with 8,890
resident issues and 10,578 cold issues after board and explorer interactions.
The initial census also equals the legacy arm, catching loads requested during
source installation before the first gesture.

Rich models follow the existing virtual window and separately addressed action or
detail rows. The resident-only index limits a Planning query to its matching
bucket; the focused scaling check adds 1,500 nonmatching resident issues and still
examines one candidate. Facets retain their observation across filter changes.

There is an explicit temporary exception to end-to-end visible-row scaling:
each demand query traverses known cold IDs through declared summaries. This is
O(known cold IDs), measured above, under the coordinator's POD-5244 decision.
The demand result retains IDs only and releases on filter change or unmount.
There is no standing cold index or full collection hydration.

The resident index costs 1,818.8/1,830.9 ms at source attachment, paid before the
fixture becomes ready and separately from board input-to-Paint. POD-5371 tracks
reducing that startup work. These results do not claim that first application
startup is faster.

### Regression fixes captured separately

| Pool iteration | Source | Open, ms | Filter, ms |
| --- | --- | --- | --- |
| Repeated queries/facets removed | `639e910b6d` | 2365.724, 2320.203 | 373.499, 320.730 |
| Rich models restricted to virtual window | `6fe34105e1` | 1422.634, 1326.326 | 283.375, 292.681 |
| Summary fields plus shared projection retention | `4307f338eb` | 673.379, 599.898 | 108.356, 88.263 |

The virtual-window iteration builds 288 rich models on open and six on filtering.
The final iteration also incorporates POD-5347's shared stable-reader fix at
`e3b8928e1a`; its counts are 96 and three. Its additive `summary-fields` mode of
the same `pool.row` returns the existing declared cold summary without a union
clone or worklist `flatUntil` calculation. Pending overlays and missing-summary
LOADING/batched loads remain shared with the original reader. Existing `summary`
mode still decorates identically. The table reports the combined final change;
it does not attribute all its improvement to either fix alone.

## Verification

Focused flatblock validation executed 90 checks across 14 named files: 19 checks
in five graph files and 71 in nine web files. These cover 22 normalized synthetic
board/explorer comparisons, scoped ID-result release, resident-index scaling,
overlays, summary-only cold reads, loading, virtual-card counts/progress, fleet
ordering after resume collapse, the startup switch, attachment, close guards,
and existing board/list/explorer behavior. The real StoreProvider and pool host
also transition from pending to ready with the shell's startup initialization,
without React errors or legacy derivations. This is a focused result.
That attachment check also remains green after the shell-screen registration
landed at `de74a6cfd5`; the board uses the same host and startup initialization.

The focused typecheck for client-core, client-graph and web is green (15 tasks).
The changed graph files pass the MobX/read-boundary ESLint fence.
Biome passes the 25 new files, with warnings limited to test/harness assertions
and fixture typing conventions.

All 33 planted controls fail their expected assertions and restore the original
bytes. Four run the real Chromium count-only comparison with actual incorrect
rendered titles, legacy derivation calls, cold-row promotion and incorrect
diagnostic values. The remaining focused controls cover virtual/addressed rows,
child counts and progress, fleet order, projection lifetime, declared summaries,
both internal and external old-summary compatibility, summary identity,
overlays, loading, index scaling/release, parent scope, attention, mismatch
detection, legacy-read counters, the real startup attachment, supplied close
sessions and the default-off switch. Each case copies the file aside, commits the plant, runs its exact
check, copies the original back and verifies byte equality.

The ludovico-only read-only replay compares 6,045 operator issues and 5,160
sessions in 16 cases, with zero differences or pending results. Its private pool
has 2,834 resident issues before and after, with 3,211 cold issues. Only counts
and field positions are emitted; authentication and payloads stay on ludovico.
An actual planted row-priority error previously turned that replay red at a
reported row position and was restored byte-for-byte.

The required five-action speed gate is green at `6dc275c551`, six samples per
action, `mobxBoard=1`, 133.648 seconds including the build:

| Action | Median, ms | Worst, ms |
| --- | ---: | ---: |
| Sidebar issue | 137.358 | 152.686 |
| Mission switch | 1250.920 | 1366.391 |
| Session pane | 1022.275 | 1161.606 |
| Issue rename | 778.341 | 861.645 |
| Unrelated visible update | 896.654 | 983.643 |

Every median stays within the gate's fixed 10% regression margin against the
corrected pilot-OFF reference. The coordinator explicitly keeps that baseline
unchanged; the saved passed report is attached to the issue.

## Activation and retirement

Use `?mobxBoard=1` when starting the client to select this screen's pool path;
`?mobxBoard=0` selects its existing legacy path. `mobxBoardCheck=1` installs the
count/position-only side-by-side diagnostics. Changes to the URL or preference
after startup do not change the selected path.

POD-5348 tracks deleting the screen's legacy branches about a week after the
operator enables it by default. The existing mutation owner remains in place.
The app-wide snapshot pipeline retirement belongs to step 07.
