# POD-5077 switch acceptance

POD-5093, 2026-10-03. **Acceptance remains open: both timing baselines are RED.** At operator size, ON mission and session switching miss the 200 ms store/derive p50 target; all three actions miss the budget at 4×. All 120 ON gestures across both sizes have zero legacy entries. POD-5406 owns the command-launch projection cost. Frozen product `c38a12b360` contains POD-5395 and POD-5396; test-only `eb4a26a9d9` leaves it byte-identical. POD-5402 landed at `70f3c661f4`; the aligned parent probe confirms zero account survivors after real successor focus, with nine retained beforehand in ON. No default has been changed.

## Evidence status

| Requirement | Evidence | Result |
| --- | --- | --- |
| Store and derive p50 <200 ms, p95 <500 ms | Frozen product, 120 retained profiles at each of 1× and 4× | Fails: POD-5406 |
| IndexedDB, layout and total reported separately | Exclusive CPU partition, request wait union and Chromium layout/paint union below | Recorded at both sizes |
| Zero legacy mission, selection and ownership work | Chromium 153, all sixteen switches ON, candidate `91bb0f3488`, frozen-product preflight and 120 retained ON gestures | Zero entries |
| Synthetic corpus parity | 1× browser diagnostics and focused corpus/rendering files green; 4× untimed browser checks interrupted | Zero differences / pending on completed checks; 4× browser result unavailable |
| Private operator replay | Five read-only ludovico checks; aligned sidebar repeated at frozen `c38a12b360` | Zero unexpected differences / pending |
| Account switch leaves no survivors | Landed `70f3c661f4`, aligned parent Chromium probe; Alice → Bob → Alice, actual principals checked | Bounded release: OFF 0/0; ON 9 before real successor focus, 0 afterward |
| Focused corpus and rendering gates | Saved results, three missing node files and the aligned navigation case: all fourteen files have passing evidence | Green |

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

Browser diagnostics compare 1,008 sidebar rows / 35 sections, mission snapshots of 389 and 237 diagnostic rows / five sections, 4,867 issue-page positions and 4,308 session positions. Every result has differences=0 and pending=0. Raw elapsed labels advance between separate contexts; fixed-clock rendering gates supply deterministic output parity rather than treating elapsed time as a data mismatch.

Those same diagnostic counts and zero ON entry maps are confirmed again on landed account source `70f3c661f4`, at parent checkpoint `7cd4fe0015` using minified build `0b25846f8d`. This foreground count-only verification exited 0 and took no timing lease; artifact 26 retains its complete result.

## Private replay

Rows remain in ludovico memory. Only counts, positions, field names and opaque IDs leave that machine. These live checks run sequentially, so the operator corpus can grow between snapshots.

| Screen | Positions or rows | Unexpected differences | Pending | Explicitly accepted semantic differences |
| --- | ---: | ---: | ---: | ---: |
| Sidebar, current joined seed (`c38a12b360`) | 1,209 rows / 35 sections; 6,087 issues, 5,186 sessions | 0 | 0 | 0 |
| Mission view | 8,432 selections / 10,495 rows / 2,108 roots | 0 | 0 | 0 |
| Issue page | 6,074 positions | 0 | 0 | 0 deadline differences |
| Session pane | 5,180 positions | 0 | 0 | 1,600 ownership differences |
| Shell | 78,869 positions / seven contexts | 0 | 0 | 0 |

The aligned sidebar row is a fresh replay at exact `c38a12b360` on 2026-10-03 at 10:04:37 UTC. It ran on ludovico in a detached checkout with its own frozen dependency graph and unchanged tracked product source, and exited 0. Issue artifact 13, `aligned-replay-frozen-counts.json`, retains its count-only result and fixture fingerprint. The other private rows retain the earlier `c8bccb92cb` product results.

Session ownership follows the previously accepted POD-5092 rule: explicit issue ownership first, then nearest worktree ownership, rather than legacy list order. The 1,600 accepted differences are reported separately; this is not a claim that every historical ownership value is identical. See [session pane evidence](pod-5092-session-pane-pool.md).

The unchanged older sidebar replay fails equally at morning `803ecfa597` and the then-current `c8bccb92cb` product: 1,116 differences across 1,207 rows, with identical first opaque positions and field counts. It does not seed current session homes/user states/machines or declare mission summaries. A measurement-only copy follows the current browser fixture, reads joined sessions through the pool row source, declares `MISSION_SUMMARIES`, and yields zero differences. Dropping the joined session list is a planted red control: 1,192 differences, exit 1, exact source restoration verified. No shared replay or product source has been changed by this issue.

## Account boundary

The requested principal is reached and the retired runtime has `destroyed=true`. Nevertheless the initial runtime, replica, pool, tables, relations, worklist, groups, clock and residency all survive both account transitions. The second generation is collected. A synthetic heap path excluding weak and conditional WeakMap edges shows:

```text
Window.__PODIUM_CLOSE_TAB__
  → Workspace closure / closeFileTab
  → engine action callback onLayoutBaseInstalled
  → destroyed initial ClientRuntime
```

The same closure retains the old replica through outbox callbacks. POD-5402 landed the fix at `70f3c661f4`, with runtime code matching its committed proof `7b7e19e2d7`. It retains a provider principal boundary and native retiring blur, and drops synthetic focus events. State/blur-write preservation, actual stale-handler and stale-closure plants, 80 focused tests, types and lint are green in the owner's lane. Its leased paired remount-cost capture is complete. Artifact 25 preserves the owner's source/count proof bundle.

The parent probe at `7cd4fe0015` independently confirms OFF Bob/Alice 0 survivors before and after focus. In ON, React's selection cache retains the retired generation's nine objects before focus on each transition; afterward all nine are absent. The first generation remains absent when Alice returns, while the second generation is then collected. Each actual principal matches the requested account, and the successor field is a connected text INPUT. The result follows five GC/settled-render rounds on each side of that public focus interaction. This is a bounded release result, not unconditional zero immediately after account switch. The original strong Window path remains a separate, permanent defect in the frozen baseline.

The collector also releases its startup wait handle and clears Playwright 1.60's retained locator target set with an absent-locator count assertion before GC. Those harness references are separate from the original strong Workspace path. Artifact 26 records no-focus counts, the connected successor field that receives real focus, and post-focus counts in both arms. The saved heap/object IDs have been copied by POD-5402 and remain retained here.

## Evidence and controls

POD-5093 issue artifacts retain the aligned private counts, morning/current replay comparison, candidate browser manifest, and source-name-only account retaining path. Artifact 23, `frozen-switch-baselines.tgz`, contains all 240 synthetic CPU profiles, timelines and records, their manifests/analyses, compiled assets/maps and exact baseline collectors. Its 75,791,677 bytes have SHA256 `b587809fe389c42c250bcee21fc626ade9f10fec7d3d87c3bd45a58fcf9edd64`; artifact 24 records that provenance. Private rows and heap snapshots are excluded.

Eleven focused report guards accept clean input and reject planted startup, legacy-entry, selection, parity, pending, survivor, principal, CPU coverage, CPU partition, p50 and p95 faults. These run on flatblock with an exact cp-aside/restore check, without a timing lease. The guards are falsifiability evidence, not measured acceptance results.

The actual source-map attribution guard is also proven red on a saved Chromium profile: replacing the data classifier with `return false` exits 1 with `Known legacy data stack is unclassified`. Exact source restoration and the unchanged accepted analysis hash are recorded in issue artifact 20. The clean analyses independently classify positive legacy data time in the OFF arms (6,167.829 ms at 1× and 78,655.270 ms at 4×), so this guard is armed against accidentally dropping known data work.

## Rollout and deletion

The operator decides when these screens become ON by default after the remaining acceptance evidence is green. Their escape switches remain for about one week after that activation. POD-5408, the final deletion child under POD-5077, will remove the legacy read path for these screens and their switches after that interval. Shared legacy helpers needed by unmigrated mobile screens remain until their own screen migration; the snapshot pipeline is retired by step 07.

## Validation boundary

The focused gate is `bun run test:file --` with these fourteen exact files on flatblock: sidebar-check, mission-view-check, issue-page-check, issue-page-replay, engine navigation-pool, web pool-navigation-provider and pool-navigation-render, FlightDeck.pool, IssuePage.pool-parity, session-pane.pool, chat-context.pool, shell-pool-screen, graph pool-host and pool-projection. It uses the repository admission/collection wrapper, foreground timeouts, checkout-local Bun 1.4.2 and no timing lease. The recovered run reports four node files and six web files green. The three unreported node files passed a sequential focused rerun (12 tests). The remaining web file initially reported 17 passing tests and one cold-navigation failure on the old fixture. POD-5401 fixes its missing `FakeHub.onConnectionHealth` subscription in `eb4a26a9d9`; the single aligned case passed on committed `a87d746cdd` (1 passed, 17 skipped, exit 0). POD-5410 is closed as its duplicate. All fourteen files now have passing evidence; this is focused evidence, not a full-suite result. No passed file is rerun merely for confidence.

This issue changes only this report in tracked source. It does not require an additional runtime typecheck or the ordinary lean gate; the focused corpus/rendering lane is the relevant acceptance evidence. The product-fix owners report their own focused regressions and lean gates green. New checker sources and synthetic results are retained as issue artifacts rather than committed application code.
