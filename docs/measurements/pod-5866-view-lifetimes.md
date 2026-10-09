# Per opening view lifetimes

Issue detail, settings and automation surfaces now create their view models in the opening root and pass them through React context. Closing releases their query results, cached answers and companions. The pool continues to own shared record identity. This applies guide rule 9 on pilot base `006a4ba7c9`.

## Opening ownership

| Surface | Owner | Registry entry removed |
| --- | --- | --- |
| Web issue page and dock detail | `PoolIssuePage`, `PoolIssuePanelView`, `IssueViewsContext` | `issue-page` |
| Dock explorer and its row companions | `IssueExplorer` provides `ExplorerViewsContext`; its detail frames share the dock opening, and a standalone fallback list owns its own | Explorer companions no longer borrowed from `issueBoardCards` |
| Issue choice menus | The visible choice root; nested controls share the detail context | `issue-page` |
| Phone issue page and inspection sheet | `IssueOpening`; the mounted sheet creates a model only while open | `issue-page` |
| Web settings and setup summary | `SettingsOpening`; the first-task root owns its setup summary | `settings.views`, `web.settings.machines` |
| Phone settings | `SettingsOpening` and its machine readers | `settings.views`, `phone.settings.machines` |
| Automations, new/edit dialog and specs repository choices | Each root has its own `AutomationOpening` | `automations` |
| Session read ports | Stateless record/window reads, with no retained view object | `sessionPanes` |

Detail catalogs and explorer results also belong to their opening. Concurrent openings no longer share a query callback that can retain the first opening. Scalar identity and close-concern controls use shared record readers without creating a detail model. The phone session service keeps its addressed roster in the data layer's existing query-result registry; its last observer releases it, and changing one member reads only that member.

The worklist, board, header, shell chrome and shared phone inbox readers remain always on. Preference, reference lookup, issue activity, navigation activity and session-seat services retain their existing principal lifetime. Mission and launcher ownership remains with POD-5827 and POD-5833. Shipping and proposal screening already create their models in their roots.

## State preserved across reopening

| State | Existing owner retained |
| --- | --- |
| Settings tab | Runtime route/navigation state, exposed by `settingsWindow` |
| Explorer trail, tab, search and scroll position | `IssueExplorerProvider` above the dock |
| Detail folds and display choices | Existing preference/UI-state owners; phone `useCollapsed` keeps its saved fold key |
| First-task text, target, attachment and launch-failure draft | Existing persisted first-task draft and UI-state/preference bridge |
| Settings preferences and saved form drafts | Existing runtime preferences and `useSettingsDraft` storage |
| Phone server/profile choices | Existing server-profile owner |

No new UiStore is introduced. The deliberately saved values remain where they were until POD-5797. Unsaved automation form input and request answers keep their opening lifetime.

## Collection proof

The frozen pre-change registry paths and opening-owned factories return the same answers on the same fifty-issue fixture. Before removing registry ownership, the comparison passed and `PODIUM_OPENING_WRONG=1` made the new title wrong and failed the comparison.

Opening-owned catalog results still pass through the existing `project` read boundary. The unchanged summary negative control rejects a planted full rebuild with identical output and a planted wrong title: rows 1→1, derivations 1→1 and elements 117→117 for normal work at 1×/4×. Two additional checks explicitly show both plants walking 50 rows **during** the measured description update. Direct owned-result reads had bypassed that control; the shared census caught the blind spot and the query adapter repair restores it without changing the retained assertions.

The graph collection fixture covers fifty openings of **200 view models and 100 companions**, while the pool and all fifty shared issue identities remain alive. The companions include both detail and explorer rows, with a separate explorer owner kept behind the screen's deferred import. The fixture observes detail rosters, catalogs, explorer results, settings setup/session summaries, and automation lists/repository/target choices. Another check holds the disposed views as late handlers might and still collects both companions. The opening's explorer state matches the former board-owned companion on the same fixtures. The revised separate-owner proof awaits its focused run after the shared measurement lock releases; the preceding combined-owner version collected every model and companion.

The React proof opens/closes each of six factory families fifty times: issue detail, explorer companions, settings/setup, automations/dialog/specs, web settings machines and phone settings machines. Every committed opening disposes once, uses the same model throughout its context, and gets a distinct model on reopening. StrictMode effect replay does not dispose an active opening. The original five families returned to **zero reachable models** after root close, with no transient registry calls; the added explorer family awaits the revised focused run.

## Validation

Existing focused checks are green for web issue detail, explorer navigation (27 unchanged checks), settings and its close guard, settings data, automation readers/dialog, phone settings, the artifact sheet, graph detail/settings, companion identity and the phone session service. The dialog test's only change is its import: its existing mocked-data assertions draw the body under the separately tested opening owner.

The unchanged phone issue-screen test has a baseline snapshot failure: both `006a4ba7c9` and this candidate produce `073d4688535d26313cb7577e5ad685873d9dfc3398d304975622cf24805e564d`, while its saved snapshot expects `1ea4c91fd64e26c206a0d905960c76e261c037a6babd9a6898488a3ce8563f3a`. Its picker case passes on both, with 80 row reads and 40 derivations at both 1× and 4×. The snapshot remains unchanged and the evidence was mailed to POD-4286.

The baseline structural census covers 55 readers, nine clicks/deltas and two scales: 1,711 counters, zero unexpected failures and five existing issue-owned failures. POD-5895 owns the final candidate census and landing after the coordinator moved heavy checks into its shared lane.

At core candidate `606979711a`, the flatblock lean gate is green: 154 checks in four of 1,882 files (boot 16, router setup 41, daemon connection 56, lane configuration 41). Full typecheck reports 29 successful tasks; the separate requested run has 26 cache hits. The light interaction check reports 2,209 fingerprints, 2,210 occurrences and zero ratchet errors. Shifted entries retain their classifications; newly exposed ownership paths still identify collection work as debt.

The normal web build at that candidate succeeds. Its eager graph is 2,150,680 raw bytes, 687,951 gzip and 592,466 Brotli; the unchanged pilot base is 2,149,989 raw bytes. The +691 raw bytes cross the old ceiling by 680. Following the pilot's documented temporary lift policy pending POD-5240, the raw ceiling becomes 2,155,000 with 4,320 bytes of headroom. Compressed ceilings remain unchanged.

The shared build on the subsequent explorer follow-up found an eager `issue-board-cards` dependency through `issue-page`. The repair removes that runtime import and creates the explorer companion owner inside the deferred screen, with no boundary exception. POD-5895 supplies the final candidate gate, census and landing receipt after the corrected full range is rebased onto its green-rest pilot landing.
