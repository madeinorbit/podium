# OLD versus NEW whole-app measurements

Measurement runs are in progress. No final verdict yet.

## Compared applications

- **NEW**: `22b676a741918c8c11a84aa485a37bb31595a7cc`
- **OLD**: `5e3ece5cd68c5fbd7dbd8b1dcfa6d92a35f42cbb`

OLD corpus seed 4443: 4,867 issues and 4,304 sessions at 1x; 19,468 issues and 17,216 sessions at 4x. Two real isolated control issues and their live agents exercise mutations. OLD controls are matched to their contemporary NEW build using comparisonArm; later OLD controls are not pooled into the earlier NEW comparison. Both arms consume the same serialized semantic corpus; the per-run digest proves the match. OLD receives its legacy issue and issue-projection rows; NEW receives normalized issue/session personal state and git/machine facts. Optional null strings are omitted to satisfy the production wire schema.

Performance evidence: 7 completed measurement runs and 6 failed measurement runs. 21 calibration or diagnostic runs are retained separately and excluded from comparisons.

## Latency, milliseconds

Lower is better. Percent change is `(NEW / OLD − 1) × 100`. Percentiles use nearest rank; median averages the middle pair. Profiled samples are excluded. Cached phone Work can return using only composited pixels: its boundary is DrawFrame when no new raster Paint occurs, and its CPU boundary is the last completed main-thread trace event before that frame, a conservative lower bound if work overlaps the frame; wider CDP task CPU also remains raw. Differences within ±10% are labelled no clear improvement; this is a reporting band, not a statistical confidence interval. p95 from small samples is a limited tail estimate.

| Surface | Scale | Action | NEW arm | OLD n | NEW n | OLD median | NEW median | OLD p95 | NEW p95 | Median change | p95 change | OLD max | NEW max | NEW boundary | Verdict |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| phone | 1 | app-cold-start | new | 0 | 8 | — | 3,769.4 | — | 4,603.3 | — | — | — | 4,603.3 | Paint | not comparable |
| phone | 1 | app-warm-start | new | 0 | 8 | — | 2,448.5 | — | 3,313.6 | — | — | — | 3,313.6 | Paint | not comparable |
| phone | 1 | phone-composer-typing | new | 0 | 16 | — | 13.5 | — | 15.9 | — | — | — | 15.9 | Paint | not comparable |
| phone | 1 | phone-issue-open | new | 0 | 16 | — | 71.9 | — | 104.0 | — | — | — | 104.0 | Paint | not comparable |
| phone | 1 | phone-issue-picker-search | new | 0 | 16 | — | 16.3 | — | 22.6 | — | — | — | 22.6 | Paint | not comparable |
| phone | 1 | phone-issue-rename | new | 0 | 16 | — | 36.7 | — | 48.1 | — | — | — | 48.1 | Paint | not comparable |
| phone | 1 | phone-issue-screen | new | 0 | 16 | — | 43.8 | — | 445.4 | — | — | — | 445.4 | Paint | not comparable |
| phone | 1 | phone-long-press | new | 0 | 16 | — | 554.9 | — | 629.7 | — | — | — | 629.7 | Paint | not comparable |
| phone | 1 | phone-mission-details | new | 0 | 16 | — | 99.5 | — | 178.4 | — | — | — | 178.4 | Paint | not comparable |
| phone | 1 | phone-mission-open | new | 0 | 16 | — | 97.8 | — | 163.8 | — | — | — | 163.8 | Paint | not comparable |
| phone | 1 | phone-work-screen | new | 0 | 16 | — | 62.0 | — | 150.6 | — | — | — | 150.6 | DrawFrame (compositor, no new raster Paint) | not comparable |
| phone | 1 | phone-work-search | new | 0 | 16 | — | 10.6 | — | 16.9 | — | — | — | 16.9 | Paint | not comparable |
| phone | 4 | app-cold-start | new | 0 | 8 | — | 10,166.2 | — | 10,444.1 | — | — | — | 10,444.1 | Paint | not comparable |
| phone | 4 | app-warm-start | new | 0 | 8 | — | 7,647.7 | — | 8,237.0 | — | — | — | 8,237.0 | Paint | not comparable |
| phone | 4 | phone-composer-typing | new | 0 | 16 | — | 13.2 | — | 16.3 | — | — | — | 16.3 | Paint | not comparable |
| phone | 4 | phone-issue-open | new | 0 | 16 | — | 78.3 | — | 114.4 | — | — | — | 114.4 | Paint | not comparable |
| phone | 4 | phone-issue-picker-search | new | 0 | 16 | — | 21.4 | — | 27.2 | — | — | — | 27.2 | Paint | not comparable |
| phone | 4 | phone-issue-rename | new | 0 | 16 | — | 98.1 | — | 123.5 | — | — | — | 123.5 | Paint | not comparable |
| phone | 4 | phone-issue-screen | new | 0 | 16 | — | 47.1 | — | 1,529.6 | — | — | — | 1,529.6 | Paint | not comparable |
| phone | 4 | phone-long-press | new | 0 | 16 | — | 570.4 | — | 635.0 | — | — | — | 635.0 | Paint | not comparable |
| phone | 4 | phone-mission-details | new | 0 | 16 | — | 124.8 | — | 357.9 | — | — | — | 357.9 | Paint | not comparable |
| phone | 4 | phone-mission-open | new | 0 | 16 | — | 100.5 | — | 168.4 | — | — | — | 168.4 | Paint | not comparable |
| phone | 4 | phone-work-screen | new | 0 | 16 | — | 63.5 | — | 235.3 | — | — | — | 235.3 | DrawFrame (compositor, no new raster Paint) | not comparable |
| phone | 4 | phone-work-search | new | 0 | 16 | — | 18.6 | — | 28.3 | — | — | — | 28.3 | Paint | not comparable |
| web | 1 | app-cold-start | new | 8 | 4 | 2,013.6 | 3,282.4 | 2,110.8 | 3,776.0 | 63.0% | 78.9% | 2,110.8 | 3,776.0 | Paint | slower |
| web | 1 | app-warm-start | new | 8 | 4 | 988.8 | 2,355.4 | 1,222.2 | 4,057.7 | 138.2% | 232.0% | 1,222.2 | 4,057.7 | Paint | slower |
| web | 1 | board-open | new | 16 | 8 | 208.4 | 227.2 | 245.1 | 234.9 | 9.0% | -4.2% | 245.1 | 234.9 | Paint | no clear improvement |
| web | 1 | board-search | new | 16 | 8 | 52.2 | 67.2 | 81.0 | 103.3 | 28.7% | 27.6% | 81.0 | 103.3 | Paint | slower |
| web | 1 | command-palette | new | 16 | 8 | 93.0 | 110.2 | 474.7 | 459.1 | 18.6% | -3.3% | 474.7 | 459.1 | Paint | slower |
| web | 1 | dock-close | new | 16 | 8 | 64.8 | 60.1 | 87.1 | 68.9 | -7.3% | -20.8% | 87.1 | 68.9 | Paint | no clear improvement |
| web | 1 | dock-open | new | 16 | 8 | 78.9 | 64.3 | 97.5 | 86.8 | -18.5% | -10.9% | 97.5 | 86.8 | Paint | faster |
| web | 1 | flight-deck-collapse | new | 16 | 8 | 39.3 | 40.5 | 45.7 | 51.2 | 3.0% | 12.0% | 45.7 | 51.2 | Paint | similar median, worse tail |
| web | 1 | flight-deck-expand | new | 16 | 8 | 52.3 | 32.3 | 73.7 | 46.8 | -38.3% | -36.5% | 73.7 | 46.8 | Paint | faster |
| web | 1 | header-menu | new | 16 | 8 | 27.9 | 26.7 | 50.8 | 69.4 | -4.4% | 36.6% | 50.8 | 69.4 | Paint | similar median, worse tail |
| web | 1 | issue-page-open | new | 16 | 8 | 90.4 | 156.1 | 203.9 | 222.1 | 72.6% | 8.9% | 203.9 | 222.1 | Paint | slower |
| web | 1 | issue-picker-search | new | 16 | 8 | 17.2 | 25.4 | 38.5 | 49.6 | 47.3% | 28.8% | 38.5 | 49.6 | Paint | slower |
| web | 1 | issue-rename | new | 16 | 8 | 210.7 | 46.3 | 394.0 | 63.4 | -78.0% | -83.9% | 394.0 | 63.4 | Paint | faster |
| web | 1 | mark-read | new | 16 | 8 | 837.1 | 127.6 | 982.0 | 191.8 | -84.8% | -80.5% | 982.0 | 191.8 | Paint | faster |
| web | 1 | mission-switch | new | 16 | 8 | 350.3 | 199.4 | 431.3 | 218.2 | -43.1% | -49.4% | 431.3 | 218.2 | Paint | faster |
| web | 1 | session-switch | new | 16 | 8 | 754.5 | 396.9 | 946.4 | 494.3 | -47.4% | -47.8% | 946.4 | 494.3 | Paint | faster |
| web | 1 | sidebar-collapse | new | 16 | 8 | 76.0 | 94.6 | 100.7 | 122.3 | 24.4% | 21.5% | 100.7 | 122.3 | Paint | slower |
| web | 1 | sidebar-drag-drop | new | 16 | 8 | 216.7 | 94.3 | 276.8 | 95.7 | -56.5% | -65.4% | 276.8 | 95.7 | Paint | faster |
| web | 1 | sidebar-drag-start | new | 16 | 8 | 22.8 | 24.6 | 29.5 | 31.4 | 7.9% | 6.4% | 29.5 | 31.4 | Paint | no clear improvement |
| web | 1 | sidebar-expand | new | 16 | 8 | 152.6 | 194.8 | 200.5 | 245.4 | 27.7% | 22.4% | 200.5 | 245.4 | Paint | slower |
| web | 1 | sidebar-group-collapse | new | 16 | 8 | 31.8 | 40.7 | 45.2 | 48.3 | 27.8% | 6.8% | 45.2 | 48.3 | Paint | slower |
| web | 1 | sidebar-group-expand | new | 16 | 8 | 32.7 | 35.1 | 43.7 | 41.2 | 7.5% | -5.8% | 43.7 | 41.2 | Paint | no clear improvement |
| web | 1 | sidebar-select | new | 16 | 8 | 271.6 | 123.5 | 380.3 | 199.8 | -54.5% | -47.5% | 380.3 | 199.8 | Paint | faster |
| web | 1 | superagent-composer-typing | new | 16 | 8 | 11.1 | 14.1 | 12.6 | 16.1 | 27.2% | 27.5% | 12.6 | 16.1 | Paint | slower |

## Main-thread work per action

Main-thread CPU uses Chromium trace thread timestamps (tts/tdur), from the trusted input handler to the qualifying Paint end. It excludes OS descheduling; click latency includes the event queue and waiting. Startup CPU starts at the initialization script, slightly after navigation begins. Layout CPU is the union of Layout and UpdateLayoutTree thread durations in that interval and overlaps total CPU. Task busy wall time and wider CDP polling-window deltas remain in raw data. Source-map profiles separately estimate store/derive and React work; never add overlapping categories. [Chromium performance-agent implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_performance_agent.cc).

| Surface | Scale | Action | NEW arm | OLD CPU median | NEW CPU median | OLD CPU p95 | NEW CPU p95 | OLD CPU max | NEW CPU max | OLD layout CPU | NEW layout CPU |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| phone | 1 | app-cold-start | new | — | 2,960.3 | — | 3,231.3 | — | 3,231.3 | — | 39.2 |
| phone | 1 | app-warm-start | new | — | 1,880.9 | — | 2,109.3 | — | 2,109.3 | — | 54.5 |
| phone | 1 | phone-composer-typing | new | — | 13.1 | — | 15.7 | — | 15.7 | — | 1.4 |
| phone | 1 | phone-issue-open | new | — | 47.3 | — | 75.6 | — | 75.6 | — | 10.7 |
| phone | 1 | phone-issue-picker-search | new | — | 15.5 | — | 22.0 | — | 22.0 | — | 1.1 |
| phone | 1 | phone-issue-rename | new | — | 34.4 | — | 40.3 | — | 40.3 | — | 1.3 |
| phone | 1 | phone-issue-screen | new | — | 20.4 | — | 356.4 | — | 356.4 | — | 4.4 |
| phone | 1 | phone-long-press | new | — | 485.0 | — | 530.3 | — | 530.3 | — | 86.1 |
| phone | 1 | phone-mission-details | new | — | 95.5 | — | 153.6 | — | 153.6 | — | 47.9 |
| phone | 1 | phone-mission-open | new | — | 69.5 | — | 129.5 | — | 129.5 | — | 14.5 |
| phone | 1 | phone-work-screen | new | — | — | — | — | — | — | — | — |
| phone | 1 | phone-work-search | new | — | 10.3 | — | 13.2 | — | 13.2 | — | 1.4 |
| phone | 4 | app-cold-start | new | — | 9,010.6 | — | 9,228.4 | — | 9,228.4 | — | 51.2 |
| phone | 4 | app-warm-start | new | — | 6,542.0 | — | 7,055.2 | — | 7,055.2 | — | 62.2 |
| phone | 4 | phone-composer-typing | new | — | 12.8 | — | 16.0 | — | 16.0 | — | 1.2 |
| phone | 4 | phone-issue-open | new | — | 51.6 | — | 83.6 | — | 83.6 | — | 13.4 |
| phone | 4 | phone-issue-picker-search | new | — | 21.2 | — | 27.0 | — | 27.0 | — | 1.1 |
| phone | 4 | phone-issue-rename | new | — | 95.7 | — | 119.6 | — | 119.6 | — | 1.4 |
| phone | 4 | phone-issue-screen | new | — | 25.9 | — | 1,383.5 | — | 1,383.5 | — | 6.3 |
| phone | 4 | phone-long-press | new | — | 495.2 | — | 560.4 | — | 560.4 | — | 119.2 |
| phone | 4 | phone-mission-details | new | — | 120.8 | — | 267.8 | — | 267.8 | — | 61.4 |
| phone | 4 | phone-mission-open | new | — | 73.1 | — | 146.1 | — | 146.1 | — | 15.4 |
| phone | 4 | phone-work-screen | new | — | — | — | — | — | — | — | — |
| phone | 4 | phone-work-search | new | — | 18.0 | — | 27.7 | — | 27.7 | — | 1.6 |
| web | 1 | app-cold-start | new | 1,663.6 | 2,851.9 | 1,751.7 | 3,248.3 | 1,751.7 | 3,248.3 | 85.3 | 88.3 |
| web | 1 | app-warm-start | new | 736.1 | 1,921.0 | 934.1 | 2,978.4 | 934.1 | 2,978.4 | 66.6 | 57.1 |
| web | 1 | board-open | new | 185.3 | 205.6 | 227.5 | 213.7 | 227.5 | 213.7 | 62.4 | 58.0 |
| web | 1 | board-search | new | 51.7 | 66.6 | 80.7 | 102.5 | 80.7 | 102.5 | 8.2 | 7.5 |
| web | 1 | command-palette | new | 90.5 | 105.6 | 262.4 | 284.0 | 262.4 | 284.0 | 40.8 | 44.3 |
| web | 1 | dock-close | new | 55.8 | 49.5 | 72.0 | 57.3 | 72.0 | 57.3 | 3.3 | 3.4 |
| web | 1 | dock-open | new | 69.2 | 54.5 | 84.3 | 66.1 | 84.3 | 66.1 | 3.6 | 3.5 |
| web | 1 | flight-deck-collapse | new | 32.9 | 34.4 | 40.1 | 43.9 | 40.1 | 43.9 | 1.8 | 2.9 |
| web | 1 | flight-deck-expand | new | 42.6 | 25.0 | 59.6 | 34.3 | 59.6 | 34.3 | 4.6 | 3.4 |
| web | 1 | header-menu | new | 19.0 | 19.6 | 39.0 | 51.0 | 39.0 | 51.0 | 3.9 | 4.1 |
| web | 1 | issue-page-open | new | 81.3 | 143.8 | 138.0 | 206.8 | 138.0 | 206.8 | 28.4 | 27.3 |
| web | 1 | issue-picker-search | new | 16.5 | 25.1 | 22.0 | 35.9 | 22.0 | 35.9 | 2.7 | 2.7 |
| web | 1 | issue-rename | new | 204.9 | 41.1 | 269.7 | 51.4 | 269.7 | 51.4 | 2.4 | 2.0 |
| web | 1 | mark-read | new | 811.0 | 95.8 | 939.5 | 141.3 | 939.5 | 141.3 | 5.9 | 4.0 |
| web | 1 | mission-switch | new | 326.5 | 175.8 | 407.6 | 190.4 | 407.6 | 190.4 | 53.4 | 49.7 |
| web | 1 | session-switch | new | 716.8 | 165.6 | 903.4 | 342.6 | 903.4 | 342.6 | 31.2 | 28.0 |
| web | 1 | sidebar-collapse | new | 71.0 | 88.0 | 92.3 | 107.6 | 92.3 | 107.6 | 17.0 | 16.7 |
| web | 1 | sidebar-drag-drop | new | 30.2 | 20.3 | 44.1 | 32.8 | 44.1 | 32.8 | 4.3 | 3.1 |
| web | 1 | sidebar-drag-start | new | 19.9 | 21.7 | 24.4 | 25.7 | 24.4 | 25.7 | 1.4 | 1.4 |
| web | 1 | sidebar-expand | new | 149.0 | 190.0 | 195.9 | 235.8 | 195.9 | 235.8 | 40.9 | 43.0 |
| web | 1 | sidebar-group-collapse | new | 25.2 | 31.8 | 37.3 | 38.4 | 37.3 | 38.4 | 0.8 | 0.9 |
| web | 1 | sidebar-group-expand | new | 25.8 | 28.7 | 33.8 | 32.9 | 33.8 | 32.9 | 1.6 | 1.7 |
| web | 1 | sidebar-select | new | 258.1 | 114.1 | 355.2 | 177.9 | 355.2 | 177.9 | 37.7 | 34.3 |
| web | 1 | superagent-composer-typing | new | 10.7 | 13.2 | 12.3 | 15.6 | 12.3 | 15.6 | 2.0 | 3.5 |

## Sampled store and React attribution

Requested V8 sampling interval: 100 microseconds. Values below estimate CPU as measured renderer thread CPU multiplied by each category’s share of non-idle sampled stack wall time, during separately profiled input-to-Paint windows. Sampling and OS descheduling can bias these allocations; they are not exclusive hardware counters. Profiled samples are excluded from latency statistics. Sampled wall durations also remain in raw attribution files. React render includes app derivations it calls; store/derive is an inclusive stack match and overlaps React. Commit includes layout effects and called native work; layout hardware CPU appears in the preceding table. Idle, unmapped and other samples are retained in cpu-attribution.json. No exact exclusive store or React hardware-CPU counters are claimed.

| Arm | Surface | Scale | Action | Profiles | Store/derive CPU estimate | React render CPU estimate | React commit CPU estimate | Unmapped wall ms |
|---|---|---:|---|---:|---:|---:|---:|---:|

## Incoming updates and connected idle

Update CPU is the CDP main-thread TaskDuration delta with Performance.enable(timeDomain=threadTicks), measured after one injected update through a 200 ms minimum window and two animation frames. Actual windows can be longer under load and are retained. Quiet windows measure the same instrumentation with no injection. These are observed total CPU costs in a window containing one update, not exclusive causal CPU per update; pending UI tasks, paints and real upstream traffic can overlap. The 60 s connected-idle replay delivers 30 heartbeat changes/minute, 10 issue changes/minute, and 120 terminal output frames/minute (two frames/second). The first two rates approximate the operator activity window; the output rate is a stated synthetic assumption. This is an idle UI with live data, not a silent disconnected app. Delivery to the visible terminal is verified before replay. Percent CPU means one renderer thread’s fraction of one core, not whole-machine or Mac desktop CPU.

| Arm | Surface | Scale | Update | n | Task CPU ms/window median | p95 |
|---|---|---:|---|---:|---:|---:|
| new | phone | 1 | heartbeat | 20 | 52.8 | 61.5 |
| new | phone | 1 | issue-change | 20 | 45.5 | 55.2 |
| new | phone | 1 | quiet | 16 | 2.7 | 6.4 |
| new | phone | 1 | session-output | 20 | 12.1 | 16.0 |
| new | phone | 4 | heartbeat | 20 | 162.2 | 177.4 |
| new | phone | 4 | issue-change | 20 | 182.4 | 232.3 |
| new | phone | 4 | quiet | 16 | 2.6 | 6.0 |
| new | phone | 4 | session-output | 20 | 11.9 | 15.4 |
| new | web | 1 | heartbeat | 10 | 112.1 | 139.9 |
| new | web | 1 | issue-change | 10 | 60.2 | 83.9 |
| new | web | 1 | quiet | 8 | 12.8 | 24.7 |
| new | web | 1 | session-output | 10 | 17.7 | 42.7 |
| old → new | web | 1 | heartbeat | 20 | 206.8 | 249.8 |
| old → new | web | 1 | issue-change | 20 | 211.0 | 231.9 |
| old → new | web | 1 | quiet | 16 | 11.3 | 365.5 |
| old → new | web | 1 | session-output | 20 | 16.3 | 30.4 |

| Arm | Surface | Scale | Seconds | Updates delivered | Main-thread task ms | One-core CPU % |
|---|---|---:|---:|---|---:|---:|
| new | phone | 1 | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 3,984.4 | 6.6 |
| new | phone | 1 | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 3,860.0 | 6.4 |
| new | phone | 4 | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 8,214.6 | 13.7 |
| new | phone | 4 | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 7,877.6 | 13.1 |
| new | web | 1 | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 7,228.1 | 12.0 |
| old | web | 1 | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 11,578.0 | 19.3 |
| old | web | 1 | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 11,582.9 | 19.3 |

## Retained JavaScript heap

Post-GC Runtime.getHeapUsage usedSize. One startup/5-minute pair per arm/surface/scale is an observation, not leak evidence. Memory runs use meter:flatblock and do not contribute timings.

| Arm | Surface | Scale | Startup MiB | Five minutes MiB | Duration s | Action groups |
|---|---|---:|---:|---:|---:|---:|

## Action gaps and defects

- NEW phone 1x: **phone-inbox** — Error: No Inbox tab or production route in this revision; detached Inbox component is not a whole-app measurement
- NEW phone 1x: **phone-inbox** — Error: No Inbox tab or production route in this revision; detached Inbox component is not a whole-app measurement
- NEW phone 4x: **phone-inbox** — Error: No Inbox tab or production route in this revision; detached Inbox component is not a whole-app measurement
- NEW phone 4x: **phone-inbox** — Error: No Inbox tab or production route in this revision; detached Inbox component is not a whole-app measurement
- NEW web 1x: **session-composer-typing** — TimeoutError: click: Timeout 10000ms exceeded.
- Failed capture timing/old/phone/1x/r0: Error: Phone startup refused: CANNOT START
- Failed capture timing/old/phone/1x/r1: Error: Phone startup refused: CANNOT START
- Failed capture timing/old/phone/1x/r2: Error: Phone startup refused: CANNOT START
- Failed capture timing/old/phone/1x/r3: Error: Phone startup refused: CANNOT START
- Failed capture timing/old/phone/4x/r0: Error: Phone startup refused: CANNOT START
- Failed capture timing/old/phone/4x/r1: Error: Phone startup refused: CANNOT START
- OLD web 1x: **session-composer-typing** — TimeoutError: click: Timeout 10000ms exceeded.
- OLD web 1x: **session-composer-typing** — TimeoutError: click: Timeout 10000ms exceeded.

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

Host CPU utilization below is the /proc/stat delta across capture, all logical cores; it includes other processes. It is separate from measured renderer CPU.

| Arm | Surface | Scale | Round | CPU model | Logical cores | Host CPU busy % | Harness digest |
|---|---|---:|---:|---|---:|---:|---|
| new | phone | 1 | 2 | AMD EPYC Processor (with IBPB) | 8 | 43.6 | 3f120b2c54966325 |
| new | phone | 1 | 3 | AMD EPYC Processor (with IBPB) | 8 | 42.6 | 3f120b2c54966325 |
| new | phone | 4 | 0 | AMD EPYC Processor (with IBPB) | 8 | 48.7 | 38f348590b57cc86 |
| new | phone | 4 | 1 | AMD EPYC Processor (with IBPB) | 8 | 40.4 | 38f348590b57cc86 |
| new | web | 1 | 0 | AMD EPYC Processor (with IBPB) | 8 | 34.6 | b0d56193073cdb2b |
| old | phone | 1 | 0 | AMD EPYC Processor (with IBPB) | 8 | 45.0 | 46848bdd96057d86 |
| old | phone | 1 | 1 | AMD EPYC Processor (with IBPB) | 8 | 55.8 | 46848bdd96057d86 |
| old | phone | 1 | 2 | AMD EPYC Processor (with IBPB) | 8 | 71.8 | 3f120b2c54966325 |
| old | phone | 1 | 3 | AMD EPYC Processor (with IBPB) | 8 | 48.5 | 3f120b2c54966325 |
| old | phone | 4 | 0 | AMD EPYC Processor (with IBPB) | 8 | 40.7 | 96f6fdf4b8dc06b6 |
| old | phone | 4 | 1 | AMD EPYC Processor (with IBPB) | 8 | 38.4 | 38f348590b57cc86 |
| old | web | 1 | 0 | AMD EPYC Processor (with IBPB) | 8 | 35.7 | b0d56193073cdb2b |
| old | web | 1 | 1 | AMD EPYC Processor (with IBPB) | 8 | 37.1 | b0d56193073cdb2b |

## Evidence and reproduction

Run and per-sample timestamps, SHAs, semantic/product digests, exact bootstrap counts, captured process IDs, lease grant, load, CPU deltas and failures are in the [raw run files](POD-4286-old-vs-new/raw/) and [machine-readable comparisons](POD-4286-old-vs-new/results.json). Compressed Chromium traces and sampled profiles are attached as raw evidence.

Preparation uses each arm’s own .toolchain/bun and checkout-local dependencies: bun run setup:worktree, then bun scripts/browser-lane.ts --build-only. old-vs-new-corpus.mjs serializes the OLD seed once and adapts that same JSON to NEW’s schema; old-vs-new.mjs validates the augmented stream through the production decoder before capture. Run old-vs-new-remote.py from ludovico with --arm, --surface, --scale, --mode and --round; it runs one foreground SSH process, acquires bench:flatblock for timing or meter:flatblock for heap/diagnostic captures, delivers the lease grant to the arm, and releases at CAPTURE_FINISHED. Timing rounds alternate OLD/NEW. All browser contexts and the recorded server PID are torn down before the next arm. Four cold/warm pairs per round are unprofiled; one additional pair and the last two repetitions of each action are profiled separately. Cold means fresh browser storage/cache against an already-running isolated server; warm means reload of that profile. Neither measures desktop sidecar spawn, a physical phone, network conditions or real agent startup. No test suite or product-code edits are part of these captures.
