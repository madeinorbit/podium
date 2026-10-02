# Client slowness after the sidebar pilot landing

Issue: POD-5175, under POD-4286. Date: 2026-10-02.

Status: measurement in progress. No performance or memory conclusions yet.

Compare production web clients built in detached worktrees at `a5f55925f` and
`721dd6937`, against the operator’s running server on ludovico. The report branch
starts at `integrate/4286-pilot` (`e3108bf53f`). No product changes are planned.

Use one local headless Chromium sequentially, with isolated browser storage and the
existing CLI session. Exercise startup, idle, incoming updates and scrolling only.
Measure retained heap after forced GC for at least ten minutes in each supported
mode: sidebar off, sidebar on, and sidebar on with the legacy comparison enabled.
Capture CPU attribution and allocation/GC evidence locally, reduce to counts,
timings, function names and sizes, and delete raw captures before handoff.

The Linux Chromium measurements can distinguish shared web-client costs. They do
not establish the operator’s macOS switch state or reproduce WebKit/native-shell
costs; those limits will remain explicit.

## Confirmed setup and visibility facts

The live server reports `0.1.1-dev.233+721dd69`, wire version 3, and schema digest
`6ce8d313a50dba81`. The two detached web build tasks were cache hits and were
restamped for their exact commits using the repository build helpers; no source
files in those worktrees were changed.

The existing principal’s shared layout restores a **collapsed sidebar**. The
read-only matrix measures that rail. Expanding it writes a synchronized preference,
so no expanded-sidebar measurement is claimed. The first harness readiness check
incorrectly waited for the expanded list; those four-minute attempts are excluded
from startup timing and leak conclusions. The corrected baseline mounted the rail
in 10.095 seconds. A separate local decoder consumed 24,983 bootstrap rows in
5.968 seconds; this is a transfer/decode measurement, not the browser’s startup.

The installed server’s `features.state` returns `devMode=false`, `channel=edge`,
`podium-development.enabled=true`, and `mobx-sidebar` with `visibility=hidden`,
`listed=false`. `getFeatureStates` defines dev mode as the version being exactly
`dev`; a packaged `0.1.1-dev…` release does not satisfy that sentinel. The Podium
development preference does not set this sentinel. `ExperimentalSection` filters
on `listed` before its special pilot toggle can render. The toggle’s local pilot
preference is also distinct from the catalog flag’s enabled value.

The input-to-paint panel counts click and keydown events until a double-rAF
boundary. It includes all main-thread work before that boundary, not just sidebar
rendering, and it does not count wheel events. This investigation uses a separate
wheel timestamp → double-rAF collector. Reproducing the operator’s exact selection
percentiles would mark rows read, so it is excluded and the limitation was mailed
to POD-4286. Linux Chromium cannot establish the macOS app’s local pilot preference
or native/WebKit-specific costs.

## Completed legacy controls (interim)

Each control used a fresh profile, one browser, the unchanged production bundle,
48 wheel inputs in four short bursts, continuous real updates, 4 ms CPU sampling,
5-second heap-size sampling, and forced GC once per minute. The updated off-mode
also opened its new perf panel; the old commit has no such panel. Its sampled
instrumentation ancestry accounts for 4.40 seconds of the ten-minute CPU profile,
so these controls are not a perfectly identical instrumentation comparison.

| Measurement | `a5f55925f`, legacy | `721dd6937`, pilot off |
| --- | ---: | ---: |
| Retained-heap observation span | 600.0 s | 598.8 s |
| Retained heap, first → last forced GC | 138.8 → 144.2 MB | 153.1 → 146.8 MB |
| Largest 5-second sampled used heap | 552.1 MB | 619.9 MB |
| Main-thread task time | 269.8 s | 309.5 s |
| Received live delta frames | 1,066 | 1,115 |
| Scroll timestamp → double-rAF p50 / p95 | 51.8 / 670.2 ms | 54.3 / 617.0 ms |
| Scroll event queue delay p95 | 521.4 ms | 494.4 ms |
| `computeMissionIssueIds` sampled self time | 68.5 s | 79.5 s |
| Natural GC reclaimed in final-minute trace | 4,181.1 MB / 60.2 s | 3,718.2 MB / 60.4 s |

The old build already has severe update-driven main-thread work and allocation
churn. The newer off-mode window consumed 14.7% more task time while receiving
4.6% more delta frames, but its scroll p95 was lower. These sequential windows
have different live events and background host load; they do not establish a
causal version regression. GC reclamation is measured churn, not an exact
allocation-rate counter. The deliberately forced final collection is excluded
from the natural-GC figures.

Source-mapped hot functions include `computeMissionIssueIds`, `modelsFor`,
`deriveIssueViews`, `indexMissionSessions`, `buildUnifiedRows`, and
`dedupeSessionsByResume`. The expensive update ancestry runs through
`SocketHub.drainFeedIngress`, replica commit/publication, and legacy derivation.
The new sidebar's own idle meter does not cover this whole path.

## Completed collapsed-rail pilot controls (interim)

The on-only window retained 195.7 → 193.4 MB after GC (599.2 s); on+check
retained 196.3 → 200.8 MB (600.4 s). The latter has a small positive drift,
not a demonstrated multi-gigabyte retained leak. Natural GC reclaimed
1,590.7 MB in the on-only final-minute trace and 1,758.4 MB with checking.
The 2.5 GB peak did not reproduce in these fresh, collapsed, unselected clients.

Pilot-on task time was 152.6 s versus 309.5 s off. Adding the checker raised
it to 202.0 s; source-mapped comparison ancestry accounted for 50.6 s across
109 completed checks, about 464 ms per check. The comparison revived
`computeMissionIssueIds` (22.4 s self time; absent from on-only samples).
The final checker state was a match with zero differences.

Additional expanded-sidebar and diagnostics-off controls are pending. The
coordinator relayed permission for real row clicks, but automatic approval
review rejected that authority as insufficient to override the original
no-click constraint. Direct operator approval has been requested; no row
click or mark-read write has occurred. The newer no-click expansion probe
restored an already-open sidebar; server layout before/after was identical.
