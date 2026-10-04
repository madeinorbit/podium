# OLD versus NEW whole-app measurements

Measurement is still in progress. Across two matched 1x web rounds, NEW switches sessions faster (791 to 418 ms median), but starts slower (2.27 to 3.59 s), opens the issue page slower (109 to 236 ms), and expands a populated project slower (91 to 204 ms). The large mission median shows no clear improvement (735 to 803 ms). Background CPU is being repeated with the corrected publication recipe; 4x, five-minute heaps and the deletion build remain. OLD phone cannot boot with this shared corpus, so phone improvement remains unproven.

## Compared applications

- **NEW**: `1aa0ec71f68c5c6569560798db00a82a1db9f82d`
- **OLD**: `5e3ece5cd68c5fbd7dbd8b1dcfa6d92a35f42cbb`

OLD corpus seed 4443: 4,867 issues and 4,304 sessions at 1x; 19,468 issues and 17,216 sessions at 4x. Two real isolated control issues and their live agents exercise mutations. OLD controls are matched to their contemporary NEW build using comparisonArm; later OLD controls are not pooled into the earlier NEW comparison. Both arms consume the same serialized semantic corpus; the per-run digest proves the match. OLD receives its legacy issue and issue-projection rows; NEW receives normalized issue/session personal state and git/machine facts. Optional null strings are omitted to satisfy the production wire schema.

Performance evidence: 4 completed measurement runs and 0 failed measurement runs. 36 calibration, superseded or diagnostic runs are retained separately and excluded from comparisons.

This is a comparison of shipped application revisions, including their other changes and different data representations. It does not isolate MobX as the sole cause. The operator requested NEW be repinned from 22b676a741 to 1aa0ec71f6 during collection. The earlier NEW captures are retained as superseded evidence and do not enter the verdict.

## Latency, milliseconds

Lower is better. Percent change is `(NEW / OLD − 1) × 100`. Percentiles use nearest rank; median averages the middle pair. Profiled samples are excluded. Cached phone Work can return using only composited pixels: its boundary is DrawFrame when no new raster Paint occurs, and its CPU boundary is the last completed main-thread trace event before that frame, a conservative lower bound if work overlaps the frame; wider CDP task CPU also remains raw. Differences within ±10% are labelled no clear improvement; this is a reporting band, not a statistical confidence interval. With 8 or 16 observations, nearest-rank p95 equals the maximum; it is a limited tail estimate, not an independent tail measurement.

| Surface | Scale | Action | NEW arm | OLD n | NEW n | OLD median | NEW median | OLD p95 | NEW p95 | Median change | p95 change | OLD max | NEW max | NEW boundary | Verdict |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| web | 1 | app-cold-start | new | 8 | 8 | 2,267.8 | 3,585.2 | 3,421.0 | 5,357.3 | 58.1% | 56.6% | 3,421.0 | 5,357.3 | Paint | slower |
| web | 1 | app-warm-start | new | 8 | 8 | 1,173.1 | 2,185.1 | 1,360.1 | 3,339.3 | 86.3% | 145.5% | 1,360.1 | 3,339.3 | Paint | slower |
| web | 1 | board-open | new | 16 | 16 | 329.2 | 391.8 | 586.6 | 594.9 | 19.0% | 1.4% | 586.6 | 594.9 | Paint | slower |
| web | 1 | board-search | new | 16 | 16 | 58.2 | 120.4 | 127.6 | 174.7 | 106.9% | 37.0% | 127.6 | 174.7 | Paint | slower |
| web | 1 | command-palette | new | 16 | 16 | 105.3 | 154.7 | 483.8 | 450.4 | 47.0% | -6.9% | 483.8 | 450.4 | Paint | slower |
| web | 1 | dock-close | new | 16 | 16 | 73.4 | 60.2 | 91.0 | 120.1 | -17.9% | 31.9% | 91.0 | 120.1 | Paint | faster median, worse tail |
| web | 1 | dock-open | new | 16 | 16 | 87.5 | 85.1 | 117.9 | 189.3 | -2.7% | 60.5% | 117.9 | 189.3 | Paint | similar median, worse tail |
| web | 1 | flight-deck-collapse | new | 16 | 16 | 42.6 | 41.9 | 50.1 | 48.0 | -1.5% | -4.1% | 50.1 | 48.0 | Paint | no clear improvement |
| web | 1 | flight-deck-expand | new | 16 | 16 | 60.0 | 37.6 | 75.1 | 55.6 | -37.3% | -25.9% | 75.1 | 55.6 | Paint | faster |
| web | 1 | header-menu | new | 16 | 16 | 30.7 | 26.1 | 63.6 | 51.8 | -14.8% | -18.6% | 63.6 | 51.8 | Paint | faster |
| web | 1 | issue-page-open | new | 16 | 16 | 109.4 | 235.6 | 137.3 | 345.3 | 115.4% | 151.4% | 137.3 | 345.3 | Paint | slower |
| web | 1 | issue-picker-search | new | 16 | 16 | 24.3 | 29.9 | 71.6 | 61.5 | 22.8% | -14.0% | 71.6 | 61.5 | Paint | slower |
| web | 1 | issue-rename | new | 16 | 16 | 237.5 | 57.6 | 451.5 | 104.2 | -75.7% | -76.9% | 451.5 | 104.2 | Paint | faster |
| web | 1 | large-mission-switch | new | 8 | 8 | 735.1 | 802.5 | 1,660.1 | 1,589.2 | 9.2% | -4.3% | 1,660.1 | 1,589.2 | Paint | no clear improvement |
| web | 1 | mark-read | new | 16 | 16 | 953.6 | 128.1 | 1,043.5 | 160.8 | -86.6% | -84.6% | 1,043.5 | 160.8 | Paint | faster |
| web | 1 | mission-switch | new | 16 | 16 | 407.5 | 223.4 | 528.6 | 258.1 | -45.2% | -51.2% | 528.6 | 258.1 | Paint | faster |
| web | 1 | session-switch | new | 16 | 16 | 791.0 | 418.4 | 899.2 | 564.0 | -47.1% | -37.3% | 899.2 | 564.0 | Paint | faster |
| web | 1 | sidebar-collapse | new | 16 | 16 | 88.2 | 100.8 | 134.8 | 129.6 | 14.3% | -3.8% | 134.8 | 129.6 | Paint | slower |
| web | 1 | sidebar-drag-drop | new | 16 | 16 | 247.2 | 111.6 | 310.9 | 131.0 | -54.8% | -57.8% | 310.9 | 131.0 | Paint | faster |
| web | 1 | sidebar-drag-start | new | 16 | 16 | 27.0 | 28.4 | 41.8 | 41.4 | 5.2% | -1.0% | 41.8 | 41.4 | Paint | no clear improvement |
| web | 1 | sidebar-expand | new | 16 | 16 | 170.9 | 192.0 | 208.8 | 234.1 | 12.4% | 12.1% | 208.8 | 234.1 | Paint | slower |
| web | 1 | sidebar-group-collapse | new | 16 | 16 | 47.1 | 56.4 | 60.9 | 89.3 | 19.7% | 46.5% | 60.9 | 89.3 | Paint | slower |
| web | 1 | sidebar-group-expand | new | 16 | 16 | 91.4 | 203.9 | 115.3 | 229.8 | 123.0% | 99.3% | 115.3 | 229.8 | Paint | slower |
| web | 1 | sidebar-select | new | 16 | 16 | 297.8 | 148.6 | 390.6 | 214.7 | -50.1% | -45.0% | 390.6 | 214.7 | Paint | faster |
| web | 1 | superagent-composer-typing | new | 16 | 16 | 13.6 | 14.4 | 29.8 | 19.3 | 6.0% | -35.3% | 29.8 | 19.3 | Paint | no clear improvement |

## Main-thread work per action

Main-thread CPU uses Chromium trace thread timestamps (tts/tdur), from the trusted input handler to the qualifying Paint end. It excludes OS descheduling; click latency includes the event queue and waiting. Startup CPU starts at the initialization script, slightly after navigation begins. Layout CPU is the union of Layout and UpdateLayoutTree thread durations in that interval and overlaps total CPU. Task busy wall time and wider CDP polling-window deltas remain in raw data. Source-map profiles separately estimate store/derive and React work; never add overlapping categories. [Chromium performance-agent implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_performance_agent.cc).

| Surface | Scale | Action | NEW arm | OLD CPU median | NEW CPU median | Median change | OLD CPU p95 | NEW CPU p95 | OLD CPU max | NEW CPU max | OLD layout CPU | NEW layout CPU |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| web | 1 | app-cold-start | new | 1,789.0 | 2,918.7 | 63.1% | 2,590.9 | 3,512.8 | 2,590.9 | 3,512.8 | 93.8 | 91.3 |
| web | 1 | app-warm-start | new | 813.0 | 1,786.5 | 119.7% | 875.3 | 2,148.2 | 875.3 | 2,148.2 | 68.0 | 57.1 |
| web | 1 | board-open | new | 281.0 | 359.6 | 28.0% | 347.6 | 406.5 | 347.6 | 406.5 | 67.1 | 63.6 |
| web | 1 | board-search | new | 56.8 | 117.1 | 106.3% | 106.5 | 161.4 | 106.5 | 161.4 | 8.2 | 8.7 |
| web | 1 | command-palette | new | 100.2 | 148.7 | 48.4% | 427.2 | 397.0 | 427.2 | 397.0 | 7.5 | 7.2 |
| web | 1 | dock-close | new | 60.0 | 48.8 | -18.7% | 74.5 | 99.7 | 74.5 | 99.7 | 3.3 | 3.0 |
| web | 1 | dock-open | new | 76.1 | 70.9 | -6.8% | 90.2 | 181.8 | 90.2 | 181.8 | 3.8 | 3.6 |
| web | 1 | flight-deck-collapse | new | 35.0 | 35.6 | 1.6% | 41.3 | 40.5 | 41.3 | 40.5 | 1.8 | 3.1 |
| web | 1 | flight-deck-expand | new | 46.2 | 28.3 | -38.6% | 58.4 | 41.5 | 58.4 | 41.5 | 5.0 | 3.8 |
| web | 1 | header-menu | new | 20.8 | 19.3 | -7.3% | 48.4 | 40.1 | 48.4 | 40.1 | 4.1 | 4.0 |
| web | 1 | issue-page-open | new | 92.4 | 223.7 | 142.1% | 118.7 | 311.8 | 118.7 | 311.8 | 30.0 | 27.0 |
| web | 1 | issue-picker-search | new | 23.9 | 27.5 | 15.1% | 37.7 | 37.8 | 37.7 | 37.8 | 4.6 | 4.7 |
| web | 1 | issue-rename | new | 227.6 | 52.1 | -77.1% | 274.8 | 62.4 | 274.8 | 62.4 | 2.4 | 2.0 |
| web | 1 | large-mission-switch | new | 712.1 | 783.1 | 10.0% | 1,561.0 | 1,548.3 | 1,561.0 | 1,548.3 | 148.2 | 257.4 |
| web | 1 | mark-read | new | 905.5 | 96.7 | -89.3% | 984.3 | 116.5 | 984.3 | 116.5 | 6.7 | 3.7 |
| web | 1 | mission-switch | new | 365.8 | 197.3 | -46.1% | 465.9 | 230.8 | 465.9 | 230.8 | 57.6 | 52.3 |
| web | 1 | session-switch | new | 685.9 | 185.7 | -72.9% | 856.8 | 443.6 | 856.8 | 443.6 | 33.6 | 30.1 |
| web | 1 | sidebar-collapse | new | 79.3 | 95.1 | 19.9% | 102.4 | 115.7 | 102.4 | 115.7 | 18.1 | 17.5 |
| web | 1 | sidebar-drag-drop | new | 27.1 | 24.3 | -10.0% | 49.6 | 38.5 | 49.6 | 38.5 | 3.8 | 3.6 |
| web | 1 | sidebar-drag-start | new | 22.0 | 24.9 | 13.4% | 28.9 | 35.5 | 28.9 | 35.5 | 1.5 | 1.5 |
| web | 1 | sidebar-expand | new | 166.0 | 187.4 | 12.9% | 195.0 | 229.1 | 195.0 | 229.1 | 43.2 | 43.2 |
| web | 1 | sidebar-group-collapse | new | 37.0 | 49.4 | 33.3% | 45.3 | 74.9 | 45.3 | 74.9 | 1.5 | 1.3 |
| web | 1 | sidebar-group-expand | new | 87.4 | 196.8 | 125.3% | 109.9 | 220.9 | 109.9 | 220.9 | 23.5 | 24.7 |
| web | 1 | sidebar-select | new | 280.2 | 131.4 | -53.1% | 339.4 | 187.8 | 339.4 | 187.8 | 38.2 | 38.1 |
| web | 1 | superagent-composer-typing | new | 12.9 | 14.1 | 9.5% | 22.7 | 17.6 | 22.7 | 17.6 | 2.5 | 3.5 |

## Sampled store and React attribution

Requested V8 sampling interval: 100 microseconds. Values below estimate CPU as measured renderer thread CPU multiplied by each category’s share of non-idle sampled stack wall time, during separately profiled input-to-Paint windows. Sampling and OS descheduling can bias these allocations; they are not exclusive hardware counters. Profiled samples are excluded from latency statistics. Sampled wall durations also remain in raw attribution files. React render includes app derivations it calls; store/derive is an inclusive stack match and overlaps React. Commit includes layout effects and called native work; layout hardware CPU appears in the preceding table. Idle, unmapped and other samples are retained in cpu-attribution.json. No exact exclusive store or React hardware-CPU counters are claimed.

| Arm | Surface | Scale | Action | Profiles | Store/derive CPU estimate | React render CPU estimate | React commit CPU estimate | Unmapped wall ms |
|---|---|---:|---|---:|---:|---:|---:|---:|

## Incoming updates and connected idle

Update CPU is the CDP main-thread TaskDuration delta with Performance.enable(timeDomain=threadTicks), measured after one injected update through a 200 ms minimum window and two animation frames. Actual windows can be longer under load and are retained. Quiet windows measure the same instrumentation with no injection. These are observed total CPU costs in a window containing one update, not exclusive causal CPU per update; pending UI tasks, paints and real upstream traffic can overlap. The 60 s connected-idle replay delivers 30 heartbeat changes/minute, 10 issue changes/minute, and 120 terminal output frames/minute (two frames/second). These busy-profile rates are explicit synthetic assumptions, distinct from the historical-rate replay below. This is an idle UI with live data, not a silent disconnected app. Delivery to the visible terminal is verified before replay. Percent CPU means one renderer thread’s fraction of one core, not whole-machine or Mac desktop CPU.

| Arm | Surface | Scale | Update | n | Task CPU ms/window median | p95 |
|---|---|---:|---|---:|---:|---:|

Matched update-window comparisons, without subtracting quiet-window CPU:

| Surface | Scale | NEW arm | Update | n OLD/NEW | OLD CPU median ms | NEW CPU median ms | Change | OLD p95 | NEW p95 |
|---|---:|---|---|---|---:|---:|---:|---:|---:|

The **observed** profile approximates the [September 18 operator publication census](POD-4286-baseline-summary.json): 12 session, 6 issue, 16 machine, 28 conversation, 36 host-metric and 2 draft changes per minute. The minute clock advances normally. These are historical publication rates replayed with validated synthetic payloads, not a capture of historical network frames or today’s traffic. OLD issue/projection rows are sent together as one logical issue update. The **busy** profile adds the stated 30 heartbeat/10 issue/120 output cadence. Both windows use the same visible terminal and selected control mission.

| Arm | Surface | Scale | Profile | Seconds | Updates delivered | Main-thread task ms | One-core CPU % |
|---|---|---:|---|---:|---|---:|---:|

Median of the separate 60-second windows:

| Surface | Scale | NEW arm | Profile | n OLD/NEW | OLD one-core CPU % | NEW one-core CPU % | Change |
|---|---:|---|---|---|---:|---:|---:|

## Retained JavaScript heap

Post-GC Runtime.getHeapUsage usedSize. One startup/5-minute pair per arm/surface/scale is an observation, not leak evidence. Memory runs use meter:flatblock and do not contribute timings.

| Arm | Surface | Scale | Startup MiB | Five minutes MiB | Duration s | Action groups |
|---|---|---:|---:|---:|---:|---:|

| Surface | Scale | NEW arm | OLD startup MiB | NEW startup MiB | Change | OLD five-minute MiB | NEW five-minute MiB | Change |
|---|---:|---|---:|---:|---:|---:|---:|---:|

## Action gaps and defects

OLD phone fails during startup at both 1x and 4x with React error 185, before a usable Work screen. The control-only fixture with two issues can boot, so this is a failure of OLD with this shared corpus, not evidence that every historical phone installation failed. The recorded failure is POD-5505. [React error 185](https://react.dev/errors/185) identifies excessive nested updates.

Consequently OLD has **no phone latency, action CPU, incoming-update CPU, connected-idle CPU, startup heap or five-minute heap comparison** at either requested scale. The unavailable OLD phone actions are cold start, warm start, Work, Tasks/issue screen, mission open, mission details, issue open, parent-picker search, Work search, rename, composer typing and long-press. NEW phone numbers are standalone measurements, never relative wins.

Inbox has no production route/tab in the measured revisions. Its detached component is excluded. The desktop session Chat composer is not available in the isolated agent fixture, despite advertising transcript capability; its typing latency is unavailable in both arms. The desktop global Superagent composer and phone mission composer are measured. This leaves session Chat typing and Inbox performance unresolved.

- NEW web 1x: **large-mission-switch** — TimeoutError: waitForFunction: Timeout 20000ms exceeded.
- NEW web 1x: **session-composer-typing** — TimeoutError: click: Timeout 10000ms exceeded.
- OLD web 1x: **large-mission-switch** — TimeoutError: waitForFunction: Timeout 20000ms exceeded.
- OLD web 1x: **session-composer-typing** — TimeoutError: click: Timeout 10000ms exceeded.

Individual failed attempts, diagnostics, exclusions and exact errors remain in the run ledger and raw files. Long-press includes the product’s 500 ms gesture threshold. Rename starts at submit, after title entry; drag drop starts at pointer release, with drag initiation reported separately. Search starts with the input event that replaces the query and ends only after matching results replace the previous results. Sidebar selection includes issue switching; small mission switching additionally waits for the target mission’s session deck. Mutation and session actions use two small real control missions. The separate large-mission action selects the two largest corpus root trees by assigned descendant sessions; target IDs and actual rendered issue/session counts are recorded. Project folding targets a populated group from the largest root’s corpus repository, not an empty discovered repository.

The first current OLD and NEW 1x large-mission attempts loaded the same incorrect collector witness: the mission root is a header, while the tested row attribute belongs to its children. Those attempts have no large-mission latency and remain collector failures, not application defects. Corrected second rounds supply eight samples for each arm in that cell. Other actions from the first runs remain valid.

The first 1x background windows are excluded from background comparisons because OLD issue updates omitted the legacy issue row and the action workflow could leave different resident panes. Four dedicated background-only captures repeat OLD/NEW/OLD/NEW with complete logical issue updates and fresh matched UI contexts. All later background windows use that corrected recipe. Original observations remain raw; these are collector corrections, not product changes.


## Run order, provenance, host load

Runs execute sequentially on flatblock, one implementation per process. Leases are taken on ludovico after server/browser preparation, released as soon as capture ends. A fresh browser context means cold start; reload of that profile means warm start. Pixel 7 Chromium emulation is phone web evidence, not physical Android/native performance. No CPU or network throttle is applied. No product source is changed. No full test suite runs.

| Started UTC | Mode | Arm | Surface | Scale | Round | Status | Load start (1/5/15m) | Load end | Browser |
|---|---|---|---|---:|---:|---|---|---|---|
| 2026-10-04T12:08:54.644Z | probe | old | web | 1 | 0 | complete | 3.6, 3.7, 4.4 | 4.1, 3.8, 4.4 | 153.0.8010.12 |
| 2026-10-04T12:10:59.980Z | probe | old | phone | 1 | 0 | failed | 3.2, 3.6, 4.3 | 3.2, 3.6, 4.3 | 153.0.8010.12 |
| 2026-10-04T12:13:00.737Z | probe | old | web | 1 | 1 | failed | 3.4, 3.4, 4.1 | 3.4, 3.4, 4.1 | — |
| 2026-10-04T12:15:47.266Z | probe | old | web | 1 | 2 | complete | 2.6, 3.2, 3.9 | 6.2, 4.1, 4.2 | 153.0.8010.12 |
| 2026-10-04T12:18:08.774Z | probe | new | web | 1 | 1 | complete | 4.3, 3.9, 4.1 | 5.0, 4.1, 4.2 | 153.0.8010.12 |
| 2026-10-04T12:18:34.229Z | probe | old | phone | 1 | 1 | failed | 4.6, 4.0, 4.2 | 3.4, 3.8, 4.0 | 153.0.8010.12 |
| 2026-10-04T12:29:31.281Z | probe | new | phone | 1 | 1 | failed | 2.9, 3.5, 3.9 | 3.9, 3.6, 3.9 | 153.0.8010.12 |
| 2026-10-04T12:32:48.721Z | probe | old | phone | 1 | 2 | failed | 3.9, 3.7, 3.9 | 3.2, 3.5, 3.7 | 153.0.8010.12 |
| 2026-10-04T12:38:21.026Z | probe | new | phone | 1 | 2 | failed | 3.3, 3.6, 3.8 | 3.5, 3.7, 3.8 | 153.0.8010.12 |
| 2026-10-04T12:39:55.418Z | timing | old | web | 1 | 100 | failed | 4.9, 4.0, 3.9 | 5.6, 4.1, 3.9 | 153.0.8010.12 |
| 2026-10-04T12:40:24.422Z | timing | new | web | 1 | 100 | failed | 6.6, 4.5, 4.0 | 8.0, 4.8, 4.2 | 153.0.8010.12 |
| 2026-10-04T12:41:33.947Z | timing | old | web | 1 | 101 | failed | 6.2, 4.9, 4.2 | 10.2, 7.7, 5.4 | 153.0.8010.12 |
| 2026-10-04T12:44:32.716Z | timing | new | web | 1 | 101 | failed | 8.9, 7.5, 5.4 | 8.4, 8.0, 6.0 | 153.0.8010.12 |
| 2026-10-04T12:47:58.265Z | timing | old | web | 1 | 102 | complete | 6.3, 7.5, 5.9 | 7.5, 8.7, 6.8 | 153.0.8010.12 |
| 2026-10-04T12:52:20.820Z | timing | new | web | 1 | 102 | complete | 6.9, 8.5, 6.8 | 5.7, 7.2, 6.7 | 153.0.8010.12 |
| 2026-10-04T12:57:29.323Z | timing | old | web | 1 | 103 | complete | 8.2, 7.4, 6.8 | 8.0, 9.0, 7.7 | 153.0.8010.12 |
| 2026-10-04T13:01:19.560Z | timing | new | web | 1 | 103 | failed | 6.4, 8.6, 7.5 | 6.4, 8.6, 7.5 | — |
| 2026-10-04T13:06:51.752Z | timing | new | phone | 1 | 104 | complete | 2.0, 4.2, 5.9 | 8.9, 6.7, 6.6 | 153.0.8010.12 |
| 2026-10-04T13:12:35.149Z | probe | old | phone | 1 | 3 | complete | 5.3, 6.3, 6.4 | 5.1, 6.2, 6.4 | 153.0.8010.12 |
| 2026-10-04T13:16:17.522Z | timing | old | phone | 1 | 0 | failed | 2.5, 4.4, 5.6 | 2.5, 4.4, 5.6 | 153.0.8010.12 |
| 2026-10-04T13:16:35.620Z | timing | new | phone | 1 | 0 | complete | 2.5, 4.3, 5.6 | 6.2, 5.3, 5.7 | 153.0.8010.12 |
| 2026-10-04T13:21:26.747Z | timing | old | phone | 1 | 1 | failed | 5.7, 5.3, 5.7 | 5.7, 5.3, 5.7 | 153.0.8010.12 |
| 2026-10-04T13:21:46.429Z | timing | new | phone | 1 | 1 | complete | 5.8, 5.3, 5.7 | 3.0, 5.0, 5.5 | 153.0.8010.12 |
| 2026-10-04T13:26:40.742Z | timing | old | phone | 4 | 0 | failed | 4.3, 5.2, 5.5 | 4.3, 5.2, 5.5 | 153.0.8010.12 |
| 2026-10-04T13:27:03.225Z | timing | new | phone | 4 | 0 | complete | 4.1, 5.0, 5.5 | 4.1, 5.3, 5.6 | 153.0.8010.12 |
| 2026-10-04T13:34:11.450Z | timing | old | phone | 4 | 1 | failed | 3.8, 5.2, 5.5 | 3.7, 5.1, 5.5 | 153.0.8010.12 |
| 2026-10-04T13:34:33.685Z | timing | new | phone | 4 | 1 | complete | 4.4, 5.2, 5.5 | 2.7, 4.7, 5.3 | 153.0.8010.12 |
| 2026-10-04T13:43:07.503Z | timing | old | phone | 1 | 2 | failed | 3.3, 4.2, 5.1 | 3.7, 4.2, 5.1 | 153.0.8010.12 |
| 2026-10-04T13:43:29.007Z | timing | new | phone | 1 | 2 | complete | 4.2, 4.3, 5.1 | 3.8, 5.0, 5.3 | 153.0.8010.12 |
| 2026-10-04T13:48:05.984Z | timing | old | phone | 1 | 3 | failed | 4.4, 5.1, 5.3 | 4.4, 5.1, 5.3 | 153.0.8010.12 |
| 2026-10-04T13:48:25.801Z | timing | new | phone | 1 | 3 | complete | 4.3, 5.0, 5.3 | 3.2, 5.0, 5.3 | 153.0.8010.12 |
| 2026-10-04T13:54:19.021Z | timing | old | web | 1 | 0 | complete | 2.6, 4.2, 5.0 | 5.6, 5.2, 5.2 | 153.0.8010.12 |
| 2026-10-04T13:59:37.997Z | timing | new | web | 1 | 0 | complete | 5.5, 5.2, 5.2 | 5.9, 5.1, 5.1 | 153.0.8010.12 |
| 2026-10-04T14:04:45.956Z | timing | old | web | 1 | 1 | complete | 5.8, 5.1, 5.1 | 4.2, 4.4, 4.8 | 153.0.8010.12 |
| 2026-10-04T14:10:10.515Z | timing | new | web | 1 | 1 | complete | 4.9, 4.6, 4.8 | 5.9, 5.7, 5.3 | 153.0.8010.12 |
| 2026-10-04T14:15:26.009Z | timing | old | web | 4 | 0 | complete | 5.4, 5.6, 5.2 | 4.2, 4.4, 4.9 | 153.0.8010.12 |
| 2026-10-04T15:04:25.785Z | timing | old | web | 1 | 10 | complete | 7.8, 6.0, 5.6 | 4.8, 5.7, 5.7 | 153.0.8010.12 |
| 2026-10-04T15:14:05.664Z | timing | new | web | 1 | 10 | complete | 2.0, 4.2, 5.1 | 5.7, 4.5, 4.9 | 153.0.8010.12 |
| 2026-10-04T15:22:55.872Z | timing | old | web | 1 | 11 | complete | 3.4, 4.3, 4.8 | 3.7, 5.9, 5.7 | 153.0.8010.12 |
| 2026-10-04T15:30:33.368Z | timing | new | web | 1 | 11 | complete | 3.3, 5.7, 5.6 | 8.8, 6.5, 6.0 | 153.0.8010.12 |

Host CPU utilization below is the /proc/stat delta across capture, all logical cores; it includes other processes. It is separate from measured renderer CPU.

| Arm | Surface | Scale | Round | CPU model | Logical cores | Host CPU busy % | Harness digest |
|---|---|---:|---:|---|---:|---:|---|
| new | web | 1 | 10 | AMD EPYC Processor (with IBPB) | 8 | 40.0 | 4b4ad7b2ad639fd5 |
| new | web | 1 | 11 | AMD EPYC Processor (with IBPB) | 8 | 49.7 | 5a00f752eca2f258 |
| old | web | 1 | 10 | AMD EPYC Processor (with IBPB) | 8 | 49.9 | 4b4ad7b2ad639fd5 |
| old | web | 1 | 11 | AMD EPYC Processor (with IBPB) | 8 | 49.0 | 5a00f752eca2f258 |

## Evidence and reproduction

Run and per-sample timestamps, SHAs, semantic/product digests, exact bootstrap counts, captured process IDs, lease grant, load, CPU deltas and failures are in the [raw run files](POD-4286-old-vs-new/raw/) and [machine-readable comparisons](POD-4286-old-vs-new/results.json). Compressed Chromium traces and sampled profiles are attached as raw evidence.

Preparation uses each arm’s own .toolchain/bun and checkout-local dependencies: bun run setup:worktree, then bun scripts/browser-lane.ts --build-only. old-vs-new-corpus.mjs serializes the OLD seed once and adapts that same JSON to NEW’s schema; old-vs-new.mjs validates the augmented stream through the production decoder before capture. Run old-vs-new-remote.py from ludovico with --arm, --surface, --scale, --mode and --round; it runs one foreground SSH process, acquires bench:flatblock for timing or meter:flatblock for heap/diagnostic captures, delivers the lease grant to the arm, and releases at CAPTURE_FINISHED. Timing rounds alternate OLD/NEW. All browser contexts and the recorded server PID are torn down before the next arm. Four cold/warm pairs per round are unprofiled; one additional pair and the last two repetitions of each action are profiled separately. Cold means fresh browser storage/cache against an already-running isolated server; warm means reload of that profile. Neither measures desktop sidecar spawn, a physical phone, network conditions or real agent startup. No test suite or product-code edits are part of these captures.
