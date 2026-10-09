# Per opening view lifetimes

Issue detail, settings and automation surfaces now create their view models in the opening root and pass them through React context. Closing releases their query results, cached answers and companions. The pool continues to own shared record identity. This applies guide rule 9, with original measurements on `006a4ba7c9` and the full candidate reconciled onto landed shared-model pilot `84a31a9c67`, then rebased onto the reported green-rest pilot `24c2b0737f` (which includes `38cccb0b8f`). Receipts below remain bound to their named source; the newest validation is in the final section.

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
| Session panes | Landed `SessionPanes` and `PaneSession` remain with the always-on shell; their scalar read ports retain no extra view | No additional registry owner |

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

On flatblock with Bun 1.4.2, fifty openings leave **zero of 200 view models and zero of 100 companions reachable**, while the pool and all fifty shared issue identities remain alive. The companions include both detail and explorer rows, with a separate explorer owner kept behind the screen's deferred import. The fixture observes detail rosters, catalogs, explorer results, settings setup/session summaries, and automation lists/repository/target choices. Another check holds the disposed views as late handlers might and still collects both companions. The opening's explorer state matches the former board-owned companion on the same fixtures. All five graph proof cases pass on the rebased candidate.

The React proof opens/closes each of six factory families fifty times: issue detail, explorer companions, settings/setup, automations/dialog/specs, web settings machines and phone settings machines. Every committed opening disposes once, uses the same model throughout its context, and gets a distinct model on reopening. StrictMode effect replay does not dispose an active opening. All six families pass and return to **zero reachable models** after root close, with no transient registry calls. Collection runs in a separate task while assertion frames are suspended, avoiding conservative references from the test's own stack.

## Validation

Earlier focused checks are green for web issue detail, explorer navigation (27 unchanged checks), settings and its close guard, settings data, automation readers/dialog, phone settings, the artifact sheet, graph detail/settings, companion identity and the phone session service. The dialog test's only change is its import: its existing mocked-data assertions draw the body under the separately tested opening owner.

The pre-model phone issue-screen test had a baseline snapshot failure: both `006a4ba7c9` and that candidate produced `073d4688535d26313cb7577e5ad685873d9dfc3398d304975622cf24805e564d`, while its saved snapshot expects `1ea4c91fd64e26c206a0d905960c76e261c037a6babd9a6898488a3ce8563f3a`. Its picker case passes on both, with 80 row reads and 40 derivations at both 1× and 4×. The snapshot remains unchanged and the evidence was mailed to POD-4286.

The baseline structural census covers 55 readers, nine clicks/deltas and two scales: 1,711 counters, zero unexpected failures and five existing issue-owned failures. POD-5895 owns the final candidate census and landing after the coordinator moved heavy checks into its shared lane.

The coordinator-authorized ownership candidate `4cc8705f72` has a flatblock lean gate receipt: 154 checks in four of 1,882 files (boot 16, router setup 41, daemon connection 56, lane configuration 41). Its full typecheck reports 29 successful tasks; the separate requested run has 26 cache hits. These historical receipts do not gate the later explorer and query-adapter repairs. At core candidate `606979711a`, the light interaction check reports 2,209 fingerprints, 2,210 occurrences and zero ratchet errors. Shifted entries retain their classifications; newly exposed ownership paths still identify collection work as debt.

The normal web build at that candidate succeeds. Its eager graph is 2,150,680 raw bytes, 687,951 gzip and 592,466 Brotli; the unchanged pilot base is 2,149,989 raw bytes. The +691 raw bytes cross the old ceiling by 680. Following the pilot's documented temporary lift policy pending POD-5240, the raw ceiling becomes 2,155,000 with 4,320 bytes of headroom. Compressed ceilings remain unchanged.

The shared build on the subsequent explorer follow-up found an eager `issue-board-cards` dependency through `issue-page`. The repair removes that runtime import and creates the explorer companion owner inside the deferred screen, with no boundary exception. The corrected range is rebased onto pilot `52556201c0`: the unchanged explorer suite passes 27 checks, and the light scan reports 2,202 fingerprints, 2,203 occurrences and zero ratchet errors. Its single obsolete ownership-provenance entry is removed; every remaining classification is preserved. POD-5895 supplies the final candidate gate, census and landing receipt.

## Shared-model pilot reconciliation

The complete sixteen-commit range is rebased onto ludovico's `84a31a9c6777a72c0c33b995e32c20f2a64ba97e`. Web and phone settings own their machine readers per opening and resolve the landed `MachineModel`; web settings keeps its shallow lazy model list inside that opening. Automation lists, addressed automation reads, run histories and session reads preserve the landed shared models. Workflow subjects use the existing scalar presence question without creating a settings opening. The landed shell's `session-pane.ts` and `session-pane-view.ts` remain intact; the old stateless adapter removed by the shell landing is not restored.

The opening-owned summary result still passes through `pool.queries.project`, using direct tracked summary row reads, and the deferred explorer companion factory stays behind the explorer screen. Historical heavy receipts above apply only to their named source SHA; POD-5895 supplies heavy validation and landing for this reconciled candidate.

The reconciled models pilot restores the pilot's unchanged 2,150,000-byte raw ceiling. The historical temporary lift above belongs to the pre-model candidate and does not carry forward; the shared lane measures the final build against the landed budgets.

Focused validation on flatblock's checkout-local Bun 1.4.2 is bound to runtime candidate `b34072b1a5c7214347c4b3b7d68fb53700e82ad1`; graph proofs ran at `605d16fbb1a5cbbaa0061d3571718935cf6b9e25`, whose only later runtime-source change is the React test-frame fix. Across ten selected files there are 50 passing checks and one unchanged baseline failure:

| Focused file | Result |
| --- | --- |
| Graph `opening-views.test.ts` | 5 passed; both summary plants walk 50 rows during the measured update; 200 models and 100 companions collected |
| Graph `issue-page.test.ts` | 5 passed |
| Graph `settings-questions.test.ts` | 2 passed, 1 failed identically on exact pilot `84a31a9c67` and the candidate |
| Web `opening-views.test.tsx` | 6 passed; every family has zero reachable opening models after fifty closes |
| Web `automation-readers.test.tsx` | 6 passed |
| Web workflow `readers.test.tsx` | 6 passed |
| Web `SettingsView.close-guard.test.tsx` | 6 passed |
| Web `explorer-nav.test.ts` | 8 passed |
| Web `NewAutomationDialog.test.tsx` | 2 passed |
| Phone `SettingsScreen.pool.test.tsx` | 4 passed |

The baseline settings failure is the named automation-session assertion at `settings-questions.test.ts:46:83`: `LOADING` is returned where the fixture expects `{ sessionId: 'target' }`. The exact landed pilot reproduces it unchanged (2 pass / 1 fail); its assertions and the landed model reader are preserved. The evidence was mailed to POD-4286.

The React collection fixture initially retained one explorer object through live matcher arguments in an async close frame. Keeping those object assertions in a synchronous helper restores the zero-reachable result; all existing context, identity, StrictMode disposal and fifty-close assertions remain. Product cleanup is unchanged.

The final light interaction scan reports **2,071 fingerprints, 2,072 occurrences, 1,911 carried REQUIRED REPAIR entries and zero ratchet errors**. Reconciliation preserves 2,001 exact pilot entries, transfers 66 prior candidate entries, and maps four shifted predecessors without changing any classification. Logs and exact SHA-bound receipts are at `flatblock:/tmp/p5866-model-reconciliation/`. Every completed run has zero live recorded worker PIDs; focused workers peaked at 419,600 KiB, and the source-only light scan at 1,314,084 KiB. A brief initial focused-run overlap with POD-5895's census window was reported to that lane; subsequent runs waited for a confirmed free window. No heavy validation or landing was performed here. Final changes after these receipts are this report and restoration of the landed bundle ceiling only.


## Coordinator typing repair

POD-4286 returned `659801c8f4` for the web program's missing `bun:jsc` declaration. All twenty-one patches replayed unchanged onto ludovico's requested `38cccb0b8f`; while the repair was running, POD-5895 reported the separately owned POD-5929 test-only landing at `24c2b0737f119ceb1324d87bda2678290ddb536a`. The complete replacement is rebased onto that actual ludovico ref, with every prior patch preserved. POD-5929 owns the settings fixture repair; this range does not modify it.

The web package now declares only `releaseWeakRefs()` and `gcAndSweep()` locally, following `packages/runtime/src/bun-jsc.d.ts`. It does not add Bun's global type package. The requested web-only typecheck also exposed declaration errors from the settings opening's inferred return type; exporting the existing `SettingsMachines` class by name resolves those errors while retaining its private pool and lazy shared-model list. Opening ownership, the deferred explorer boundary, landed shell readers, bundle ceilings and the summary's `pool.queries.project` boundary remain intact.

Fresh collection runs exposed test-held object roots despite synchronous matcher helpers. Rendering callbacks now stay synchronous, and each live-object comparison runs in its own timer task before closing. Awaited React flushing, all context/identity/disposal checks, fifty openings per family and the final zero-reachable assertion remain. Weak-only creation indexes make any future retention visible. StrictMode creates 100 models per family; all 100 are unreachable after fifty closes in each of the six families, with the shared pool alive.

All final checks below ran sequentially in the foreground on flatblock with checkout-local Bun 1.4.2, on exact source `4cb22b3080b9fc5e760f51e6791764581578c457`:

| Check | Result | Receipt label |
| --- | --- | --- |
| `bun run typecheck -- --filter=@podium/web --only` | 1 successful task of 1; 0 cached; no missing declarations or settings export errors | `named-settings-web-typecheck` |
| `bun run test:file -- apps/web/src/app/opening-views.test.tsx` | 6 passed; every family has zero reachable models after fifty openings | `final-pilot-react` |
| `bun scripts/check-interaction-scans.ts` | 2,071 fingerprints; 2,072 occurrences; 1,911 carried REQUIRED REPAIR entries; 0 ratchet errors | `final-pilot-light-scan` |

Logs, PID identities and SHA-bound receipts remain at `flatblock:/tmp/p5866-model-reconciliation/`. The final compiler peaked at 3,049,224 KiB, the focused test at 351,156 KiB and the source-only scan at 1,332,140 KiB. The three receipts record 8, 7 and 1 process identities respectively, with zero live recorded PIDs; all preceding repair runs also exited with no live recorded PIDs. No PIDs were killed, no locks acquired, and no full typecheck, lean gate, build or structural census ran in this repair lane. Validation waited for POD-5895's census lease to be free. The only change after these final receipts is this evidence report; POD-5895 supplies heavy validation and landing for the replacement candidate.
