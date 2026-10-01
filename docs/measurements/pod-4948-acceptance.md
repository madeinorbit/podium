# Sidebar pilot browser acceptance

**FAIL on product candidate `721dd693787c863eb9c6d8c6fe58ab3d0da8d4b0`.**
Measured on flatblock on 2026-10-01 UTC for POD-4959. Two fixed bars pass and eight
fail. The pool substantially reduces most state work, but selection and full
switches remain slow, retained heap grows substantially, and draft changes do
not achieve the required relative CPU reduction. **S9, the operator's own day
of use on ludovico with the panel, is pending. The pilot is not accepted.**

This is measurement-only work. The product candidate was pinned by POD-4286
before capture; no product files were edited. The report's eventual integration
parent can include later work, which these numbers do not measure.

## Fixed bars and verdict

The [protocol](../../apps/web/harness/sidebar-acceptance-plan.json) was attached
to the issue before retained timing. Bars come from
[plan section 5](../plans/pod-4286-frontend-store-performance.md#5-acceptance-budgets-frozen-in-a3-before-optimisation)
and the operator's additional promises. No target was relaxed after capture.

| Fixed bar | Verdict | Evidence |
| --- | --- | --- |
| Idle client: zero work | **FAIL** | In 65 seconds, pool rows commit 4 times at 1× and 16 at 4×; sidebar-hook work is 0.7 / 1.7 ms. |
| Unrelated incoming update: zero sidebar derivations | **PASS** | All 82 qualified pool observations report zero sidebar derivations. This does not mean zero shared-store CPU. |
| One navigation publication per gesture | **PASS** | All 160 qualified pool clicks have one navigation publication, two separately labelled optimistic/outbox publications, and sometimes one clock tick; zero other publications. |
| Warm full issue switch input-to-paint p95 ≤ 100 ms | **FAIL** | Pool p95 **593.1 ms at 1×**, **1,412.8 ms at 4×**. |
| State CPU per hot-path event p95 ≤ 8 ms | **FAIL** | Every material event family exceeds 8 ms at both scales. Full-switch pool p95 is 96.4 / 547.1 ms; draft changes alone fit. |
| At least 50% lower p95 state CPU than legacy | **FAIL** | Material changes improve by 59.6–91.3%, but draft p95 regresses from 0.9→2.7 ms and 4.3→5.6 ms. The frozen check requires every measured hot-path cell to meet the bar. |
| Startup regression ≤ 10% | **FAIL** | Median startup rises 25.2% at 1× and 12.2% at 10× history. 4× passes this individual cell at +7.0%. |
| Retained-memory regression ≤ 10% | **FAIL** | Median retained V8 heap rises **115.6% / 141.5% / 78.3%** at 1× / 4× / 10× history. Broader reported heap also exceeds the limit. |
| Sidebar selection input-to-paint p95 ≤ 16 ms | **FAIL** | Pool p95 **67.0 ms at 1×**, **239.8 ms at 4×**. |
| Zero side-by-side differences | **FAIL** | Seven cold checks report 418 differences in total while loads are pending. All 17 settled checks match with zero pending. Cold differences are retained, not waived. |
| S9: one operator day on ludovico with the panel | **PENDING** | No operator day-use result has been supplied. Synthetic captures cannot satisfy this requirement. |

The plan's narrower idle snapshot budget **passes**: each idle window contains
one `coarseNow` publication and no other publication. Its clock exception does
not excuse row work under the operator's stronger zero-work promise. No broad
change allowance was requested for the single-issue/session updates here.

## Browser, build and corpus

| Property | Capture |
| --- | --- |
| Host / browser | flatblock; headless Chromium **153.0.8010.12** |
| Browser geometry | 1,800 × 1,000; reduced motion; trusted Playwright clicks |
| Product tree | `721dd6937`; same ordinary-production Vite assets for ON and OFF |
| Renderer | Ordinary React production renderer, source maps, no minification; no profiling-renderer substitution |
| Build checkpoint | `65e004275`; subsequent fixture changes were erased type annotations; collection routing changed without rebuilding product assets |
| Toolchain | Bun **1.4.2**, checkout-local frozen dependencies in `~/podium-test-4959`, private `.toolchain` and its `LD_LIBRARY_PATH` |
| Data | Canonical synthetic seed **4443**; no operator data, exports, screenshots or dumps were transferred |
| Switch | `mobxSidebar=0` or `1`, read once at startup in a fresh context; never changed under mounted hooks |
| Mutation ownership | Real StoreProvider runtime, its replica, IndexedDB adapter and existing kernel outbox; incoming changes patch that replica; gestures use production actions |
| RPC / feed | Synthetic replies, empty transcripts/comments/cost responses, network disabled |
| Clock | 2026-09-20 noon anchored and advancing with `performance.now`; read timestamps remain distinct |
| Order | Same-build arms interleaved, reversing first arm on alternating iterations |
| Load qualification | Per-record `uptime`, uptime seconds and load averages retained; load > 8 voids a record |

| Cell | Issues | Input / runtime sessions | Resident pool table rows after GC, first pair |
| --- | ---: | ---: | ---: |
| 1× | 4,867 | 4,304 / 4,302 | 4,746 |
| 4× | 19,468 | 17,216 / 17,208 | 18,801 |
| `h10a1` | 27,601 | 30,611 / 30,609 | 5,066 |

`h10a1` grows history tenfold while retaining one unit of active work. Resident
table counts are a census, not an atom count or an explanation of all retained
bytes. The memory guard compares the whole measured client heap.

The sidebar-only surface mounts production `SidebarUnified` and its companion
command-palette/provider path. The full surface adds the production mission-keyed
`FlightDeck`, `Workspace`, and issue-tab `RightDock`. It does not reproduce every
AppShell route, chrome wrapper, dock tab, long transcript, daemon attach or remote
network latency. S9 remains necessary for real operator use.

## Samples and measurement definitions

The headline matrix contains **960 qualified timing records**: 40 observations
per mode, scale and event cell, after six warm-ups. There are **56 count/lifecycle
records** and **60 memory/startup records**. The gate reads their 1,140 raw records,
including **64 high-load voids**, and uses 1,076 qualified records. Void records
never enter a percentile.

Timing p95 is nearest rank `ceil(0.95*n)`: the **38th sorted observation at n=40**.
Maxima are separate. Each switch distribution mixes six nominated mounted
issues, including the two largest mounted missions. A target has only six or
seven visits; there is no per-target p95 claim. The target files retain ids and
deck-row counts; the large missions have 307/187 rows at 1× and 325/285 at 4×.

The input marker uses the trusted click's `event.timeStamp`. A MutationObserver
marks the selected row's committed DOM state. The headline endpoint is the first
same-renderer Chromium `Paint` event after that marker, including its duration.
This is browser paint completion, not physical display presentation or total
settlement of every pane. The two-animation-frame proxy is retained separately
in every raw record and is not substituted for actual paint.

State CPU is the **union of synchronous execution intervals**, not a sum of
nested timings: runtime batches, real replica delivery/selectors, passive pool
computed/reaction bodies, and wrapped mission/session-ownership/issue-view-model
helper bodies. Direct row-render intervals are excluded; an enclosing MobX
reaction can still include observed render work. This is instrumented elapsed
execution time, a conservative state/observer-work measure, not an OS thread-CPU
counter. Both arms use the same instrumented assets. It is not every JavaScript
function in the app, and instrumentation has overhead.

The event window continues through the fixed post-click observation and real
IndexedDB settlement. State work after the first paint therefore counts; CPU can
exceed input-to-paint time. RAF waiting and asynchronous IDB request latency are
not counted as CPU. Separate profiled repetitions explain source ownership and
are excluded from the headline gate.

Memory/startup use ten fresh contexts per arm/cell, with instrumentation inactive.
Startup includes context creation, navigation, canonical seeding, runtime ready,
fonts and two RAFs. Retained heap is CDP `Runtime.getHeapUsage` after two forced
collections, separated by 150 ms, following a 500 ms wait. The frozen statistic
is the ratio of arm medians; **n=10 has no p95**. Reported broader retained heap
adds V8 used bytes, embedder heap and backing storage; it is not browser-process
RSS or GPU memory. No regression approval or allowance was used.

## Input-to-paint distributions

All values are milliseconds; **n=40 in every row**.

| Surface / scale | Legacy median | Legacy p95 | Legacy max | Pool median | Pool p95 | Pool max | Pool target |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Selection / 1× | 158.6 | 183.4 | 198.1 | 51.8 | **67.0** | 79.2 | 16 |
| Selection / 4× | 1,293.7 | 1,516.5 | 1,928.6 | 186.2 | **239.8** | 280.4 | 16 |
| Full switch / 1× | 333.3 | 715.6 | 738.5 | 208.2 | **593.1** | 720.0 | 100 |
| Full switch / 4× | 1,767.9 | 2,483.7 | 2,682.8 | 636.4 | **1,412.8** | 1,585.8 | 100 |

## State CPU by event

Milliseconds; **n=40 per arm/cell**. A negative reduction means a regression.
The 8 ms limit and the 50% reduction limit both apply in the frozen checker.

| Event | 1× legacy p95 | 1× pool p95 | Reduction | 4× legacy p95 | 4× pool p95 | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sidebar click | 173.3 | 39.6 | 77.1% | 2,143.3 | 185.4 | 91.3% |
| Full issue switch | 238.4 | 96.4 | 59.6% | 2,567.6 | 547.1 | 78.7% |
| Unrelated hidden-session heartbeat | 109.6 | 37.5 | 65.8% | 1,280.5 | 256.4 | 80.0% |
| Visible issue title / projection update | 102.4 | 36.5 | 64.4% | 1,268.9 | 198.8 | 84.3% |
| Visible session phase / activity update | 113.4 | 43.5 | 61.6% | 1,350.3 | 268.5 | 80.1% |
| Existing store draft action | 0.9 | 2.7 | **−200.0%** | 4.3 | 5.6 | **−30.2%** |

The unrelated-update graph result is useful: it proves the sidebar computes
nothing, while exposing substantial remaining shared-store work. It does not
justify calling that incoming event free. Draft changes are cheap in absolute
terms, but fail the fixed relative-benefit check; this is not hidden by averaging
them together with expensive changes.

## Startup and retained memory

Ten observations per arm/cell. Durations are seconds and heap sizes are MiB.
These are **medians**, not p95s; raw maxima remain in `summary.json` and the records.

| Cell | Legacy startup | Pool startup | Regression | Legacy retained V8 | Pool retained V8 | Regression |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1× | 2.257 | 2.827 | **25.2%** | 29.0 | 62.6 | **115.6%** |
| 4× | 7.417 | 7.936 | 7.0% | 86.6 | 209.1 | **141.5%** |
| 10× history | 9.003 | 10.098 | **12.2%** | 93.1 | 166.0 | **78.3%** |

Broader retained-heap regressions are **76.5%, 97.0%, and 63.7%** respectively.
Startup V8 heap also grows **148.7%, 84.9%, and 23.8%**. The large resident-heap
increase is present with counters and active timing instrumentation disabled.

## Counts, cold comparison and lifecycle

Pool startup records have **zero legacy `worklist` slice derivations** at both
scales; the OFF arm has two. The startup mode and actual attached pool are
independently asserted. Counter resets clear the panel's connected/row scalars,
so a later raw panel `connected:false` is reset metadata, not a switch-off. The
runtime state, startup record and positive derivation observations prove the
pool remains attached. `storeStats.reactCommits=0` is unwired diagnostic metadata,
not proof of zero React commits; the idle row counter is independently wired.

| Scale | Pool idle row commits | Pool idle derivations | Pool hook work | Legacy row commits / derivations / hook work |
| --- | ---: | ---: | ---: | --- |
| 1× | 4 | 0 | 0.7 ms | 198 / 1 / 32.9 ms |
| 4× | 16 | 0 | 1.7 ms | 791 / 1 / 150.2 ms |

For selection, the raw total is usually **three** publications: one navigation
plus two optimistic/outbox publications. A clock tick sometimes makes four.
The pass concerns the navigation budget with those legitimate publications
labelled separately, as section 5 requires; it is not a claim of one total
publication for the entire outbox lifecycle.

| Scale | Ordered cold comparison results: differences / pending |
| --- | --- |
| 1× | 51/47, 2/1, 2/1, then nine 0/0 results |
| 4× | 314/285, 38/24, 9/4, 2/1, then eight 0/0 results |

The seven nonzero results all have pending loads. The first difference is
`idNumber` on a cold snoozed row. The shipped checker reads the declared
`LOADING` representation, and later comparisons settle without product changes.
This establishes a cold diagnostic/readiness failure under the strict bar; it
does **not** establish a persistent settled field mismatch or justify removing
LOADING behavior. The 418 reports are not 418 unique defects. The raw differences
and pending counts are not discarded.

Principal changes and same-principal configuration rebuilds were also exercised
through the real provider, followed by two forced collections. One observation
per case is **not a percentile**.

| Scale / arm | New principal ready | Same-principal rebuild ready | Surviving retired WeakRefs after each observation |
| --- | ---: | ---: | --- |
| 1× legacy | 875 ms | 1,522 ms | 2 / 4 |
| 1× pool | 1,115 ms | 1,952 ms | 9 / 9 |
| 4× legacy | 3,963 ms | 6,951 ms | 2 / 4 |
| 4× pool | 5,098 ms | 8,060 ms | 9 / 9 |

The pool's first retired runtime, replica, pool, tables, relations, worklist,
groups, clock and residency remain reachable at these capture points. Legacy
references also survive. These observations warrant a retention-ownership audit,
but they do not identify a retaining path or prove a production leak; there is
no heap-snapshot dominator claim.

## Switch attribution

Separate ordinary-renderer CPU profiles use 1,000 μs sampling, aligned by scale,
arm, target and iteration with the 40 headline full switches. Each profiled
trace is clipped from the trusted input to its actual selected-state paint.
Source ownership is exclusive: sidebar/pool, shared engine, Workspace/FlightDeck,
issue page/dock, session panes, chips, IndexedDB JS, and explicit framework/native
residuals. Profiled wall times are not substituted into headline percentiles.

Layout/style/paint timeline totals and IDB enqueue/request-to-success observations
are separate. Timeline spans can nest; async request latency includes event-loop
delay. Neither is added to the sampled CPU buckets. Source paths identify owners;
wrapper transformations limit precise original line-number interpretation.

All **160 qualified profiles** match a qualified headline switch by scale, arm,
target and iteration: 40 per arm/scale. One earlier 4× legacy profile at load
8.7 is retained as void; only that missing key was replaced. There are 161 raw
profile records. No profiled repetition changes a headline result.

The following are **mean exclusive sampled milliseconds across 40 switches**,
not p95s. Every individual switch has the same ownership split in
`attribution-summary.json`. The explicit residual combines program/native
unmapped work, other app/fixture code, legacy runtime/viewmodels and idle samples.

| Sample ownership | 1× legacy | 1× pool | 4× legacy | 4× pool |
| --- | ---: | ---: | ---: | ---: |
| Sidebar / pool | 22.6 | 6.3 | 99.8 | 25.1 |
| Shared engine / navigation | 78.3 | 10.2 | 982.6 | 50.2 |
| Workspace / FlightDeck | 33.3 | 34.6 | 155.4 | 165.5 |
| Issue page / dock | 19.6 | 22.9 | 105.3 | 131.6 |
| Session panes | 15.6 | 14.1 | 40.0 | 43.4 |
| Issue chips | 8.6 | 8.4 | 44.2 | 46.8 |
| IndexedDB JavaScript | 0.2 | 0.1 | 0.3 | 0.2 |
| Native rectangle / layout call | 39.0 | 37.9 | 66.7 | 102.3 |
| React / framework / libraries | 134.7 | 98.4 | 287.1 | 173.4 |
| Garbage collection | 10.1 | 9.5 | 71.7 | 40.7 |
| Explicit residual | 56.9 | 54.7 | 116.8 | 103.9 |
| Profiled input-to-paint window | 418.8 | 297.1 | 1,969.8 | 883.2 |

This points to a substantial removal of shared navigation work, with costly
main panes and layout remaining. `computeMissionIssueIds` is prominent in
legacy profiles; pool profiles still show `issueSessions`,
`archivedSessionsForIssue`, `indexMissionSessions` and transcript-scroll work.
These are observations of this fixture's source ownership, not proof that one
function alone causes the entire failed acceptance percentile.

The two largest nominated missions illustrate why the full-switch tail remains
large. Each target has **seven observations**; these are medians, never p95s.
The headline column comes from the original unprofiled matrix. Source bucket
medians come from separate profiled repetitions and cannot be summed into it.

| Pool target / scale / deck rows | Headline paint median | Workspace / FlightDeck sample median | Issue page / dock sample median | Native rectangle / layout sample median |
| --- | ---: | ---: | ---: | ---: |
| `i1766` / 1× / 307 | 575.1 | 77.7 | 33.5 | 110.7 |
| `i938` / 1× / 187 | 505.2 | 50.1 | 40.3 | 71.6 |
| `i13916` / 4× / 325 | 1,385.0 | 300.4 | 157.1 | 341.2 |
| `i19016` / 4× / 285 | 1,195.8 | 263.9 | 186.5 | 110.4 |

Separate timeline means retain style, layout and painting explicitly. These
spans may overlap sampled CPU and one another; **do not add them to the table
above**.

| Timeline mean, ms | 1× legacy | 1× pool | 4× legacy | 4× pool |
| --- | ---: | ---: | ---: | ---: |
| UpdateLayoutTree | 18.3 | 18.1 | 53.5 | 62.0 |
| Layout | 39.7 | 38.0 | 87.1 | 91.9 |
| PrePaint | 9.5 | 8.8 | 27.9 | 18.4 |
| Paint | 16.4 | 14.8 | 47.5 | 33.0 |

The request probe instruments `IDBObjectStore.getAll`, not every database
operation. Each profiled switch records one real outbox read, for 40 requests
per arm/scale. The fixture's `settled()` only awaits queued writes; it does not
issue an extra read. Enqueue medians are 0.0 ms in all four cells, with maxima
0.3 / 0.8 / 0.2 / 2.6 ms. Request-to-success-handler latency medians are
25.9 / 29.4 / 51.9 / 59.9 ms, with separate maxima 82.9 / 109.2 / 172.5 / 170.7
ms, in legacy-1× / pool-1× / legacy-4× / pool-4× order. This asynchronous latency
includes event-loop delay, can continue after paint, and is neither disk-only
latency nor an additive CPU bucket.

## Evidence, reproduction and controls

Collectors are [the browser driver](../../apps/web/harness/sidebar-acceptance.ts),
[production fixture](../../apps/web/test/sidebar-acceptance.browser.tsx),
[build configuration](../../apps/web/harness/sidebar-acceptance.vite.ts),
[fixed-bar checker](../../apps/web/harness/sidebar-acceptance-analyze.py), and
[source attribution](../../apps/web/harness/sidebar-acceptance-attribution.py).

Raw JSONL, traces, profiles, build assets/source maps, collector sources,
provenances, target nominations and negative-control evidence are permanent
**POD-4959 issue artifacts**. Their bytes were copied before the large working
copies were removed from flatblock. Archives are not committed merely to attach
them. Artifact paths below are storage selectors, not promises that scratch
files remain in a checkout.

| Artifact selector under `.artifacts/sidebar-acceptance-evidence/` | Bytes | Contents |
| --- | ---: | --- |
| `headline-evidence.tar.gz` | 47,429,692 | All 1,140 count/timing/memory raw records, including 64 voids; 320 headline click traces; summary, targets, provenances and original control proofs |
| `attribution-evidence.tar.gz` | 45,825,428 | All 161 profile records and their traces/profiles; 160-record source summary; exact headline matching index; ordinary build/source maps; collector sources; nine control proofs; excluded attempts |
| `summary.json` | 325,863 | Raw-derived fixed-bar verdict and distributions |
| `attribution-summary.json` | 663,367 | Per-switch exclusive ownership, timeline, IDB events, top source frames and the single void |
| `verdict-negative-controls.json` | — | Eighteen planted failures and restoration |
| `attribution-negative-controls.json` | — | Nine planted failures and restoration |
| `synthetic-4x.png` | — | Synthetic production-sidebar review image; no live data |

SHA-256:

```text
headline-evidence.tar.gz
9b73200a8c3213ac366579c2a46fc928c2575c980db076963b5c684be1b99aae
attribution-evidence.tar.gz
bf67a447b37cf91a49fb854e5634d6a24fa45ba00eb6ffb5fbaa8ebcfe8362d9
summary.json
99ec6582f358b4ec6c849a111bed1be6e05255d98ae19a88989a4f20bfdab950
attribution-summary.json
6a93520f4e3180f9c3e9487dfc072ef33920ab61d790e5ed647b294bd83d1ef3
frozen protocol: apps/web/harness/sidebar-acceptance-plan.json
35f54815e5ee4d706ecec666d31739492342dd2d5167a05a7d7f054a895ca814
```

List or retrieve evidence from any session:

```bash
timeout 20s podium issue artifact POD-4959
timeout 20s podium issue artifact POD-4959 --get .artifacts/sidebar-acceptance-evidence/summary.json
timeout 20s podium issue artifact POD-4959 --get .artifacts/sidebar-acceptance-evidence/attribution-summary.json --out /tmp/pod-4959-attribution.json
timeout 20s podium issue artifact POD-4959 --get .artifacts/sidebar-acceptance-evidence/headline-evidence.tar.gz --out /tmp/pod-4959-headline.tar.gz
```

The CLI caps reads at 16 MiB; for either archive it returns the artifact's
streaming `/files/artifact/…` URL. Download those bytes rather than treating the
cap refusal as missing evidence. Extract both archives into a fresh directory
to recreate `.artifacts/sidebar-acceptance`. The fixed-bar checker reads only
count/timing/memory records; attribution reads profiles and `headline-index.json`.

```bash
timeout 300s python3 apps/web/harness/sidebar-acceptance-analyze.py --root .artifacts/sidebar-acceptance
timeout 300s python3 apps/web/harness/sidebar-acceptance-attribution.py --root .artifacts/sidebar-acceptance
```

Adding `--require-all-bars` to the fixed-bar command exits 1 for this candidate.
A successful analysis means the records were processed; it does not turn the
reported acceptance failure into a pass.

For a new capture, use the pinned product tree and archived measurement sources,
the checkout-local setup, and the private flatblock toolchain described above.
Build once with `timeout 180s bun apps/web/harness/sidebar-acceptance.ts
--phase=build`; retain those same assets for both arms. Run `counts`, `timing`,
`memory` and `attribution` sequentially with foreground timeouts. Timing, memory
and attribution require a successfully acquired `bench:flatblock` lease and
`--lease-confirmed`; a queued response is not a grant. Release after each
completed timed phase. `--resume` fills missing qualified timing cells or matched
profile keys without replacing eligible records. The raw records' uptime and
load qualification remain authoritative.

Verification ran on flatblock with foreground commands and timeouts. The web
fixture passed uncached typecheck; its 15 unchanged dependency projects passed
earlier and were not repeated. The runtime fixture built and its actual startup
mode guard was red on a forced wrong mode, then green after `cp` restoration.
The six-target guard was red on a duplicated target and restored with `cp`.

The final checker catches **12 planted raw-record failures**: idle work,
unrelated derivation, duplicate navigation, warm switch, state CPU, relative
benefit, startup, retained heap, selection frame, parity, missing cell, and high
load. **Six source plants** prove nested intervals cannot be double-counted,
max cannot be presented as p95, sparse data cannot get a p95, and streaming
compaction cannot lose CPU, derivation or publication inputs. Every plant was
red; `cp` restoration was green. **Nine separately proven attribution plants**
reject absent/duplicate input marks, an invalid paint window, overlapping sample
accounting, void/high-load profiles, wrong targets, duplicate keys and missing
keys. The final restored analyzer successfully processed all 160 matched
profiles. Passed checks were not repeated on unchanged code.

The default lean gate was not run: this adds isolated measurement files and a
report, with no shipping product runtime change. The appropriate evidence is
the uncached fixture typecheck, build, negative-control proofs and actual browser
captures; no suite-level pass is claimed.

Early invalid attempts are kept separately: seed 1 failed target preflight before
retained timing; a wrong draft action stopped an initial count probe; 4× nominated
folded targets stopped before its timing; a bounded run ended with six full-switch
pairs missing; the continuation filled only those pairs and eight load-void
update pairs. It preserves the original 64 void records. A six-record attribution
attempt started before a queued lease was granted; its recorded PID was stopped,
the overlap was mailed to the lease holder, and the entire attempt is excluded.
A later grant notification conflicted with CLI owner status; that startup was
also stopped by recorded PID before emitting any records, and the possible
overlap was mailed to the prior owner. Both attempts are archived separately.
Bounded source-profile continuations filled only missing matched keys, preserving
the single load-void profile. Completed headline, memory and retained-profile
runs held confirmed leases. The final lease was released immediately after
capture, and POD-4968 received its requested handoff notice. No unrelated
server/daemon was restarted and no pattern-based process kill was used.

## Open work

POD-5122 tracks clock-driven idle row work, POD-5123 cold comparison readiness,
POD-5126 the pool heap budget, and POD-5127 selection state cost. All four are
unclaimed Proposed discoveries with `discovered-from` dependencies on POD-4959.
POD-5100 remains open: title rename reads seven pool rows against a budget of
three; this measurement issue does not fix or waive it. Main-pane migration
under POD-5076 and the known FlightDeck layout issue POD-5104 remain relevant.
These findings are handed off with the completed evidence; this issue changes
the measurement tools and report only.

**S9 stays pending until the operator supplies the date/window, panel results and
observed problems from a day of use on ludovico.** Live data must stay there;
text/count evidence is sufficient for this report's day-use handoff. None of the
synthetic results constitutes that day, and the failed bars are not an approval
to enable the pilot by default.
