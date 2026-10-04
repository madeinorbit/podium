# OLD versus NEW whole-app measurements

Measurement runs are in progress. No final verdict yet.

## Compared applications


OLD corpus seed 4443: 4,867 issues and 4,304 sessions at 1x; 19,468 issues and 17,216 sessions at 4x. Two real isolated control issues and their live agents exercise mutations. OLD controls are matched to their contemporary NEW build using comparisonArm; later OLD controls are not pooled into the earlier NEW comparison. Both arms consume the same serialized semantic corpus; the per-run digest proves the match. OLD receives its legacy issue and issue-projection rows; NEW receives normalized issue/session personal state and git/machine facts. Optional null strings are omitted to satisfy the production wire schema.

Performance evidence: 0 completed measurement runs and 0 failed measurement runs. 36 calibration, superseded or diagnostic runs are retained separately and excluded from comparisons.

This is a comparison of shipped application revisions, including their other changes and different data representations. It does not isolate MobX as the sole cause. The operator requested NEW be repinned from 22b676a741 to 1aa0ec71f6 during collection. The earlier NEW captures are retained as superseded evidence and do not enter the verdict.

## Latency, milliseconds

Lower is better. Percent change is `(NEW / OLD − 1) × 100`. Percentiles use nearest rank; median averages the middle pair. Profiled samples are excluded. Cached phone Work can return using only composited pixels: its boundary is DrawFrame when no new raster Paint occurs, and its CPU boundary is the last completed main-thread trace event before that frame, a conservative lower bound if work overlaps the frame; wider CDP task CPU also remains raw. Differences within ±10% are labelled no clear improvement; this is a reporting band, not a statistical confidence interval. With 8 or 16 observations, nearest-rank p95 equals the maximum; it is a limited tail estimate, not an independent tail measurement.

| Surface | Scale | Action | NEW arm | OLD n | NEW n | OLD median | NEW median | OLD p95 | NEW p95 | Median change | p95 change | OLD max | NEW max | NEW boundary | Verdict |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|

## Main-thread work per action

Main-thread CPU uses Chromium trace thread timestamps (tts/tdur), from the trusted input handler to the qualifying Paint end. It excludes OS descheduling; click latency includes the event queue and waiting. Startup CPU starts at the initialization script, slightly after navigation begins. Layout CPU is the union of Layout and UpdateLayoutTree thread durations in that interval and overlaps total CPU. Task busy wall time and wider CDP polling-window deltas remain in raw data. Source-map profiles separately estimate store/derive and React work; never add overlapping categories. [Chromium performance-agent implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_performance_agent.cc).

| Surface | Scale | Action | NEW arm | OLD CPU median | NEW CPU median | Median change | OLD CPU p95 | NEW CPU p95 | OLD CPU max | NEW CPU max | OLD layout CPU | NEW layout CPU |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|

## Sampled store and React attribution

Requested V8 sampling interval: 100 microseconds. Values below estimate CPU as measured renderer thread CPU multiplied by each category’s share of non-idle sampled stack wall time, during separately profiled input-to-Paint windows. Sampling and OS descheduling can bias these allocations; they are not exclusive hardware counters. Profiled samples are excluded from latency statistics. Sampled wall durations also remain in raw attribution files. React render includes app derivations it calls; store/derive is an inclusive stack match and overlaps React. Commit includes layout effects and called native work; layout hardware CPU appears in the preceding table. Idle, unmapped and other samples are retained in cpu-attribution.json. No exact exclusive store or React hardware-CPU counters are claimed.

| Arm | Surface | Scale | Action | Profiles | Store/derive CPU estimate | React render CPU estimate | React commit CPU estimate | Unmapped wall ms |
|---|---|---:|---|---:|---:|---:|---:|---:|

## Incoming updates and connected idle

Update CPU is the CDP main-thread TaskDuration delta with Performance.enable(timeDomain=threadTicks), measured after one injected update through a 200 ms minimum window and two animation frames. Actual windows can be longer under load and are retained. Quiet windows measure the same instrumentation with no injection. These are observed total CPU costs in a window containing one update, not exclusive causal CPU per update; pending UI tasks, paints and real upstream traffic can overlap. The 60 s connected-idle replay delivers 30 heartbeat changes/minute, 10 issue changes/minute, and 120 terminal output frames/minute (two frames/second). The first two rates approximate the operator activity window; the output rate is a stated synthetic assumption. This is an idle UI with live data, not a silent disconnected app. Delivery to the visible terminal is verified before replay. Percent CPU means one renderer thread’s fraction of one core, not whole-machine or Mac desktop CPU.

| Arm | Surface | Scale | Update | n | Task CPU ms/window median | p95 |
|---|---|---:|---|---:|---:|---:|

| Arm | Surface | Scale | Seconds | Updates delivered | Main-thread task ms | One-core CPU % |
|---|---|---:|---:|---|---:|---:|

Median of the separate 60-second windows:

| Surface | Scale | NEW arm | OLD one-core CPU % | NEW one-core CPU % | Change |
|---|---:|---|---:|---:|---:|

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


Individual failed attempts, diagnostics, exclusions and exact errors remain in the run ledger and raw files. Long-press includes the product’s 500 ms gesture threshold. Rename starts at submit, after title entry; drag drop starts at pointer release, with drag initiation reported separately. Search starts with the input event that replaces the query and ends only after matching results replace the previous results. Sidebar selection includes issue switching; mission switching additionally waits for the target mission’s session deck.


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

Host CPU utilization below is the /proc/stat delta across capture, all logical cores; it includes other processes. It is separate from measured renderer CPU.

| Arm | Surface | Scale | Round | CPU model | Logical cores | Host CPU busy % | Harness digest |
|---|---|---:|---:|---|---:|---:|---|

## Evidence and reproduction

Run and per-sample timestamps, SHAs, semantic/product digests, exact bootstrap counts, captured process IDs, lease grant, load, CPU deltas and failures are in the [raw run files](POD-4286-old-vs-new/raw/) and [machine-readable comparisons](POD-4286-old-vs-new/results.json). Compressed Chromium traces and sampled profiles are attached as raw evidence.

Preparation uses each arm’s own .toolchain/bun and checkout-local dependencies: bun run setup:worktree, then bun scripts/browser-lane.ts --build-only. old-vs-new-corpus.mjs serializes the OLD seed once and adapts that same JSON to NEW’s schema; old-vs-new.mjs validates the augmented stream through the production decoder before capture. Run old-vs-new-remote.py from ludovico with --arm, --surface, --scale, --mode and --round; it runs one foreground SSH process, acquires bench:flatblock for timing or meter:flatblock for heap/diagnostic captures, delivers the lease grant to the arm, and releases at CAPTURE_FINISHED. Timing rounds alternate OLD/NEW. All browser contexts and the recorded server PID are torn down before the next arm. Four cold/warm pairs per round are unprofiled; one additional pair and the last two repetitions of each action are profiled separately. Cold means fresh browser storage/cache against an already-running isolated server; warm means reload of that profile. Neither measures desktop sidecar spawn, a physical phone, network conditions or real agent startup. No test suite or product-code edits are part of these captures.
