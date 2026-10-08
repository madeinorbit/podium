# Live idle CPU attribution

Measured on **ludovico, 2026-10-08**, against the operator’s existing live backend. NEW is `44809b1850` (dev.244); PREVIOUS is `1082520` (dev.243). No product fixes, server restarts, daemon restarts or operator-install changes are included.

Captures use the actual production web app in isolated headless Chromium contexts at **1600 × 1000**, with preview servers proxying the live backend. They use the application’s measurement hooks, rather than fixture data. Hardware CPU figures come from Linux process/thread CPU ticks; **GPU CPU** means CPU time in Chromium’s GPU process, not GPU utilization or power.

Whole-collection derivations and continuous CSS work consume CPU with no gestures. Five recurring cost families have disable/restore evidence. The dominant warmed path is repository activity: **54,000–64,000 queries/minute scan 83–98 million resident-session entries**, and freezing it lowers main busy from **70.45%/75.03% to 45.90%**. An intermittent search-index hotspot was the largest JavaScript path in an earlier window, but its later freeze did not establish the large independent saving. These Linux measurements do not establish that NEW is slower than PREVIOUS or explain the operator’s macOS `kernel_task` reading.

## Five leading recurring cost families

Shares below have explicit denominators. Sampled JavaScript stacks, browser task durations and hardware CPU counters measure different things; these columns are **not an additive partition of app CPU**. Live message counts alone do not establish equal row contents or equal work.

| Source | Measured cost/share | Disable/restore proof | Compared with PREVIOUS | Follow-up |
|---|---|---|---|---|
| `ReaderQueries.activity()` repository-by-session usage scans | Warmed profile: **11298.26 ms self / 32.70% of sampled busy**, **13679.82 ms inclusive / 39.59%**. Body timers find **17.34–20.05 s/minute**. | Unprofiled main busy **70.45% → 45.90% → 75.03%**, renderer **73.68% → 50.03% → 84.12%**. Body runs **53938 → 0 → 63500**; visits **83365958 → 0 → 98171000**. Deliveries **107/113/113**: freeze/restored equal, with more React commits when frozen. Restored/frozen main difference is **29.13 points / 38.8% of restored busy**. | `ReaderQueries` is new; PREVIOUS has legacy `repoUsageAt()` with the same broad scan pattern. Matching warmed comparison below distinguishes execution from source existence. | POD-5849 |
| `shell.issues()` whole-issue materialization and structural comparison | Heavier stock NEW idle: 3328.57 ms inclusive stack union, **10.98% of sampled busy time**; 1565.80 ms self. Equality cost overlaps this path. | Body runs **57 → 0 → 43**. Main busy **29.37% → 20.97% → 22.02%**; messages 202/188/188, deliveries 59/45/48. `eq` self **1417.1 → 370.9 → 943.1 ms**. The 8.40-point first difference is load-confounded; the restored/frozen difference is 1.05 points with equal message count, but differing deliveries. | NEW default pool path; source existed as an optional pool path before. PREVIOUS’s measured default runs legacy worklist derivations. | POD-5825 |
| `chatReferenceSessions()` repeated whole-session reference lists | Same stock NEW idle: **2786.47 ms / 9.19% of sampled busy time**, stack union. Verified body timers independently find 2.4–2.5 s per minute, about two builds per session delivery. | Unprofiled main busy **27.66% → 21.24% → 25.90%**, total CPU **43.59% → 38.23% → 40.36%**; deliveries 69/67/67. Body runs **130 → 0 → 130**, wall time **2461.5 → 0 → 2534.5 ms**. Frozen/restored have equal deliveries; message counts and contents differ. | Newly executed through NEW’s default pool; equivalent broad session derivation existed in legacy code. | POD-5843 |
| `shell.sessions()`, `settings.sessions()`, `settings.setup()` global session summaries | Same stock NEW idle: shell sessions **1423.19 ms / 4.69%**, settings stack union **928.41 ms / 3.06%** of sampled busy time. Combined bodies in the quieter verified control take **1321.2 ms**. | Unprofiled baseline/freeze: main busy **19.92% → 17.11%**, total CPU **36.52% → 33.30%**, renderer **29.02% → 26.10%**. **42 deliveries in both**; freeze has more messages (175 vs 173), more issue bodies (40 vs 38) and more chat-reference time. The three bodies’ **748.3/383.8/189.1 ms** go to zero. Restoration returns the bodies under higher live load. | NEW default pool path; these optional pool functions existed in PREVIOUS. | POD-5842 |
| Continuous CSS animation style/compositing: `podium-run-sweep`, `podium-mark-frames` | Two sweeps remove **1.70 core points / 26.3% of preceding GPU CPU**; four marks remove **382–384 ms/min / 63.0% of preceding style work**. All-animation control removes 4.65 GPU and 3.87 compositor core points before restoration; these effects overlap. | Sweep GPU **6.47% → 4.77% → 6.38%** with **185/192/182 messages**. Mark style **606.9 → 224.8 → 609.3 ms** with **213/203/185 messages**. Both components return on restoration; full app totals remain input-confounded. Details below. | Same animation names execute in PREVIOUS. | POD-5838, POD-5844 |

The projection freezes return the last settled answer and detach the selected reactive inputs. They intentionally permit stale UI for attribution. They are **not product fixes**. Suggested fixes are stable keyed/scalar projections, material-field invalidation, shared observed reference results and incremental session summaries. Animation fixes should reduce unnecessary/offscreen perpetual work and measure actual style/compositing rather than assume a transform is free.

The later issue-only control is also retained: its body time goes **1640.6 → 0 → 2053.4 ms**, while main busy goes **21.25% → 28.55% → 22.86%** and deliveries **44 → 128 → 59**. Thus deleting this body does not guarantee a lower aggregate reading under different live input; the specific body/equality reduction and earlier reversal are the evidence, not a universal 8.40-point app saving.

## Dominant warmed repository activity scan

After ordinary switches, the repository usage/navigation reader is mounted. Before switches the activity counter is **zero**; in the first post-activity idle minute it runs **53938 times**, visiting **83365958 resident-session entries**, taking **17339.6 ms** in its body. The restored idle minute runs **63500 times / 98171000 visits / 20052.6 ms**. These counters measure executed bodies, excluding frozen-answer cache hits. This is continuous data-derivation work with no gestures, not evidence of a timer per session.

| Same warm context, no profiler/tracer | Main busy | Renderer CPU | Total Chromium CPU | Pool deliveries | Messages | Activity body |
|---|---:|---:|---:|---:|---:|---:|
| Enabled post-activity idle | 70.45% | 73.68% | 78.53% | 107 | 311 | 17339.6 ms |
| Keyed activity frozen | 45.90% | 50.03% | 55.38% | 113 | 302 | 0 ms |
| Restored | 75.03% | 84.12% | 89.15% | 113 | 285 | 20052.6 ms |

Frozen/restored have **exactly 113 deliveries**. Frozen also commits React **5.933/s versus 5.067/s**. It receives more messages and retains the same eight active animations, so the drop is not a reduction in commit or animation count. Live row contents remain uncontrolled; the experiment is not a universal exact CPU allocation. The named work disappears and returns with a large hardware-renderer CPU difference.

`command-launch` repository usage and navigation call `activity()` once per repository. Each question scans every resident session. The per-session activity computed reads `collapsed()`, which depends on the broad `sessionsChanged` atom. This makes broad session invalidation and repository-times-session enumeration a real ongoing cost. The suggested fix uses effective-source activity results and bounded pending overlays, with invalidation on material activity fields; it avoids another full history mirror. The diagnostic freezes answers rather than implement that fix.

A separate tracing-disabled warmed profile independently finds **11.30 s self / 13.68 s inclusive** at the original activity function. Those are sampled active stack times, not the body timer or hardware CPU total. Initial pre-switch captures miss this mounted path. The five-family attribution therefore depends on panel state as well as live input. POD-5849 contains the proof and suggested fix.

A PREVIOUS counter-only production build underwent the same two issue switches and one session switch, then a 60.003-second idle profile with timeline tracing disabled. Its three intended selections changed. NEW and PREVIOUS post-switch windows receive **222/224 messages**, but message contents and the panel implementations differ.

| Profiled post-switch idle | Main busy | Renderer CPU | Leading mapped self function | Inclusive time | React commits/s | Long tasks |
|---|---:|---:|---|---:|---:|---:|
| NEW | 55.12% | 72.69% | `ReaderQueries.activity`: 11298.26 ms / 32.70% sampled busy | 13679.82 ms | 3.866 | 76 |
| PREVIOUS | 45.63% | 67.06% | `computeMissionIssueIds`: 5352.18 ms / 19.14% sampled busy | 5377.44 ms | 3.916 | 55 |

No `repoUsageAt` frame is found across the mapped PREVIOUS post-switch sample stacks; this is sampling evidence, not a proof of zero calls or of absent legacy source. PREVIOUS still spends 2.40 s inclusive in `modelsFor` and 1.41 s in `buildUnifiedRows`. Its MobX hooks record **2.55 reaction tracks/s**, with no measured reaction-run/computed callbacks in that window. The new activity reader is a distinct executed hotspot in this captured state, while the broad repository/session scan pattern and other expensive derivations predate it. This separate profiled comparison does not turn the changing live workload into a controlled build-to-build regression measurement.

## The larger intermittent index hotspot

In the heavier stock NEW idle window, `indexKeys()` has **3424.03 ms self** and `indexedGrams()` **3167.49 ms self**: **6591.52 ms / 21.74% of sampled busy time**. Their inclusive stack union is **6958.19 ms / 22.95%**. This is the largest identified JavaScript path in that window and must not be omitted from the attribution.

`indexKeys()` rebuilds text grams while also reading status/actionability/session inputs. A later index freeze gives body time **46.5 → 0 → 19.3 ms**, main busy **25.90% → 22.56% → 21.25%**, and deliveries **67 → 60 → 44**. That control removes the named work but does **not** prove that a 6.6-second index saving persists under the later workload. The first verified low-index window has only **0.17%** of sampled busy time on that stack. The hotspot evidence was mailed to POD-5826. A text/material-field guard is a candidate fix, not a claimed measured saving here.

## Production comparison

Fresh production contexts were captured interleaved: NEW, PREVIOUS, NEW, PREVIOUS. Each hydrates, settles ten seconds, then records connected idle with no gestures followed by ordinary activity. The first pair’s activity driver selected a session wrapper; those activity gestures are a pilot, not verified session switches. Their idle/profile measurements remain useful. The final unprofiled sequence verifies two issue-selection changes and one session-selection change and reads finalized switch traces after the CPU window.

| Initial stock window | CPU sampling busy | Long tasks | React commits/s | Incoming messages |
|---|---:|---:|---:|---:|
| NEW idle A | 27.75% | 49 | 5.016 | 195 |
| PREVIOUS idle A | 28.06% | 35 | 4.333 | 185 |
| NEW idle B | 49.91% | 107 | 5.183 | 300 |
| PREVIOUS idle B | 58.76% | 83 | 5.698 | 312 |

NEW does not show a consistent regression in these observations. PREVIOUS’s largest sampled self function is `computeMissionIssueIds()` (**2897.87/8169.70 ms**, **17.12%/22.68%** of sampled busy time), with `buildUnifiedRows()` **4672.25/12197.36 ms** inclusive. Broad derivation cost predates NEW. Fresh-context PREVIOUS uses the legacy sidebar; NEW uses the pool. This does not establish the operator’s previous desktop feature preferences or persistent panel state.

| Final unprofiled window | Seconds | Main busy | Renderer CPU | Long tasks | React commits/s | Messages |
|---|---:|---:|---:|---:|---:|---:|---:|
| NEW idle A | 60.003 | 18.71% | 31.75% | 34 | 3.400 | 167 |
| NEW activity A | 60.004 | 67.75% | 86.58% | 88 | 4.133 | 225 |
| PREVIOUS idle A | 60.004 | 45.37% | 52.30% | 61 | 3.933 | 205 |
| PREVIOUS activity A | 60.021 | 91.29% | 93.18% | 79 | 4.782 | 190 |
| NEW idle B | 60.007 | 28.94% | 33.68% | 72 | 4.116 | 224 |
| NEW activity B | 60.003 | 95.48% | 108.28% | 142 | 4.950 | 294 |
| PREVIOUS idle B | 60.003 | 30.53% | 43.45% | 39 | 3.067 | 166 |
| PREVIOUS activity B | 60.006 | 67.91% | 90.24% | 64 | 4.766 | 184 |

All **12/12** final activity gestures changed the intended selection. Each window has three finalized cold traces and one timeout; these are ordinary initial switches, not a warm-switch benchmark. Playwright click return and switch-trace completion are different boundaries. Issue click returns range **7.027–14.173 s** in this sequence; the traces retain their own completion/timeout times. No activity window exceeds 60.021 s. PREVIOUS’s first idle counter control records **2.866 reaction tracks/s, zero reaction-run callbacks and zero computed bodies**. The source-verification checks confirm the installer was bundled; zero is not inferred from a missing counter. Legacy store statistics can hit their bounded retention limits (`dropped` in the summary); those totals/key counts are not treated as a complete publication census when dropping occurs.

## Cadence, frames and rejected explanations

In the first verified warm NEW control, MobX records **966 reaction calls / 16.10 per second**, **613 tracks / 10.22 per second**, **1859 computed bodies / 30.98 per second**, and **392 projection refreshes / 6.53 per second**, for **59 pool deliveries**. Actual body counters exclude cache hits. The initial settled controls have **zero pool creations, projection creations, subscriptions or unsubscriptions**. Later warmed activity controls create/subscribe **22/10/14 projections per minute**, with **4/0/0 unsubscriptions**, versus hundreds of React commits; pool creations remain zero. Ordinary switches create more projections as panels mount. These later nonzero counts are not concealed as zero. This does not support a pool rebuild per heartbeat or subscription recreation on each React render. It does not rule out every intermittent loop outside the captured state.

The same window has **57 issue, 59 shell-session, 56 settings-session/setup and 118 chat-reference body runs**. These are expensive broad derivations on ordinary live deltas, rather than evidence of a free-running reaction loop. Freezing the broad projections together reduces main busy to **10.72%**, versus adjacent **21.73%/25.60%**, with all measured broad bodies absent; live input differs, so this is a combined attribution control rather than an additive savings estimate.

Stock NEW idle JavaScript rAF callbacks are **1.93/4.17 per second**, not one perpetual rAF per each of 228 visible rows. Intervals fire **6.33/6.47 per second** and take **179.0/128.3 ms** in their callbacks; rAF callbacks take **59.2/52.6 ms**. PREVIOUS intervals fire **5.32/5.70 per second**, with **62.8/60.8 ms** callback time and zero idle JS rAF callbacks. Callback timers do not include downstream asynchronous work. Closing the performance panel did not prove a total-CPU saving under the changing input; it is not named as a proven cause.

Stock NEW idle style/layout/paint task durations are **573.9/193.7/216.2 ms** and **576.2/194.0/263.1 ms**. PREVIOUS is **239.6/99.1/167.0 ms** and **183.8/90.0/134.2 ms**. Timeline paint spans and browser style/layout metrics have different boundaries and can overlap; they are not summed into busy time. Native trace presentation events in the profiled animation enabled/disabled control are **1065 → 177 per window**, approximately **17.75 → 2.95 per second**; `PrePaint` and `BeginCommitCompositorFrame` have the same respective counts. JS rAF callbacks increase **110 → 124** while those native events decline, confirming that CSS work is not measured by JS rAF count alone. Trace markers are counted once by event name; begin/end animation markers are not presented as individual frames. These are trace presentations, not a claim about display FPS.

## Animation and capture controls

Seven running CSS animations in the named controls comprise four `podium-mark-frames`, two `podium-run-sweep`, and one `status-strip-braille`. Counts can change with live agent status. All animations enabled/disabled/restored:

| Window | Main busy | Total isolated Chromium CPU | GPU CPU | Renderer compositor CPU |
|---|---:|---:|---:|---:|
| Unprofiled enabled | 39.48% | 53.03% | 5.75% | 4.92% |
| Unprofiled disabled | 35.90% | 43.98% | 1.10% | 1.05% |
| Unprofiled restored | 33.08% | 49.60% | 5.97% | 5.32% |

Hardware percentages are relative to **one core**; a process can exceed 100%. Messages are 296/288/265. The **9.05-point** first app-total difference is **17.1% of preceding total CPU**, but includes changing script/input work. GPU/compositor reductions return on restoration. These component reductions cannot be added to the individual animation reductions: animations share frame scheduling and interact.

A separate profiled CSS enabled/disabled/restored control has main busy **21.53%/15.39%/21.73%**. Enabled and disabled have exactly **189 messages**, and disabled has **more deliveries, 47 vs 42**. Style falls **803.6 → 6.3 ms**; `UpdateLayoutTree` falls **1066 events/810.43 ms → 23 events/6.41 ms**. This supports continuous animation-related main-thread work beyond JavaScript rAF callbacks. Pausing only `status-strip-braille` did not establish an independent app-total saving and is not separately named as a proven cause.

**The capture itself can be expensive.** A stock NEW run with CPU sampling and timeline recording reports renderer CPU **132.55%**, while browser main-task busy is **32.40%** and much of its profile is unattributed native work. Unprofiled renderer measurements are substantially lower. The profiled 132.55% is **not proof that the ordinary app reproduced the operator’s macOS 120%**. Native `(program)` samples are not assigned to an application function. Linux Chromium cannot establish macOS WebKit process CPU, thermal throttling, GPU driver cost or `kernel_task`; no such attribution is claimed.

## Evidence, privacy and validation

The [count-only companion summary](POD-4286-idle-cpu-summary.json) contains **69 completed windows** with timings, source-mapped top self/inclusive functions, long tasks, React commits, MobX runs, timer/rAF counts, style/layout/paint spans, live traffic cardinalities and isolated browser process/thread CPU. Function-inclusive time counts each source function once per sample stack, avoiding recursive double counting. Different inclusive functions/categories still overlap. Raw profiles, traces, map resolutions and manifests remain private on ludovico and are not attached or mailed. No issue titles, session content, corpus paths or cookie values are exported. Cookies are minted into memory and used only in isolated incognito contexts; collectors refuse to save the credential.

The first proof was confirmed in POD-4286’s agent transcript at **15:30:16 UTC**, within the first hour. Significant report iterations are attached to this measurement issue. The cause issues above are under POD-4286 (the CSS family has two separately proven sub-issues); none is claimed or implemented by this lane.

All production manifests were byte-checked. Stock source checks cover the embedded graph modules; diagnostic NEW verifies all modified modules, including the later activity-query wrapper. PREVIOUS’s counter-only variant explicitly installs counter hooks while preserving feature flags and verifies its installer and imported source content. An earlier bare installer import was removed by package side-effect pruning: strict verification caught it before a PREVIOUS window was accepted.

The historical web task omitted client-graph source from its cache inputs. It restored stale diagnostics; those projection pilots are discarded, and the gap is filed as POD-5824. Justified diagnostic rebuilds disable cache reads and writes. The exact three files of this investigation’s own diagnostic cache artifact were fingerprint-checked and moved aside; no other shared cache entry was changed. An early initial NEW raw profile was overwritten by an old stamp name; its existing numeric mapped summary is retained and marked `rawProfileAvailable: false`, while the other seven original windows are archived with distinct stamps. Later captures use run-prefixed names. Initial pilot Performance metric boundaries were too wide; those values are marked diagnostic only, and the initial comparison uses CPU sampling instead. A later PREVIOUS activity window overran to **62.516 s** and is not represented as an exact 60-second window.

Validation is the production builds, byte/source verification and sequential live captures under the heavy lease (one TTL expiry was immediately reacquired; no validation command overlapped in this session). The committed deliverable changes only measurement documentation, aggregate numbers and collectors; the lean product test gate is skipped because no product behavior changes. OLD `5e3ece5cd6` was optional and was not captured; mandatory proof/comparison work took priority. The operator’s installed app, global Bun, operator processes, main and dev/mw were untouched. The report lands fast-forward on `integrate/4286-pilot` under that branch’s merge lock.
