# POD-5077 switch acceptance

POD-5093, 2026-10-03. **Operator-size acceptance is GREEN on exact landed `fba57c0c8fd01c24c2a9258d4a734961e76fdf80`.** ON mission, small-mission and session switching satisfy store/derive p50 <200 ms and p95 <500 ms. Final synthetic diagnostics and five private replays have zero unexpected differences or pending rows. All 120 ON timed gestures across both sizes have zero actual legacy, mission and engine-selection entries; all four global command-launch counters remain zero. Account release is bounded: nine objects remain before real successor focus in ON and zero afterward. The 4× mission p50 remains a negative stress result at 240 ms, explicitly accepted as non-blocking by POD-4286 and owned by POD-5421, with reader attribution for POD-5454. This issue has changed no defaults or application source.

Both paired measurements use exactly `fba57c0c8f`, as instructed by POD-4286. It contains POD-5406 and excludes POD-5437's legacy removal, so OFF and ON remain available in the same build. The owner's first changed-source 4× attempt retained only 39 of 120 records and is incomplete; it is not combined with any completed capture. Historical frozen-product results below remain RED before this fix.

## Evidence status

| Requirement | Evidence | Result |
| --- | --- | --- |
| Store and derive p50 <200 ms, p95 <500 ms | Exact `fba57c0c8f`, 120 retained profiles at each size | Passes at operator size; 4× mission p50 misses |
| IndexedDB, layout and total reported separately | Exclusive CPU partition, request wait union and Chromium layout/paint union below | Recorded at both sizes |
| Zero legacy mission, selection and ownership work | Chromium 153, all sixteen switches ON, 120 final ON gestures on exact `fba57c0c8f`; earlier candidate/frozen controls retained | Zero entries |
| Synthetic corpus parity | Final exact-source 4× browser diagnostics; 1× render fields and earlier diagnostics; focused corpus/rendering files | Zero diagnostic differences / pending; raw timer labels advance |
| Private operator replay | Five ludovico checks on exact `fba57c0c8f`; earlier aligned frozen-base replay retained | Zero unexpected differences / pending; accepted ownership changes disclosed below |
| Account switch leaves no survivors | Landed `70f3c661f4` operator-size probe and final exact `fba57c0c8f` 4× probe; Alice → Bob → Alice, actual principals checked | Bounded release: OFF 0/0; ON 9 before real successor focus, 0 afterward |
| Focused corpus and rendering gates | Saved results, three missing node files and the aligned navigation case: all fourteen files have passing evidence | Green |

## Final operator-size timing

Flatblock, Chromium 153.0.8010.12, AMD EPYC, headless 1800×1000, reduced motion, production build and seed 4443. Product and compiled source are exactly `fba57c0c8fd01c24c2a9258d4a734961e76fdf80`. The fresh build contains 578 assets/maps, 26,973,125 bytes; its complete hash manifest is saved with collector SHA256 `85c791a8d71632acce2844aee3df1f8d7c60dbd6dbbc2f538ce4d174d1735f77` and unchanged analyzer SHA256 `0f02f252852879df4cb69fbc51c649657266c9d7b33d676d29bb464aa23fb1e8`.

The corpus, targets and protocol match the frozen operator-size baseline: 4,867 issues / 4,302 sessions, missions `i1766`/`i938`, small missions `i1006`/`i1137`, sessions `s3`/`s2`, two warmups and twenty retained samples per arm/action, with alternating OFF/ON pairs. The corrected collector uses `click({noWaitAfter:true})` to avoid Playwright's unrelated scheduled-navigation wait; trusted pointer input, expected DOM, qualifying Chromium Paint, selected-target and error checks are retained. Host phase markers and bounded CDP waits identify collector stalls without changing the measured input-to-Paint interval.

All numbers are milliseconds, nearest-rank p50 / p95. The store column is an exclusive sampled elapsed-time estimate, including library descendants of data frames. Native layout/paint intersections, GC, idle and IndexedDB adapter JS are separate. Request wait overlaps the other columns, and independent percentiles do not sum. The end is the first qualifying Chromium Paint, not physical presentation.

| Action / arm | Store and derive | IndexedDB JS | IndexedDB wait | Layout / paint | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mission / OFF | 161.9 / 262.7 | 0.0 / 1.2 | 81.8 / 150.3 | 160.1 / 213.0 | 743.7 / 1,062.3 |
| Mission / ON | 77.5 / 170.2 | 0.0 / 0.7 | 224.9 / 303.8 | 143.8 / 205.4 | 697.0 / 1,036.4 |
| Small mission / OFF | 104.6 / 132.3 | 0.0 / 1.1 | 19.9 / 26.9 | 16.5 / 23.4 | 262.0 / 320.5 |
| Small mission / ON | 12.9 / 19.1 | 0.0 / 0.3 | 28.6 / 46.3 | 16.8 / 23.3 | 102.3 / 133.8 |
| Session / OFF | 234.0 / 298.2 | 0.0 / 0.4 | 11.5 / 14.3 | 27.7 / 48.6 | 798.2 / 922.6 |
| Session / ON | 79.0 / 104.5 | 0.0 / 0.3 | 16.1 / 21.0 | 29.2 / 36.6 | 638.8 / 734.4 |

Every ON gesture has zero `catalogBuilds`, `issueBuilds`, `coldSessionVisits` and `usageQueries` deltas; addressed session reads peak at two. Actual legacy, mission and navigation entry maps are zero. OFF remains an armed positive control, and independently mapped legacy data contributes 6,735.486 ms across its saved profiles. Retained inputs begin at 18:51:04.5901 UTC and the final Paint ends at 18:55:10.542691. The exclusive timing lease was acquired before the foreground run and released after all 120 records/manifest were saved and PID 1264868 exited 0. Per-sample one-minute host load ranges from 8.79 to 15.35 and is retained in the records.

Artifact 27 retains the complete operator-size analysis. This timing-only manifest explicitly marks verification incomplete; empty diagnostic/lifetime arrays are not claimed as passing evidence. Raw OFF/ON text differs only in advancing countdowns (`12:10`/`12:06` and `7:41`/`7:36`); deck/dock labels and all other text match.

## Final 4× timing

The same fresh `fba57c0c8f` build, Chromium configuration, seed and twenty-sample alternating protocol run on 19,468 issues / 17,208 sessions. Targets match the frozen 4× baseline: missions `i13916`/`i19016`, small missions `i10006`/`i10061`, sessions `s8608`/`s11337`. The metric partition and percentile definitions are unchanged.

| Action / arm | Store and derive | IndexedDB JS | IndexedDB wait | Layout / paint | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mission / OFF | 1,411.1 / 2,062.1 | 0.0 / 1.3 | 227.3 / 296.4 | 173.8 / 216.3 | 2,829.4 / 3,458.5 |
| Mission / ON | 240.0 / 321.6 | 0.0 / 1.0 | 261.8 / 325.5 | 185.9 / 206.5 | 1,069.3 / 1,670.4 |
| Small mission / OFF | 1,177.8 / 1,368.0 | 0.0 / 2.2 | 47.6 / 63.5 | 23.0 / 29.6 | 1,688.4 / 2,103.5 |
| Small mission / ON | 114.1 / 133.4 | 0.0 / 0.0 | 56.8 / 79.5 | 23.7 / 30.0 | 327.7 / 362.8 |
| Session / OFF | 2,466.7 / 2,763.3 | 0.0 / 0.3 | 13.2 / 17.4 | 30.5 / 90.5 | 3,473.1 / 3,853.2 |
| Session / ON | 194.0 / 225.9 | 0.0 / 0.0 | 19.5 / 25.4 | 33.7 / 85.8 | 871.9 / 1,139.7 |

All sixty ON legacy, mission and navigation maps are zero; the four global launcher deltas remain zero, with addressed session reads at most two. The cold-session counter was armed at 11,231 before the retained ON gestures. Positive OFF source-map attribution contributes 86,438.232 ms of legacy data work. Artifact 28 retains the complete 4× analysis.

Small-mission and session budgets pass; mission p50 exceeds 200 ms by 40 ms, while its p95 is below 500 ms. Remaining mission self time is led by `reader-queries.ts:118 activity` (66.450 ms mean); small switches include its `question.roots.some` callback. POD-4286 confirmed at 19:19 UTC that this negative stress result does not block operator-size acceptance. POD-5421 owns the 4× mission target; POD-5454 can use the remaining reader attribution. No product change was made in this measurement lane.

The separate twenty-minute lease was granted at 18:57:34.935 UTC. Retained inputs begin at 18:59:09.2224 and the final Paint ends at 19:09:14.653938. All 120 records/manifest were saved, PID 1281563 exited 0, and the lease was released. A later audit finds no surviving recorded descendants from either timing capture. Per-sample one-minute load ranges from 5.31 to 11.05. The timing-only verification arrays are unavailable; raw render differences are only countdowns (`17:02`/`16:52`, `21:43`/`21:33`), with all other text and deck/dock labels equal.

## Operator-size timing before the fix

Flatblock, Chromium 153.0.8010.12, AMD EPYC, headless 1800×1000, reduced motion, production build and seed 4443. The 1× corpus has 4,867 issues and 4,302 runtime sessions, closest to the private replay's 6,087 issues. Mission targets are `i1766` and `i938`; small targets `i1006` and `i1137`; session targets `s3` and `s2`. Two unretained warmups precede twenty retained samples per arm and action. OFF/ON order alternates within each sample pair. Collector source is `4ea25fecfb`, compiled build source `28df06bb49`, with product identical to frozen `c38a12b360`.

All numbers are milliseconds, shown as nearest-rank p50 / p95. The store column is an exclusive sampled elapsed-time estimate, including library descendants of data source frames. Native layout/paint intersections, GC, idle and IndexedDB adapter JS are excluded from it. The input window ends at the first qualifying Chromium Paint after the expected DOM change; it does not measure physical display presentation. IndexedDB request wait overlaps CPU/layout and must not be added to these columns. Columns have independent percentiles and do not sum.

| Action / arm | Store and derive | IndexedDB JS | IndexedDB wait | Layout / paint | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mission / OFF | 138.2 / 175.6 | 0.0 / 1.2 | 75.6 / 98.6 | 140.1 / 167.6 | 662.4 / 762.7 |
| Mission / ON | 226.2 / 253.4 | 0.0 / 0.0 | 191.6 / 235.2 | 131.1 / 180.6 | 768.3 / 953.7 |
| Small mission / OFF | 98.9 / 113.5 | 0.0 / 1.2 | 17.5 / 19.1 | 14.9 / 17.7 | 235.9 / 268.2 |
| Small mission / ON | 117.7 / 136.3 | 0.0 / 0.4 | 28.2 / 34.8 | 15.1 / 17.5 | 210.5 / 248.9 |
| Session / OFF | 216.9 / 273.1 | 0.0 / 0.6 | 10.2 / 13.0 | 19.6 / 26.9 | 733.9 / 830.1 |
| Session / ON | 287.9 / 365.4 | 0.0 / 0.1 | 16.1 / 20.1 | 26.2 / 34.3 | 873.5 / 994.9 |

The command-launch computed projection accounts for about 112 ms mean inclusive data time on mission switches and 203 ms on session switches. All three ON p95 values are below 500 ms; mission and session p50 are above 200 ms. Retained inputs begin at 15:51:41.5855 UTC and the last timed Paint is 15:55:46.347773, within the twenty-minute lease granted at 15:43:19.792. The lease was renewed during the foreground capture and released after its recorded process exited. The collector saved all 120 records and the timing manifest before exiting. This timing-only run does not claim diagnostic or account results from its empty arrays. The raw OFF/ON render snapshots differ only in two live countdown labels (`11:50`/`11:47` and `7:33`/`7:29`); all other text and labels match. Deterministic rendering gates supply clock-aligned parity evidence.

## 4× timing before the fix

Flatblock, Chromium 153.0.8010.12, headless 1800×1000, reduced motion, production build and seed 4443. This corpus has 19,468 issues and 17,208 runtime sessions. Mission targets are `i13916` and `i19016`; small targets `i10006` and `i10061`; session targets `s8608` and `s11337`. Two unretained warmups precede twenty retained samples per arm and action. OFF/ON order alternates within each sample pair. Collector source is `4f25749049`, compiled build source `28df06bb49`, with product identical to frozen `c38a12b360`; the build asset hash manifest is retained.

The columns use the same partition and percentile definitions as the operator-size capture above.

| Action / arm | Store and derive | IndexedDB JS | IndexedDB wait | Layout / paint | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mission / OFF | 1,317.3 / 1,496.7 | 0.0 / 1.1 | 136.6 / 197.6 | 178.3 / 268.3 | 2,484.4 / 2,780.0 |
| Mission / ON | 1,724.3 / 2,102.9 | 0.0 / 0.1 | 253.0 / 330.7 | 178.6 / 213.7 | 2,621.9 / 3,542.5 |
| Small mission / OFF | 1,101.8 / 1,208.3 | 0.0 / 1.2 | 39.1 / 45.6 | 21.9 / 27.8 | 1,551.3 / 1,709.9 |
| Small mission / ON | 1,486.4 / 1,692.4 | 0.0 / 0.2 | 52.5 / 77.2 | 22.9 / 28.5 | 1,803.7 / 2,191.7 |
| Session / OFF | 2,312.6 / 2,534.8 | 0.0 / 0.0 | 12.5 / 16.2 | 34.8 / 146.0 | 3,232.3 / 4,009.7 |
| Session / ON | 3,296.6 / 3,603.6 | 0.0 / 0.1 | 19.3 / 28.1 | 48.0 / 100.4 | 4,417.9 / 4,900.4 |

The dominant ON sampled leaf work is `command-launch-views.ts` projection and its repeated repo/worktree path matching over cold session summaries. Those three projection frames account for about 1,473 ms mean self time per mission switch and 2,920 ms per session switch. This is new command-view work; the legacy mission, selection and ownership entries remain zero. POD-4286 assigned the nested scan and click-triggered recomputation to POD-5406 before any product edit in this lane.

The lease was granted at 14:44:41.853 UTC for fifteen minutes. Retained inputs span 14:46:47.4425 through the last timed Paint at 14:59:06.204697, before expiry at 14:59:41.853 and the next grant at 14:59:52.629. The 900-second foreground timeout stopped the subsequent untimed diagnostics before the final manifest. All 120 per-sample profiles, traces and records survived; the recovered manifest explicitly marks verification incomplete and raw rendered comparisons unavailable. Empty correctness/lifetime arrays are unavailable evidence, not passing results. The collector now saves timing metadata before checks and can run the timing phase independently.

## Correctness and legacy work

The verification uses the shipped sidebar, FlightDeck, Workspace, RightDock and chat panel in a minified production build, with real IndexedDB and the existing actions/outbox. The API answers are synthetic; external requests are blocked. It does not contact or restart the operator's server or daemon.

The historical operator-size synthetic corpus has 4,867 issues and 4,302 runtime sessions (seed 4443). The mounted mission targets `i1766` and `i938` contain 307 and 187 full deck rows; small targets have one row. Startup URL overrides enable all sixteen landed switches: sidebar, pane, session pane, chat context, header, chips, commands, notices, shell, preferences, settings, workflows, board, superagent, automations and specs. The OFF arm disables all sixteen in a fresh context on the same build.

Actual function-entry instrumentation covers `missionRootFor`, `selectedMissionRoot`, `missionIssueIds`, `missionSessions`, `missionProgress`, `missionRollup`, `missionDepartures`, `buildFlightDeckRows`, `indexMissionSessions`, `indexSessionOwnership`, `sessionsForIssueNav`, `archivedSessionsForIssue`, `sessionsForIssueWorktree` and `issueIdOwningSession`. Selection counters cover engine issue search, legacy root resolution and session lookup. The window begins at the trusted pointer event and ends after the affected paint and store settlement. Diagnostic legacy comparisons and target nomination run outside that window.

The all-ON candidate records zero entries for all three switch actions, with zero engine selection counters. OFF is a positive control: the session switch records 1,116 `missionIssueIds` entries and 1,198 `indexMissionSessions` entries; the 307-row mission switch calls `archivedSessionsForIssue` 307 times. Before POD-5396, session navigation still entered `missionIssueIds` four times and `indexMissionSessions` once through `Reactions.pruneWorkspaces` → `workspaceMembership`. Candidate `91bb0f3488` removes that path through the pool navigation provider.

Earlier operator-size browser diagnostics compare 1,008 sidebar rows / 35 sections, mission snapshots of 389 and 237 diagnostic rows / five sections, 4,867 issue-page positions and 4,308 session positions. Every result has differences=0 and pending=0. Raw elapsed labels advance between separate contexts; fixed-clock rendering gates supply deterministic output parity rather than treating elapsed time as a data mismatch.

Those same diagnostic counts and zero ON entry maps are confirmed again on landed account source `70f3c661f4`, at parent checkpoint `7cd4fe0015` using minified build `0b25846f8d`. This foreground count-only verification exited 0 and took no timing lease; artifact 26 retains its complete result.

The final exact-source `fba57c0c8f` 4× count-only probe exits 0 and marks verification complete. At both mission targets, it compares 4,029 sidebar rows / 35 sections, 397 and 345 mission rows / five sections, 19,468 issue-page positions and 17,214 session positions. Every diagnostic has differences=0 and pending=0, with zero accepted deadline or ownership changes in the synthetic corpus. All three actual ON switches also have zero legacy, mission and navigation entries. Artifact 29, `fba-4-controls/counts.json`, retains that complete count-only proof. No performance claim is taken from this unleased verification run.

## Private replay

Rows remain in ludovico memory. Only counts, positions, field names and opaque IDs leave that machine. These live checks run sequentially, so the operator corpus can grow between snapshots.

| Screen | Positions or rows | Unexpected differences | Pending | Explicitly accepted semantic differences |
| --- | ---: | ---: | ---: | ---: |
| Sidebar, current joined seed (`fba57c0c8f`) | 1,220 rows / 35 sections; 6,132 issues, 5,196 sessions | 0 | 0 | 0 |
| Mission view | 8,480 selections / 10,578 rows / 2,120 roots | 0 | 0 | 0 |
| Issue page | 6,132 positions | 0 | 0 | 0 deadline differences |
| Session pane | 5,192 positions | 0 | 0 | 1,614 ownership differences |
| Shell | 79,352 positions / seven contexts | 0 | 0 | 0 |

All five final rows run on exact `fba57c0c8f` on ludovico in a detached checkout with its own frozen dependency graph and unchanged tracked product source. The sidebar original-entry retry exits 0 at 19:36:39 UTC, with unchanged fixture SHA256 `5dda5ca72810e3fcc5038c8e7dd52ca332ecbcff40dca7d9de0763bb4fa0479f`. The first sidebar attempt exited 1 before producing comparison counts; that attempt is preserved separately, and only that missing case was retried. A diagnostic invocation of the same comparison logic also passed. The four already-passing screen replays were retained. Artifact 30, `fba-private-counts.json`, retains the aggregate; `fba-sidebar-counts.json` is included in the final archive. Both contain only permitted counts, positions and opaque IDs.

The earlier aligned sidebar replay at exact `c38a12b360`, 10:04:37 UTC, also exited 0: 6,087 issues / 5,186 sessions / 1,209 rows / 35 sections. Artifact 13 retains that frozen-base count-only result and identical fixture fingerprint. Earlier `c8bccb92cb` results are retained with the historical evidence.

Session ownership follows the previously accepted POD-5092 rule: explicit issue ownership first, then nearest worktree ownership, rather than legacy list order. The current 1,614 accepted differences (1,600 in the earlier replay) are reported separately; this is not a claim that every historical ownership value is identical. See [session pane evidence](pod-5092-session-pane-pool.md).

The unchanged older sidebar replay fails equally at morning `803ecfa597` and the then-current `c8bccb92cb` product: 1,116 differences across 1,207 rows, with identical first opaque positions and field counts. It does not seed current session homes/user states/machines or declare mission summaries. A measurement-only copy follows the current browser fixture, reads joined sessions through the pool row source, declares `MISSION_SUMMARIES`, and yields zero differences. Dropping the joined session list is a planted red control: 1,192 differences, exit 1, exact source restoration verified. No shared replay or product source has been changed by this issue.

## Account boundary

In the initial pre-fix probe, the requested principal is reached and the retired runtime has `destroyed=true`, but the initial runtime, replica, pool, tables, relations, worklist, groups, clock and residency all survive both account transitions. The second generation is collected. A synthetic heap path excluding weak and conditional WeakMap edges shows:

```text
Window.__PODIUM_CLOSE_TAB__
  → Workspace closure / closeFileTab
  → engine action callback onLayoutBaseInstalled
  → destroyed initial ClientRuntime
```

The same closure retains the old replica through outbox callbacks. POD-5402 landed the fix at `70f3c661f4`, with runtime code matching its committed proof `7b7e19e2d7`. It retains a provider principal boundary and native retiring blur, and drops synthetic focus events. State/blur-write preservation, actual stale-handler and stale-closure plants, 80 focused tests, types and lint are green in the owner's lane. Its leased paired remount-cost capture is complete. Artifact 25 preserves the owner's source/count proof bundle.

The parent probe at `7cd4fe0015` independently confirms OFF Bob/Alice 0 survivors before and after focus. In ON, React's selection cache retains the retired generation's nine objects before focus on each transition; afterward all nine are absent. The first generation remains absent when Alice returns, while the second generation is then collected. Each actual principal matches the requested account, and the successor field is a connected text INPUT. The result follows five GC/settled-render rounds on each side of that public focus interaction. This is a bounded release result, not unconditional zero immediately after account switch. The original strong Window path remains a separate, permanent defect in the frozen baseline.

The final `fba57c0c8f` 4× probe reproduces the same bound in both directions: OFF has zero before/after focus; ON has nine before real successor focus and zero afterward. Both actual principals match, every successor field is a connected text INPUT, and the first generation remains absent on the return transition. Artifact 29 retains these final no-focus and post-focus identities/counts alongside the synthetic parity proof.

The collector also releases its startup wait handle and clears Playwright 1.60's retained locator target set with an absent-locator count assertion before GC. Those harness references are separate from the original strong Workspace path. Artifact 26 records no-focus counts, the connected successor field that receives real focus, and post-focus counts in both arms. The saved heap/object IDs have been copied by POD-5402 and remain retained here.

## Evidence and controls

POD-5093 issue artifacts retain the aligned private counts, morning/current replay comparison, candidate browser manifest, and source-name-only account retaining path. Artifact 23, `frozen-switch-baselines.tgz`, contains all 240 synthetic CPU profiles, timelines and records, their manifests/analyses, compiled assets/maps and exact baseline collectors. Its 75,791,677 bytes have SHA256 `b587809fe389c42c250bcee21fc626ade9f10fec7d3d87c3bd45a58fcf9edd64`; artifact 24 records that provenance. Private rows and heap snapshots are excluded.

Artifact 31, `fba-switch-acceptance.tgz`, retains the final exact-source 240-record archive. Its 61,616,759 bytes have SHA256 `f9116976ea0523a45c73f39f9ad469328d0b0ff0e4ec12c04d91004b0c93c888`, verified on flatblock and ludovico; artifact 32 records that provenance. It contains both completed captures, their analyses/manifests, the matching production assets/maps, exact collector/analyzer, build hash manifest, recorded PID audit and final count-only browser/private proofs. Private operator rows and heap snapshots are excluded. Final analyses are attached as artifacts 27/28, the completed browser/account count proof as artifact 29 and the private replay aggregate as artifact 30. The original requested retired heap remains retained separately.

Eleven focused report guards accept clean input and reject planted startup, legacy-entry, selection, parity, pending, survivor, principal, CPU coverage, CPU partition, p50 and p95 faults. These run on flatblock with an exact cp-aside/restore check, without a timing lease. The guards are falsifiability evidence, not measured acceptance results.

The actual source-map attribution guard is also proven red on a saved Chromium profile: replacing the data classifier with `return false` exits 1 with `Known legacy data stack is unclassified`. Exact source restoration and the unchanged accepted analysis hash are recorded in issue artifact 20. The clean analyses independently classify positive legacy data time in the OFF arms (6,167.829 ms at 1× and 78,655.270 ms at 4×), so this guard is armed against accidentally dropping known data work.

## Rollout and deletion

The original one-week deletion child, POD-5408, has been superseded by POD-5437. On 2026-10-03 the operator authorized removing these workspace screens' legacy readers and switches immediately, without a soak interval or a default-on wait. POD-5437 records the last green control runs before removal and owns the pool-only change. This measurement issue has changed no defaults or application source.

The paired timing evidence remains tied to a revision containing POD-5406 and excluding POD-5437, as instructed by POD-4286 at 17:00 UTC. The report can then land fast-forward onto the current integration branch even if legacy removal has advanced that branch. Shared legacy helpers needed by unmigrated mobile screens remain until their own screen migration; the snapshot pipeline is retired by step 07.

## Validation boundary

The focused gate is `bun run test:file --` with these fourteen exact files on flatblock: sidebar-check, mission-view-check, issue-page-check, issue-page-replay, engine navigation-pool, web pool-navigation-provider and pool-navigation-render, FlightDeck.pool, IssuePage.pool-parity, session-pane.pool, chat-context.pool, shell-pool-screen, graph pool-host and pool-projection. It uses the repository admission/collection wrapper, foreground timeouts, checkout-local Bun 1.4.2 and no timing lease. The recovered run reports four node files and six web files green. The three unreported node files passed a sequential focused rerun (12 tests). The remaining web file initially reported 17 passing tests and one cold-navigation failure on the old fixture. POD-5401 fixes its missing `FakeHub.onConnectionHealth` subscription in `eb4a26a9d9`; the single aligned case passed on committed `a87d746cdd` (1 passed, 17 skipped, exit 0). POD-5410 is closed as its duplicate. All fourteen files now have passing evidence; this is focused evidence, not a full-suite result. No passed file is rerun merely for confidence.

This issue changes only this report in tracked source. It does not require an additional runtime typecheck or the ordinary lean gate; the focused corpus/rendering lane is the relevant acceptance evidence. The product-fix owners report their own focused regressions and lean gates green. New checker sources and synthetic results are retained as issue artifacts rather than committed application code.
