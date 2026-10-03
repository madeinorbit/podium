# POD-5077 switch acceptance

POD-5093, 2026-10-03. **Acceptance remains open.** The pruning candidate has zero legacy entries and zero unexpected diagnostic differences, but the initial account remains reachable through the workspace Close Tab hook. The frozen integration product is `c38a12b360`, containing POD-5395 and POD-5396. Flatblock access stopped during the focused gate when ludovico Tailscale entered `NeedsLogin`; the gate result is not yet retrievable and no accepted timing capture has run. No default has been changed.

## Evidence status

| Requirement | Evidence | Result |
| --- | --- | --- |
| Store and derive p50 <200 ms, p95 <500 ms | Frozen product `c38a12b360`; new flatblock connections blocked by Tailscale login | Pending |
| IndexedDB, layout and total reported separately | Exclusive source-mapped CPU partition and Chromium timeline collector prepared | Pending |
| Zero legacy mission, selection and ownership work | Chromium 153, all sixteen switches ON, candidate `91bb0f3488`, mission / small / session switches | Zero entries |
| Synthetic corpus parity | Sidebar, mission, issue-page and session diagnostics on the same browser candidate | Zero differences / pending |
| Private operator replay | Five read-only ludovico checks; current sidebar seed alignment | Zero unexpected differences / pending |
| Account switch leaves no survivors | Alice → Bob → Alice, actual principals checked, five forced GC and settled-render rounds per transition | Fails: POD-5402 |
| Focused corpus and rendering gates | Fourteen exact files started on committed `b2846d011e`; transport lost before result retrieval | Pending |

## Correctness and legacy work

The verification uses the shipped sidebar, FlightDeck, Workspace, RightDock and chat panel in a minified production build, with real IndexedDB and the existing actions/outbox. The API answers are synthetic; external requests are blocked. It does not contact or restart the operator's server or daemon.

The historical operator-size synthetic corpus has 4,867 issues and 4,302 runtime sessions (seed 4443). The mounted mission targets `i1766` and `i938` contain 307 and 187 full deck rows; small targets have one row. Startup URL overrides enable all sixteen landed switches: sidebar, pane, session pane, chat context, header, chips, commands, notices, shell, preferences, settings, workflows, board, superagent, automations and specs. The OFF arm disables all sixteen in a fresh context on the same build.

Actual function-entry instrumentation covers `missionRootFor`, `selectedMissionRoot`, `missionIssueIds`, `missionSessions`, `missionProgress`, `missionRollup`, `missionDepartures`, `buildFlightDeckRows`, `indexMissionSessions`, `indexSessionOwnership`, `sessionsForIssueNav`, `archivedSessionsForIssue`, `sessionsForIssueWorktree` and `issueIdOwningSession`. Selection counters cover engine issue search, legacy root resolution and session lookup. The window begins at the trusted pointer event and ends after the affected paint and store settlement. Diagnostic legacy comparisons and target nomination run outside that window.

The all-ON candidate records zero entries for all three switch actions, with zero engine selection counters. OFF is a positive control: the session switch records 1,116 `missionIssueIds` entries and 1,198 `indexMissionSessions` entries; the 307-row mission switch calls `archivedSessionsForIssue` 307 times. Before POD-5396, session navigation still entered `missionIssueIds` four times and `indexMissionSessions` once through `Reactions.pruneWorkspaces` → `workspaceMembership`. Candidate `91bb0f3488` removes that path through the pool navigation provider.

Browser diagnostics compare 1,008 sidebar rows / 35 sections, mission snapshots of 389 and 237 diagnostic rows / five sections, 4,867 issue-page positions and 4,308 session positions. Every result has differences=0 and pending=0. Raw elapsed labels advance between separate contexts; fixed-clock rendering gates supply deterministic output parity rather than treating elapsed time as a data mismatch.

## Private replay

Rows remain in ludovico memory. Only counts, positions, field names and opaque IDs leave that machine. These live checks run sequentially, so the operator corpus can grow between snapshots.

| Screen | Positions or rows | Unexpected differences | Pending | Explicitly accepted semantic differences |
| --- | ---: | ---: | ---: | ---: |
| Sidebar, current joined seed | 1,207 rows / 35 sections; 6,078 issues, 5,184 sessions | 0 | 0 | 0 |
| Mission view | 8,432 selections / 10,495 rows / 2,108 roots | 0 | 0 | 0 |
| Issue page | 6,074 positions | 0 | 0 | 0 deadline differences |
| Session pane | 5,180 positions | 0 | 0 | 1,600 ownership differences |
| Shell | 78,869 positions / seven contexts | 0 | 0 | 0 |

Session ownership follows the previously accepted POD-5092 rule: explicit issue ownership first, then nearest worktree ownership, rather than legacy list order. The 1,600 accepted differences are reported separately; this is not a claim that every historical ownership value is identical. See [session pane evidence](pod-5092-session-pane-pool.md).

The unchanged older sidebar replay fails equally at morning `803ecfa597` and the current `c8bccb92cb` product: 1,116 differences across 1,207 rows, with identical first opaque positions and field counts. It does not seed current session homes/user states/machines or declare mission summaries. A measurement-only copy follows the current browser fixture, reads joined sessions through the pool row source, declares `MISSION_SUMMARIES`, and yields zero differences. Dropping the joined session list is a planted red control: 1,192 differences, exit 1, exact source restoration verified. No shared replay or product source has been changed by this issue.

## Account boundary

The requested principal is reached and the retired runtime has `destroyed=true`. Nevertheless the initial runtime, replica, pool, tables, relations, worklist, groups, clock and residency all survive both account transitions. The second generation is collected. A synthetic heap path excluding weak and conditional WeakMap edges shows:

```text
Window.__PODIUM_CLOSE_TAB__
  → Workspace closure / closeFileTab
  → engine action callback onLayoutBaseInstalled
  → destroyed initial ClientRuntime
```

The same closure retains the old replica through outbox callbacks. `Workspace.tsx` already registers the handler every render; the action/selector identity across runtime replacement must be fixed. POD-5402 is a blocking child; this measurement issue has not modified Workspace.

## Evidence and controls

POD-5093 issue artifacts retain the aligned private counts, morning/current replay comparison, candidate browser manifest, and source-name-only account retaining path. Full synthetic traces, maps and collector sources will accompany the final report; private rows and heap snapshots are not publication evidence.

Eleven focused report guards accept clean input and reject planted startup, legacy-entry, selection, parity, pending, survivor, principal, CPU coverage, CPU partition, p50 and p95 faults. These run on flatblock with an exact cp-aside/restore check, without a timing lease. The guards are falsifiability evidence, not measured acceptance results.

## Rollout and deletion

The operator decides when these screens become ON by default after the remaining acceptance evidence is green. Their escape switches remain for about one week after that activation. POD-5408, the final deletion child under POD-5077, will remove the legacy read path for these screens and their switches after that interval. Shared legacy helpers needed by unmigrated mobile screens remain until their own screen migration; the snapshot pipeline is retired by step 07.

## Validation boundary

The focused gate is `bun run test:file --` with these fourteen exact files on flatblock: sidebar-check, mission-view-check, issue-page-check, issue-page-replay, engine navigation-pool, web pool-navigation-provider and pool-navigation-render, FlightDeck.pool, IssuePage.pool-parity, session-pane.pool, chat-context.pool, shell-pool-screen, graph pool-host and pool-projection. It runs through the repository admission/collection wrapper with a foreground 900-second timeout, checkout-local Bun 1.4.2 and no timing lease. At transport loss the worker was actively executing; no result is inferred from that observation. Retrieve its existing log before deciding whether any rerun is needed.

This issue changes only this report in tracked source. It does not require an additional runtime typecheck or the ordinary lean gate; the focused corpus/rendering lane is the relevant acceptance evidence. The product-fix owners report their own focused regressions and lean gates green. New checker sources and synthetic results are retained as issue artifacts rather than committed application code.
