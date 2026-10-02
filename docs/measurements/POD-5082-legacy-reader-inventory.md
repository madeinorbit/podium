# POD-5082 legacy surface reader inventory

Baseline: `integrate/4286-pilot e3108bf53f`, captured on 2026-10-02 in the owning issue worktree. WIP checkpoints add no product changes. Scope: inventory documentation and issue decomposition only, as allocated by POD-4286's 2026-10-02 start note. No app, pool, runtime, replica or outbox files change in this deliverable.

## Result and interpretation

The inventory is **not empty**. The exact requested grep matches **1338 lines in 517 files** across web and mobile. Adding exact hook boundaries, store handles and snapshot reads matches **1490 lines in 531 files**. Those totals include tests, harnesses, comments, type imports and independent controller stores; they are not a count of live data readers.

Tracing production call sites identifies **176 modules calling reader/accessor hooks** (133 web, 43 mobile; 406 call sites before facade aliases), plus the indirect web conversation adapter in `features/chat/use-chat-send.ts`. The **177 modules** in the tables below include reader facades, stable action/API accessors and rollback branches, with their actual inputs identified. **213 production modules import viewmodel APIs** (156 web, 57 mobile); their complete file:line and symbol inventory is in the appendix. A module can appear in both sets.

The important remaining categories are always-mounted shell/preferences/root banners; retained command-palette state; Superagent threads; message/interaction/dead-letter and conversation ports; launch choices; settings/diagnostics; automation/run entities; and mobile session/inbox/reference readers. Workspace/mission/page/pane, board/explorer and mobile issue/mission readers are also listed, but remain with their existing lanes. None of these findings establishes a new performance bottleneck.

**Trivial removals:** selectors that pick only `trpc`, `httpOrigin`, `hub`, or stable action/request methods. Their existing RPC data, stream controllers and mutation owner can stay; they need access without the old snapshot subscription. Examples are usage/message ledgers, most web settings sections, Git request methods and most file viewers. UI preferences, settings tabs, entities, contextual action inputs and diagnostics are real reads and do not qualify as trivial merely because their handle is stable.

## Reproduction and completeness

Run the requested inventory from the repository root:

```sh
git grep -n -E 'useStoreSelector|useSlice|useStore|useReplica[A-Za-z]*|viewmodel' -- apps/web apps/mobile
```

Supplement it with handles, imperative snapshots and indirect facade/port readers:

```sh
git grep -n -E '\buseStoreSelector\b|\buseSlice\b|\buseStore\b|\buseStoreHandle\b|\buseReplica[A-Za-z]*\b|viewmodels|\bgetSnapshot\b' -- apps/web apps/mobile
git grep -n -E '\buse(Session|SessionDraft|SessionExitKind|Issues|Issue|Sessions|Machines|Repos|CoarseNow|SuperThreadId|OutboxSize|UiState|SpawnPending|SpawnPrompt|MobileStore|MobileStoreSelector|ModelCatalog|ModelCatalogState|HarnessDescriptors|PresenceRoom|RepoLocks|LockState|StoreActions|Trpc|HttpOrigin|Hub|Connected|Booting)\b|storeConversationRecords|storeConversationOutbox|useAllIssueViewModels|useIssueViewModel|replica\.getCursor' -- apps/web/src apps/mobile/src apps/mobile/app
```

The production tables exclude `*.test.*`, `*.spec.*`, frontend-perf/probe files, `src/perf`, test-support, demo-data prose and `apps/web/harness`/`apps/web/test`. The final appendix preserves **every file and matching line number** in the union of the two raw scans, so exclusions cannot silently erase a reader. Facade imports were followed to `apps/web/src/app/store.tsx`, `apps/mobile/src/client/hooks.ts`, shared catalog/descriptor/lock/presence hooks, and `packages/client-core/src/conversation/store-ports.ts`.

Mount labels describe source composition, not a browser measurement: always mounted means the authenticated shell/root renders the reader even when its visible output is empty; on demand means its parent route, panel or dialog owns the mount. Expo tabs may retain a screen after first visit. Web Settings and Usage preserve the underlying workspace, and CommandPalette is retained after its first open (`CommandPaletteBoundary.tsx:18–35`). Hook libraries inherit their consumer's lifetime.

## Existing pool coverage

| Coverage | Declared source / current read path | Remaining legacy dependency |
| --- | --- | --- |
| Core pool | `client-graph/src/shared/schema.ts:731,945,1070,1131`: issue, session, worktree, repo and their declared relations/summaries; selection/coarse clock locals in `shared/slice-types.ts:135` | Row availability does not establish parity for every mission/page/board/mobile screen; those surfaces still select legacy arrays/facades. |
| Sidebar | `features/worklist/use-pool-unified-work.ts`, pool-sidebar and pool-sidebar-rail; startup choice in `lib/sidebar-data-layer.ts` | Pool sidebar still selects `pins/sidebarSettings`, selection/paneA and shared preferences from snapshots. Gesture code reads `paneA/fileTabs`; other snapshot calls acquire stable actions. Legacy `worklistSlice` branch also remains. |
| Header/status | `client-graph/src/header-schema.ts:27–46`, `header-views.ts`, `app/header-data.ts`, `lib/header-data-layer.ts` | Machine/repository/metric/quota/shipOrder/history/lifecycle/connection/window rows are available. Window declares `view`, `paneA`, `fileTabs`, `outboxSize`, not arbitrary UI state. Legacy fallback branches remain; other shell/settings/host utility readers do not automatically switch. |
| Web reference chips | `client-graph/src/issue-reference.ts:169`, web IssueReference/IssueChipLiveness/RefMiniview, `lib/chips-data-layer.ts` | Addressed pool lookup exists; web rollback paths remain under POD-5121. RefMiniview has additional session/machine/repo selectors. Mobile RefChip still calls `useIssues()` for every issue. |
| Missing screen entities/locals | No declarations in the current core/header schemas for superThread, automation/automationRun, messageRecord, pendingInteraction, conversation summaries, approval/prompt, dead-letter views, drafts/spawn locals, settingsTab/palette/superOpen, generic persisted UI state, workspace/ship-lane state or RPC workflow read models | Declare each screen's required projection and relations, including summaries for cold rows, before switching that reader. Do not add peek callers or a second runtime. |

Startup choices are currently latched once. Header defaults to legacy unless `mobxHeader=1`; sidebar/chips use their existing default-off setting with startup URL overrides. A grep match in a fallback is still required retirement work even when its enabled pool path is already covered. A pool projection's own `getSnapshot` is not the legacy runtime snapshot.

Two corrections to the initial known list: `viewmodels/slices/superagent.ts:76` is still a legacy published slice, but its `sourceEqual` guard already compares `superThreads/superThreadId` at lines 79–80; it does **not** derive on every unrelated publish at this baseline. `slices/workflows.ts:1–21` is pure RPC-fed derivation code, not a `workflowsSlice` subscriber; its actual legacy readers are the machine and issue/session context hooks. `slices/terminal.ts` is also pure policy over session arrays; the source readers are its pane/workspace consumers. Pure policy/formatting helpers still need a maintained home when the old viewmodel module is removed.

## Production reader and access inventory

Each row identifies every observed call site in that module. `Inputs` lists literal selector fields and the expanded inputs of facade/adapter calls. Stable actions are retained as the single mutation owner; they must stop requiring a snapshot subscription. A read-only handle can still hide a legacy data read: the conversation ports and imperative snapshot sites are explicitly expanded below.
### Shared provider and read facades (4 modules)

Mount: Always mounted provider; hooks run with each consumer. Pool coverage: Existing owner and normalized replica sources; reader facades remain legacy. Ownership: POD-5161; mobile attachment coordinated with POD-4972/POD-5113.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/mobile/src/client/MobileClientProvider.tsx` | `useStoreSelector`:704 | `hub` | Always mounted provider; hooks run with each consumer |
| `apps/mobile/src/client/hooks.ts` | `useStoreSelector`:54; `useStore`:63; `useStoreSelector`:112; `useStoreSelector`:117; `useStoreSelector`:122; `useStoreSelector`:127; `useStoreSelector`:132; `useStoreSelector`:143; `useStoreSelector`:148; `useStoreSelector`:153; `useStoreSelector`:157; `useStoreSelector`:163; `useStoreSelector`:167; `useMobileStoreSelector`:172; `useIssueSources`:183; `useIssueSources`:197; `useStoreSelector`:203; `useStoreSelector`:209; `useStoreSelector`:225; `useStoreSelector`:234; `useStoreSelector`:242; `useHub`:266; `useStoreSelector`:286 | `coarseNow, drafts, httpOrigin, hub, issueProjections, issueUserStates, machines, outboxSize, pendingSpawnIds, pendingSpawnPrompts, replica, repos, sessions, superThreadId, trpc, uiState`; whole snapshot; replica, issueProjections, issueUserStates; stable hub; pickActions at line 112 selects stable mutation actions | Always mounted provider; hooks run with each consumer |
| `apps/web/src/app/store-worklist-pool.ts` | `useStoreHandle`:214; `useStoreHandle`:231; `runtime.getSnapshot`:117 | owner handle; inspect downstream ports/imperative reads; getSnapshot picks trpc only; pool projections are independent snapshots | Always mounted provider; hooks run with each consumer |
| `apps/web/src/app/store.tsx` | `useStoreSelector`:143; `useStoreSelector`:153; `useStoreSelector`:161; `useStoreSelector`:176; `useReplicaIssueSources`:187; `useCoreStore`:129; `useCoreStoreSelector`:137; `useCoreSlice`:170 | `caller selector, drafts, issueProjections, issueUserStates, published slice, replica, sessions, whole snapshot`; replica, issueProjections, issueUserStates | Always mounted provider; hooks run with each consumer |

### Shell, dialogs, dock and global links (11 modules)

Mount: Always mounted authenticated shell; dock body on demand. Pool coverage: Core/header partial; approval, prompt, palette, dock/ship-lane/workspace locals missing. Ownership: POD-5162; mission/navigation portions POD-5077.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/web/src/app/AppShell.tsx` | `useStoreSelector`:203; `useStoreSelector`:416; `useStoreSelector`:440; `useStoreSelector`:459; `useStoreSelector`:460; `useReplicaIssues`:462; `useStoreSelector`:474; `useStoreSelector`:477 | `hub, paletteOpen, repos, reposLoaded, selectedIssueId, sessions, setPaletteOpen, setSelectedIssueId, setSuperOpen, setView, superOpen, trpc, uiState, view`; issues (normalized projections/user state and replica-derived models) | Always mounted authenticated shell; dock body on demand |
| `apps/web/src/app/ApprovalDialog.tsx` | `useStoreSelector`:22 | `approvals, navigateToSession, trpc` | Always mounted authenticated shell; dock body on demand |
| `apps/web/src/app/AutoContinueDialog.tsx` | `useStoreSelector`:21 | `autoContinuePromptSessionId, closeAutoContinuePrompt, trpc` | Always mounted authenticated shell; dock body on demand |
| `apps/web/src/app/BrowserOpenOverlay.tsx` | `useStoreSelector`:60; `useStoreSelector`:61 | `hub, sessions` | Always mounted authenticated shell; dock body on demand |
| `apps/web/src/app/CommandPaletteBoundary.tsx` | `useStoreSelector`:18 | `paletteOpen` | Always mounted when feature enabled |
| `apps/web/src/app/MachinesPanel.tsx` | `useStoreSelector`:157 | `machines, setSettingsTab, trpc` | On demand machines panel |
| `apps/web/src/app/RightDock.tsx` | `useStoreSelector`:124; `useReplicaIssues`:138 | `coarseNow, fileTabs, paneA, repos, sessions, setSelectedIssueId, shipLanes, shipOrders, trpc`; issues (normalized projections/user state and replica-derived models) | On demand open dock |
| `apps/web/src/app/RightRail.tsx` | `useStoreSelector`:125; `useReplicaIssues`:137 | `fileTabs, paneA, repos, sessions, shipLanes, shipOrders, trpc`; issues (normalized projections/user state and replica-derived models) | Always mounted shell rail |
| `apps/web/src/app/routes.tsx` | `useStoreSelector`:54 | `view` | Always mounted authenticated shell; dock body on demand |
| `apps/web/src/app/use-desktop-close-tab.ts` | `useStoreSelector`:19 | `closeFileTab, closeWorkspaceTab, fileTabs, workspaceKey, workspaces` | Always mounted authenticated shell; dock body on demand |
| `apps/web/src/components/PodiumLinkHost.tsx` | `useStoreSelector`:73; `useReplicaIssues`:85 | `httpOrigin, navigateToSession, openArtifact, openFileInWorktree, sessions, setOpenIssueId, setView`; issues (normalized projections/user state and replica-derived models) | Always mounted authenticated shell; dock body on demand |

### Shared access, catalog and preference hooks (19 modules)

Mount: Mounted with consumer; theme/preferences also always mounted. Pool coverage: Stable owner handles available; generic UI preferences not declared in pool. Ownership: POD-5161.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/mobile/src/hooks/useCollapsed.ts` | `useUiState`:10 | uiState | Mounted with consumer; theme/preferences also always mounted |
| `apps/mobile/src/hooks/useCollapsedSet.ts` | `useUiState`:31 | uiState | Mounted with consumer; theme/preferences also always mounted |
| `apps/mobile/src/hooks/usePersistedUiState.ts` | `useUiState`:10 | uiState | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/app/theme.tsx` | `useStoreSelector`:104 | `uiState` | Always mounted theme provider |
| `apps/web/src/features/mobile-handoff/MobileHandoffChip.tsx` | `useStoreSelector`:24; `useStoreSelector`:25 | `httpOrigin, trpc` | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/features/mobile-handoff/MobilePromoCard.tsx` | `useStoreSelector`:29; `useStoreSelector`:30 | `httpOrigin, trpc` | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/features/mobile-handoff/mobile-handoff.ts` | `useStoreSelector`:151; `useReplicaIssues`:171 | `issueProjections, workspaces`; issues (normalized projections/user state and replica-derived models) | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/features/terminal/use-terminal-appearance.ts` | `useStoreSelector`:23 | `uiState` | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/ModelEffortPicker.tsx` | `useModelCatalog`:123; `useHarnessDescriptors`:126; `useModelCatalog`:167; `useHarnessDescriptors`:168; `useModelCatalog`:223; `useHarnessDescriptors`:224 | trpc (RPC-backed catalog); trpc (RPC-backed descriptors) | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/SessionContextMenu.tsx` | `useStoreSelector`:90; `useReplicaIssues`:105 | `clearSnooze, hibernateSession, machines, markSessionRead, markSessionUnread, repos, resurrectSession, setSnooze, startBtw, trpc`; issues (normalized projections/user state and replica-derived models) | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/SnoozeControl.tsx` | `useStoreSelector`:64 | `clearSnooze, setSnooze` | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/WorkerLabel.tsx` | `useHarnessDescriptors`:153 | trpc (RPC-backed descriptors) | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/at-mention/useFileMentions.ts` | `useStoreSelector`:39 | `trpc` | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/harness-descriptors.ts` | `useStoreSelector`:25 | `trpc` | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/hooks/use-session-guard.ts` | `useStoreSelector`:43 | `archiveSession, endSession, killSession, sessions` | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/sticky-prompts.ts` | `useStoreSelector`:25 | `uiState` | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/use-feature.ts` | `useStoreSelector`:74 | `trpc` | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/use-persisted-ui-state.ts` | `useStoreSelector`:36; `useStoreSelector`:58 | `uiState` | Mounted with consumer; theme/preferences also always mounted |
| `apps/web/src/lib/useConversationSearch.ts` | `useStoreSelector`:25 | `trpc` | Mounted with consumer; theme/preferences also always mounted |

### Workspace, mission, issue page and session panes (23 modules)

Mount: On demand; workspace persists behind Settings/Usage overlays. Pool coverage: Core rows exist; complete mission/pane/page projection still legacy. Ownership: POD-5077, POD-5088–POD-5093.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/web/src/app/FlightDeck.tsx` | `useStoreSelector`:190; `useStoreSelector`:689; `useStoreSelector`:1076; `useStoreSelector`:1086; `useStoreSelector`:2954; `useReplicaIssues`:2989; `useSessionDraft`:3352 | `closeIssue, coarseNow, focusIssueSession, issueVisitBaseline, machines, markIssueRead, markSessionRead, openSessionAtTranscript, openSessionTab, paneA, paneB, preferPanelMode, renameSession, repos, selectedIssueId, sessions, setIssueTucked, setPanelMode, setSelectedIssueId, setSelectedWorktree, setView, split, trpc, updateIssue`; issues (normalized projections/user state and replica-derived models); drafts | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/app/FlightDeckWaterfall.tsx` | `useStoreSelector`:251; `useStoreSelector`:608; `useStoreSelector`:1155 | `coarseNow, renameSession, trpc` | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/app/Workspace.tsx` | `useStoreSelector`:257; `useReplicaIssues`:283; `useStoreSelector`:288; `useStoreSelector`:1570 | `activateWorkspaceTab, archived, closeFileTab, closeWorkspacePane, closeWorkspaceTab, dockShells, fileTabs, focusWorkspacePane, markSessionRead, moveWorkspaceTab, openSessionTab, paneA, promoteWorkspaceTab, renameSession, repos, resizeWorkspaceSplit, selectedIssueId, selectedWorktree, sessionId, sessions, splitWorkspacePane, uiState, workspaceKey, workspaces`; issues (normalized projections/user state and replica-derived models) | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/app/use-handoff-transcript.ts` | `useStoreSelector`:45 | `replica, trpc` | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/IssueAgentSettings.tsx` | `useStoreSelector`:56 | `updateIssue` | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/IssueCompactControls.tsx` | `useStoreSelector`:245; `useStoreSelector`:342; `useStoreSelector`:508; `useReplicaIssues`:518 | `closeIssue, machines, renameSession, sessions, trpc, updateIssue`; issues (normalized projections/user state and replica-derived models) | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/IssueContextMenu.tsx` | `useStoreSelector`:140 | `closeIssue, deferIssue, deleteIssue, machines, markIssueRead, markIssueUnread, repos, restoreIssue, sessions, setIssueLabels, setIssuePlacement, trpc, undeferIssue, updateIssue` | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/IssuePanelView.tsx` | `useStoreSelector`:355; `useStoreSelector`:559; `useStoreSelector`:635; `useStoreSelector`:858; `useReplicaIssues`:872 | `httpOrigin, markIssueRead, markSessionRead, openArtifact, openFileInWorktree, repos, sessions, setPane, setSelectedIssueId, setView, trpc, updateIssue`; issues (normalized projections/user state and replica-derived models) | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/issue-lifecycle.tsx` | `useStoreSelector`:85; `useStoreSelector`:148; `useStoreSelector`:249 | `sessions` | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/issue-page-model.ts` | `useStoreSelector`:95; `useReplicaIssues`:111 | `closeIssue, deferIssue, deleteIssue, hub, navigateToSession, restoreIssue, sessions, setIssueLabels, trpc, undeferIssue, updateIssue`; issues (normalized projections/user state and replica-derived models) | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/issue-page/IssueAgentActivity.tsx` | `useStoreSelector`:55 | `httpOrigin, openArtifact, openFileInWorktree` | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/issue-page/IssueDetailHeader.tsx` | `useReplicaIssues`:66 | issues (normalized projections/user state and replica-derived models) | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/issue-page/IssueProperties.tsx` | `useStoreSelector`:106; `useReplicaIssues`:115 | `machines, navigateToSession, sessions, trpc`; issues (normalized projections/user state and replica-derived models) | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/issue-page/issue-edges.tsx` | `useStoreSelector`:114; `useReplicaIssues`:122; `useReplicaExitLookup`:124 | `replica`; issues (normalized projections/user state and replica-derived models); replica issue exitKind | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/issue-page/use-eviction-guard.ts` | `useReplicaIssues`:54 | issues (normalized projections/user state and replica-derived models) | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/use-agent-fleet-options.ts` | `useStoreSelector`:53 | `machines, repos` | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/issues/use-issue-status-apply.tsx` | `useStoreSelector`:39; `useStoreSelector`:40 | `closeIssue, updateIssue` | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/terminal/AgentPanel.tsx` | `useSessionDraft`:198; `useStoreSelector`:226; `useSession`:246; `useSession`:250; `useStoreSelector`:273; `useStoreSelector`:274; `useReplicaIssues`:304 | `dismissOffer, hibernateSession, hub, machines, navigateToSession, openFile, pendingSpawnIds, pendingSpawnPrompts, selectedIssueId, sendChat, setSessionDraft, startBtw, trpc, uiState`; drafts; one session via legacy sessions index/find; issues (normalized projections/user state and replica-derived models) | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/terminal/DockShellPanel.tsx` | `useStoreSelector`:53; `useReplicaIssues`:223 | `dockShells, hub, machines, reposLoaded, sessions, setDockShell, setDockVisibleSession, trpc`; issues (normalized projections/user state and replica-derived models) | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/terminal/SessionLifecyclePanes.tsx` | `useStoreSelector`:75 | `killSession, resurrectSession` | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/terminal/SessionWatchers.tsx` | `usePresenceRoom`:63 | hub (independent presence stream) | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/terminal/dock-shell-lifecycle.tsx` | `useStoreSelector`:53 | `dockShells, sessions, trpc` | On demand; workspace persists behind Settings/Usage overlays |
| `apps/web/src/features/terminal/use-panel-surface.ts` | `useStoreSelector`:116 | `machines, panelMode, setPanelMode, trpc, uiState` | On demand; workspace persists behind Settings/Usage overlays |

### Issue board and explorer (4 modules)

Mount: On demand board/explorer. Pool coverage: Core issue/session rows exist; board/explorer projection not switched. Ownership: POD-5080.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/web/src/features/issues/IssuesView.tsx` | `useReplicaIssues`:53; `useStoreSelector`:54; `useStoreSelector`:55; `useStoreSelector`:56; `useStoreSelector`:57; `useStoreSelector`:61; `useStoreSelector`:62; `useStoreSelector`:63; `useStoreSelector`:64 | `closeIssue, deleteIssue, openIssueId, sessions, setIssueLabels, setOpenIssueId, trpc, updateIssue`; issues (normalized projections/user state and replica-derived models) | On demand board/explorer |
| `apps/web/src/features/issues/explorer/IssueExplorer.tsx` | `useReplicaIssues`:115 | issues (normalized projections/user state and replica-derived models) | On demand board/explorer |
| `apps/web/src/features/issues/explorer/IssueExplorerList.tsx` | `useStoreSelector`:38; `useReplicaIssues`:39 | `sessions`; issues (normalized projections/user state and replica-derived models) | On demand board/explorer |
| `apps/web/src/features/issues/explorer/explorer-context.tsx` | `useStoreSelector`:85; `useReplicaIssues`:89 | `selectedIssueId, sessions`; issues (normalized projections/user state and replica-derived models) | On demand board/explorer |

### Sidebar pilot and its remaining snapshot reads (12 modules)

Mount: Always mounted sidebar; menus on demand. Pool coverage: Pool sidebar exists; layout, selection, preferences and gesture snapshot reads remain. Ownership: POD-4973; navigation POD-5077; final audit POD-5174.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/web/src/features/worklist/ManageProjectsDialog.tsx` | `useStoreSelector`:14 | `setSidebarSettings, sidebarSettings` | On demand dialog/diagnostic |
| `apps/web/src/features/worklist/SidebarPerfPanel.tsx` | `useStoreHandle`:140 | owner handle; inspect downstream ports/imperative reads | On demand dialog/diagnostic |
| `apps/web/src/features/worklist/SidebarRail.tsx` | `useStoreSelector`:245 | `setPaletteOpen` | Always mounted sidebar; menus on demand |
| `apps/web/src/features/worklist/SidebarUnified.tsx` | `useStoreSelector`:162 | `selectedIssueId` | Always mounted sidebar; menus on demand |
| `apps/web/src/features/worklist/derivation.ts` | `useSlice`:29 | published worklistSlice | Always mounted sidebar; menus on demand |
| `apps/web/src/features/worklist/new-task.ts` | `useStoreSelector`:55 | `setSelectedIssueId, setSelectedWorktree, setView, uiState` | Always mounted sidebar; menus on demand |
| `apps/web/src/features/worklist/pool-sidebar-rail.tsx` | `useStoreSelector`:36; `useStoreSelector`:163 | `selectedIssueId, selectedWorktree, setPaletteOpen` | Always mounted sidebar; menus on demand |
| `apps/web/src/features/worklist/pool-sidebar.tsx` | `useStoreSelector`:97; `useStoreSelector`:140; `useStoreSelector`:646; `useStoreSelector`:795 | `paneA, pins, selectedIssueId, selectedWorktree, setSelectedIssueId, sidebarSettings` | Always mounted sidebar; menus on demand |
| `apps/web/src/features/worklist/sidebar-common.tsx` | `useStoreSelector`:171; `useStoreSelector`:401; `useStoreSelector`:668; `useStoreSelector`:669; `useStoreSelector`:696 | `coarseNow, continueSession, renameSession, uiState` | Always mounted sidebar; menus on demand |
| `apps/web/src/features/worklist/use-pool-unified-work.ts` | `useStoreHandle`:244; `runtime.getSnapshot`:91; `runtime.getSnapshot`:95; `runtime.getSnapshot`:114; `runtime.getSnapshot`:155; `runtime.getSnapshot`:181; `runtime.getSnapshot`:192; `runtime.getSnapshot`:197; `runtime.getSnapshot`:200; `runtime.getSnapshot`:201; `runtime.getSnapshot`:202; `runtime.getSnapshot`:204; `runtime.getSnapshot`:206 | owner handle; inspect downstream ports/imperative reads; gesture-time snapshot paneA/fileTabs; remaining calls acquire existing actions | Always mounted sidebar; menus on demand |
| `apps/web/src/features/worklist/use-sidebar-projects.ts` | `useStoreSelector`:27; `useSlice`:36; `useSlice`:61 | `pins, sidebarSettings`; published worklistSlice | Always mounted sidebar; menus on demand |
| `apps/web/src/features/worklist/use-unified-work.ts` | `useStoreSelector`:90; `useReplicaIssues`:125; `useSlice`:131 | `archiveIssue, deferIssue, deleteIssue, fileTabs, markIssueRead, markSessionRead, navigateWorkspace, paneA, pins, repos, selectedIssueId, selectedWorktree, sessions, setIssueTucked, setOpenIssueId, setPane, setSelectedIssueId, setSelectedWorktree, setView, updateIssue`; issues (normalized projections/user state and replica-derived models); published worklistSlice | Always mounted sidebar; menus on demand |

### Header pilot and host utilities (7 modules)

Mount: Always mounted indicators; host utilities on demand. Pool coverage: Header schema/views exist; legacy branches remain; dead letters not declared. Ownership: POD-5079; recovery POD-5163; preference/handle tail POD-5161.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/web/src/app/FoldedFlightDeckBar.tsx` | `useStoreSelector`:296; `useReplicaIssues`:300 | `selectedIssueId, sessions, trpc`; issues (normalized projections/user state and replica-derived models) | Always mounted indicators; host utilities on demand |
| `apps/web/src/app/header-data.ts` | `useStoreHandle`:17; `useStoreSelector`:24; `useStoreSelector`:35; `useReplicaIssues`:36; `useStoreSelector`:50; `useStoreSelector`:114; `owner.getSnapshot`:19 | `outboxSize, selectedIssueId, sessions, setSettingsTab, setView, trpc, view`; owner handle; inspect downstream ports/imperative reads; issues (normalized projections/user state and replica-derived models); pool getSnapshot site picks stable actions only; other calls are fallback data | Always mounted indicators; host utilities on demand |
| `apps/web/src/features/machines/ConnectionIndicator.tsx` | `useStoreSelector`:17 | `hub` | Always mounted indicators; host utilities on demand |
| `apps/web/src/features/machines/HostIndicators.tsx` | `useStoreSelector`:201; `useReplicaIssues`:209 | `machines, sessions, trpc`; issues (normalized projections/user state and replica-derived models) | Always mounted indicators; host utilities on demand |
| `apps/web/src/features/machines/HostMemoryView.tsx` | `useStoreSelector`:164; `useStoreSelector`:465 | `sessions, setSettingsTab, setView, trpc` | Always mounted indicators; host utilities on demand |
| `apps/web/src/features/machines/LoadPanel.tsx` | `useSessions`:89; `useStoreSelector`:531 | `sessions`; sessions | Always mounted indicators; host utilities on demand |
| `apps/web/src/features/machines/host-lifecycle-settings.ts` | `useStoreSelector`:21 | `trpc` | Always mounted indicators; host utilities on demand |

### Web reference chips and hover miniviews (3 modules)

Mount: Mounted with content; hover body on demand. Pool coverage: Addressed pool reference reader exists; web chip fallback remains. Ownership: POD-5078/POD-5121; miniview session-context tail POD-5173.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/web/src/components/IssueReference.tsx` | `useStoreHandle`:27; `useReplicaIssues`:28; `useStoreHandle`:34 | owner handle; inspect downstream ports/imperative reads; issues (normalized projections/user state and replica-derived models) | Mounted with content; hover body on demand |
| `apps/web/src/components/RefMiniview.tsx` | `useReplicaIssues`:73; `useStoreHandle`:74; `useStoreSelector`:81; `useStoreSelector`:143; `useReplicaIssues`:554; `useStoreHandle`:555; `useStoreSelector`:573 | `machines, navigateToSession, repos, sessions, setOpenIssueId, setView, trpc`; issues (normalized projections/user state and replica-derived models); owner handle; inspect downstream ports/imperative reads | Mounted with content; hover body on demand |
| `apps/web/src/features/chat/IssueChipLiveness.tsx` | `useStoreHandle`:24; `useReplicaIssues`:52; `useStoreHandle`:53 | owner handle; inspect downstream ports/imperative reads; issues (normalized projections/user state and replica-derived models) | Mounted with content; hover body on demand |

### Superagent and concierge (4 modules)

Mount: On demand dock or mobile Superagent route. Pool coverage: Session/repo rows exist; super-thread, active-thread, issue-event/read-position source missing. Ownership: POD-5164.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/mobile/src/screens/SuperagentScreen.tsx` | `useTrpc`:75; `useStoreActions`:76; `useReplica`:77; `useHttpOrigin`:78; `useSessions`:79; `useHub`:80; `useBooting`:81; `useSlice`:93; `useStoreSelector`:129; `useModelCatalog`:137 | `pendingInteractions`; stable trpc; stable mutation actions; replica handle / downstream exit lookup; stable httpOrigin; sessions; stable hub; replica cursor, sessions, issueProjections; published superagentSlice; trpc (RPC-backed catalog) | On demand dock or mobile Superagent route |
| `apps/web/src/features/superagent/ConciergeButton.tsx` | `useStoreSelector`:23; `useSession`:33 | `paneA, repos, selectedWorktree, setSuperOpen, setSuperThreadId`; one session via legacy sessions index/find | On demand dock or mobile Superagent route |
| `apps/web/src/features/superagent/SuperagentView.tsx` | `useStoreSelector`:87; `useSlice`:118; `useSession`:165 | `hub, readPosition, refreshSuperThreads, setPane, setSelectedIssueId, setSelectedWorktree, setView, trpc`; published superagentSlice; one session via legacy sessions index/find | On demand dock or mobile Superagent route |
| `apps/web/src/features/superagent/useIssueEvents.ts` | `useStoreSelector`:51 | `issueEvents` | On demand dock or mobile Superagent route |

### Message, interaction and recovery banners (7 modules)

Mount: Mounted with host; mobile MessageNoticeBanner always mounted at root. Pool coverage: window.outboxSize exists; message, interaction and dead-letter projections missing. Ownership: POD-5163.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/mobile/src/components/MessageNoticeBanner.tsx` | `useStoreSelector`:24; `useTrpc`:28 | `messageRecords, sessions`; stable trpc | Always mounted at mobile root |
| `apps/mobile/src/components/OutboxRecoveryPanel.tsx` | `useStoreSelector`:28; `useStoreSelector`:184 | `outboxDeadLetters, recoverOutbox` | Mounted with host; mobile MessageNoticeBanner always mounted at root |
| `apps/mobile/src/components/PendingInteractionBand.tsx` | `useStoreSelector`:42; `useStoreSelector`:45 | `pendingInteractions, trpc` | Mounted with host; mobile MessageNoticeBanner always mounted at root |
| `apps/mobile/src/components/WorkspaceContinuityNotice.tsx` | `useConnected`:18; `useStoreSelector`:19 | `outboxDeadLetters, outboxSize`; hub / independent connection stream | Mounted with host; mobile MessageNoticeBanner always mounted at root |
| `apps/web/src/features/chat/MessageNotices.tsx` | `useStoreSelector`:34; `useStoreSelector`:80 | `messageRecords, openSessionTab, sessions, trpc` | Mounted with host; mobile MessageNoticeBanner always mounted at root |
| `apps/web/src/features/chat/PendingInteractionBar.tsx` | `useStoreSelector`:48 | `pendingInteractions, trpc` | Mounted with host; mobile MessageNoticeBanner always mounted at root |
| `apps/web/src/features/machines/OutboxRecovery.tsx` | `useStoreSelector`:69; `useStoreSelector`:242 | `outboxDeadLetters, recoverOutbox` | Mounted with host; mobile MessageNoticeBanner always mounted at root |

### Command palette and launch menus (7 modules)

Mount: On demand menus; CommandPalette stays mounted after first open. Pool coverage: Core/header choices partial; palette/pins/recent-files/launch projections missing. Ownership: POD-5165; NewIssueDialog file shared with POD-5080.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/mobile/src/components/ConfiguredIssueLaunchSheet.tsx` | `useStoreSelector`:42 | `trpc` | On demand menus; CommandPalette stays mounted after first open |
| `apps/mobile/src/components/LaunchConfigurationFields.tsx` | `useStoreSelector`:53; `useModelCatalogState`:86; `useHarnessDescriptors`:91 | `machines, repos`; trpc (RPC-backed catalog); trpc (RPC-backed descriptors) | On demand menus; CommandPalette stays mounted after first open |
| `apps/mobile/src/components/NewWorkButton.tsx` | `useStoreActions`:99; `useMachines`:100; `useSessions`:101; `useSlice`:102; `useModelCatalog`:148; `useHarnessDescriptors`:151 | stable mutation actions; machines; sessions; published worklistSlice; trpc (RPC-backed catalog); trpc (RPC-backed descriptors) | On demand menus; CommandPalette stays mounted after first open |
| `apps/mobile/src/screens/NewIssueScreen.tsx` | `useStoreSelector`:47; `useSessions`:48 | `repos, trpc`; sessions | On demand menus; CommandPalette stays mounted after first open |
| `apps/web/src/app/CommandPalette.tsx` | `useStoreSelector`:102; `useStoreSelector`:143; `useStoreSelector`:268; `useReplicaIssues`:305 | `clearSnooze, closeIssue, deferIssue, deleteIssue, hibernateSession, machines, markIssueRead, markIssueUnread, markSessionRead, markSessionUnread, openIssueId, paletteOpen, paneA, pins, repos, restoreIssue, resurrectSession, selectedIssueId, selectedWorktree, sessions, setIssueLabels, setOpenIssueId, setPaletteOpen, setPane, setSelectedIssueId, setSelectedWorktree, setSettingsTab, setSnooze, setView, spawnDraftAgent, startBtw, trpc, undeferIssue, updateIssue`; issues (normalized projections/user state and replica-derived models) | On first open, then always mounted |
| `apps/web/src/app/NewPanelMenu.tsx` | `useStoreSelector`:141; `useStoreSelector`:409 | `machines, openArtifact, openFileInWorktree, recentFiles, repos, sessions, setPanelMode, trpc` | On demand menus; CommandPalette stays mounted after first open |
| `apps/web/src/features/issues/NewIssueDialog.tsx` | `useStoreSelector`:219 | `machines, repos, sessions, trpc` | On demand menus; CommandPalette stays mounted after first open |

### Settings and activation/setup (19 modules)

Mount: On demand overlay/route or activation-only shell. Pool coverage: Header machine/repo/lifecycle partial; preferences, diagnostics and conversations missing. Ownership: POD-5166; shared preference/transport seam POD-5161.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/mobile/src/screens/SettingsScreen.tsx` | `useStoreSelector`:47; `useIssues`:59; `useConnected`:61 | `conversations, httpOrigin, machines, outboxDeadLetters, outboxSize, replica, sessions`; issues (normalized projections/user state and replica-derived models); hub / independent connection stream; replica.getCursor at line 226 | On demand overlay/route or activation-only shell |
| `apps/web/src/features/settings/SettingsView.tsx` | `useStoreSelector`:260 | `setSettingsTab, settingsTab, trpc` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/settings/sections/accounts.tsx` | `useStoreSelector`:71; `useStoreSelector`:220; `useStoreSelector`:378 | `navigateToSession, sessions, trpc` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/settings/sections/network.tsx` | `useStoreSelector`:31 | `trpc` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/settings/sections/notifications.tsx` | `useStoreSelector`:223 | `uiState` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/settings/sections/privacy.tsx` | `useStoreSelector`:69; `useStoreSelector`:253 | `trpc` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/settings/sections/repos.tsx` | `useStoreSelector`:32 | `trpc` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/settings/sections/shared.tsx` | `useModelCatalog`:314 | trpc (RPC-backed catalog) | On demand overlay/route or activation-only shell |
| `apps/web/src/features/settings/sections/superagent.tsx` | `useStoreSelector`:62 | `trpc` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/settings/sections/updates.tsx` | `useStoreSelector`:111 | `machines, trpc` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/settings/use-forced-setting.ts` | `useStoreSelector`:107 | `trpc` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/setup/ColdStartComposer.tsx` | `useStoreSelector`:169 | `focusIssueSession, machines, repos, sessions, setPane, setPanelMode, setSelectedIssueId, setSelectedWorktree, setView, spawnDraftAgent, spawnIssueAgent, trpc, uiState` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/setup/ExistingPodiumActivation.tsx` | `useStoreSelector`:100 | `uiState` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/setup/FirstTaskActivation.tsx` | `useStoreSelector`:124 | `machines, repos, trpc, uiState` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/setup/GitHubProjectIntake.tsx` | `useStoreSelector`:46 | `trpc, uiState` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/setup/OnboardingWizard.tsx` | `useStoreSelector`:57 | `machines` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/setup/RepoPickerModal.tsx` | `useStoreSelector`:131 | `trpc` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/setup/RepoScanFlow.tsx` | `useStoreSelector`:85 | `machines, refreshRepos, trpc, uiState` | On demand overlay/route or activation-only shell |
| `apps/web/src/features/setup/VpsFirstActivation.tsx` | `useStoreSelector`:121 | `uiState` | On demand overlay/route or activation-only shell |

### Automations and specifications (4 modules)

Mount: On demand route/dialog. Pool coverage: Core/header choices partial; automation/run entities missing. Ownership: POD-5167.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/web/src/features/automations/AutomationsView.tsx` | `useStoreSelector`:18 | `automationRuns, automations, trpc` | On demand route/dialog |
| `apps/web/src/features/automations/NewAutomationDialog.tsx` | `useStoreSelector`:110 | `machines, repos, sessions` | On demand route/dialog |
| `apps/web/src/features/automations/ScheduledSection.tsx` | `useStoreSelector`:304; `useSession`:307 | `navigateToSession`; one session via legacy sessions index/find | On demand route/dialog |
| `apps/web/src/features/specs/SpecsView.tsx` | `useStoreSelector`:63 | `repos, trpc` | On demand route/dialog |

### Workflows and merge queue (4 modules)

Mount: On demand route/panel. Pool coverage: Core/header target rows exist; workflow RPC read models have no pool projection. Ownership: POD-5168.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/web/src/features/merge-queue/MergeQueuePanel.tsx` | `useRepoLocks`:78 | trpc (RPC-backed leases) | On demand route/panel |
| `apps/web/src/features/workflows/ExecutionProfiles.tsx` | `useStoreSelector`:61 | `machines` | On demand route/panel |
| `apps/web/src/features/workflows/RunProgress.tsx` | `useReplicaIssues`:97; `useSession`:98 | issues (normalized projections/user state and replica-derived models); one session via legacy sessions index/find | On demand route/panel |
| `apps/web/src/features/workflows/use-workflows.ts` | `useStoreSelector`:83 | `trpc` | On demand route/panel |

### Usage, cost utilities and message ledger (4 modules)

Mount: On demand overlay/panel or mission chip. Pool coverage: These selector sites fetch stable API handles; RPC data is not legacy snapshot data. Ownership: POD-5169; shared handle seam POD-5161.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/web/src/app/FlightDeckHandoff.tsx` | `useStoreSelector`:118 | `trpc` | On demand overlay/panel or mission chip |
| `apps/web/src/app/MissionCostChip.tsx` | `useStoreSelector`:101 | `trpc` | On demand overlay/panel or mission chip |
| `apps/web/src/features/messages/MessageLedgerView.tsx` | `useStoreSelector`:109 | `trpc` | On demand overlay/panel or mission chip |
| `apps/web/src/features/usage/UsageView.tsx` | `useStoreSelector`:57 | `trpc` | On demand overlay/panel or mission chip |

### File viewers and Git panels (13 modules)

Mount: On demand panel/modal or mobile issue section. Pool coverage: Methods/HTTP origin are stable; viewer UI preferences lack pool coverage. Ownership: POD-5170; preference seam POD-5161.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/mobile/src/components/task-detail/GitReviewSection.tsx` | `useStoreSelector`:42 | `gitDiffFile, gitStatus, readFileScoped` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/files/AssetFilePanel.tsx` | `useStoreSelector`:35 | `httpOrigin` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/files/DownloadFileButton.tsx` | `useStoreSelector`:29 | `httpOrigin` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/files/FileBrowserModal.tsx` | `useStoreSelector`:32 | `listDir, openFileInWorktree` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/files/HtmlFilePanel.tsx` | `useStoreSelector`:44 | `httpOrigin, readFileScoped, uiState` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/files/JsonFilePanel.tsx` | `useStoreSelector`:79 | `uiState` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/files/MarkdownFilePanel.tsx` | `useStoreSelector`:44 | `uiState` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/files/MarkdownPreview.tsx` | `useStoreSelector`:30 | `httpOrigin, openFile` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/files/OpenInBrowserButton.tsx` | `useStoreSelector`:33 | `httpOrigin` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/files/WorktreeFileTree.tsx` | `useStoreSelector`:182 | `listDir, openFileInWorktree, trpc` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/files/useFileDocument.ts` | `useStoreSelector`:29 | `readFileScoped, writeFileScoped` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/git/DiffSheet.tsx` | `useStoreSelector`:492 | `gitCommitDiffFile, gitDiffFile, readFileScoped` | On demand panel/modal or mobile issue section |
| `apps/web/src/features/git/GitPanelView.tsx` | `useStoreSelector`:107 | `gitCommitFiles, gitLog, gitStatus` | On demand panel/modal or mobile issue section |

### Web chat context and conversation adapters (5 modules)

Mount: On demand conversation; can remain mounted behind overlays. Pool coverage: Core issue/session rows exist; draft, message, outbox, pending and focus context missing. Ownership: POD-5173; header/session panes POD-5092; banners POD-5163.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/web/src/features/chat/ChatComposer.tsx` | `useReplicaIssues`:330 | issues (normalized projections/user state and replica-derived models) | On demand conversation; can remain mounted behind overlays |
| `apps/web/src/features/chat/ChatView.tsx` | `useSessionDraft`:111; `useStoreSelector`:217; `useReplicaIssues`:222 | `pendingInteractions`; drafts; issues (normalized projections/user state and replica-derived models) | On demand conversation; can remain mounted behind overlays |
| `apps/web/src/features/chat/OfferArtifactStrip.tsx` | `useStoreSelector`:35; `useReplicaIssues`:43 | `httpOrigin, openArtifact, openFileInWorktree`; issues (normalized projections/user state and replica-derived models) | On demand conversation; can remain mounted behind overlays |
| `apps/web/src/features/chat/use-chat-send.ts` | `storeConversationRecords`:325; `storeConversationOutbox`:326 | messageRecords, outboxDeadLetters, chatSendsFor through conversation/store-ports | On demand conversation; can remain mounted behind overlays |
| `apps/web/src/features/chat/use-chat-surface.ts` | `useStoreSelector`:242; `useSession`:266; `useSessionExitKind`:267; `useStoreHandle`:268; `useStoreSelector`:660; `useSession`:733; `storeHandle.getSnapshot`:271; `storeHandle.getSnapshot`:559 | `attachedSessionId, chatSendsFor, clearAttachedSession, clearTranscriptReveal, discardChat, dismissOffer, getUserFocus, httpOrigin, hub, machines, openFile, pendingInteractions, replica, sendChat, setPanelMode, setSessionDraft, superThreads, tldrSession, transcriptReveal, trpc`; one session via legacy sessions index/find; replica exitKind; owner handle; inspect downstream ports/imperative reads; imperative issueProjections.seq and drafts | On demand conversation; can remain mounted behind overlays |

### Mobile work, issue and mission lanes (5 modules)

Mount: On demand route; tabs may remain mounted after visit. Pool coverage: Core rows available in package; mobile surface pool attachment/read path not present here. Ownership: POD-4972/POD-5081; normalized-home overlap POD-5113.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/mobile/src/screens/IssueScreen.tsx` | `useIssue`:107; `useBooting`:108; `useConnected`:109; `useTrpc`:190; `useStoreActions`:193; `useReplica`:195; `useCoarseNow`:196; `useIssues`:197; `useSessions`:198 | one issue via legacy normalized issue facade; replica cursor, sessions, issueProjections; hub / independent connection stream; stable trpc; stable mutation actions; replica handle / downstream exit lookup; coarseNow; issues (normalized projections/user state and replica-derived models); sessions | On demand route; tabs may remain mounted after visit |
| `apps/mobile/src/screens/IssuesScreen.tsx` | `useStoreSelector`:74; `useIssues`:78; `useSessions`:79; `useBooting`:113 | `closeIssue, coarseNow, updateIssue`; issues (normalized projections/user state and replica-derived models); sessions; replica cursor, sessions, issueProjections | On demand route; tabs may remain mounted after visit |
| `apps/mobile/src/screens/MissionDetailsScreen.tsx` | `useIssues`:30; `useSessions`:31; `useStoreSelector`:32; `useSlice`:37 | `closeIssue, setIssueTucked`; issues (normalized projections/user state and replica-derived models); sessions; published worklistSlice | On demand route; tabs may remain mounted after visit |
| `apps/mobile/src/screens/MissionScreen.tsx` | `useStoreSelector`:65; `useBooting`:73; `useIssues`:74; `useSessions`:75; `useHarnessDescriptors`:195 | `closeIssue, setIssueTucked, updateIssue`; replica cursor, sessions, issueProjections; issues (normalized projections/user state and replica-derived models); sessions; trpc (RPC-backed descriptors) | On demand route; tabs may remain mounted after visit |
| `apps/mobile/src/screens/WorkScreen.tsx` | `useStoreActions`:146; `useSessions`:147; `useIssues`:148; `useBooting`:149; `useSlice`:157 | stable mutation actions; sessions; issues (normalized projections/user state and replica-derived models); replica cursor, sessions, issueProjections; published worklistSlice | On demand route; tabs may remain mounted after visit |

### Mobile sessions, conversations and terminals (6 modules)

Mount: On demand route; tabs may remain mounted after visit. Pool coverage: Session rows exist in package; mobile draft/spawn/exit/conversation context missing. Ownership: POD-5171.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/mobile/app/session/[sessionId]/terminal.tsx` | `useSession`:38; `useIssue`:39 | one session via legacy sessions index/find; one issue via legacy normalized issue facade | On demand route; tabs may remain mounted after visit |
| `apps/mobile/src/components/SessionConversation.tsx` | `useStoreSelector`:158; `useHub`:173; `useIssues`:174; `useSessions`:175; `useMachines`:176; `useStoreSelector`:189; `useSessionDraft`:194; `useStoreHandle`:267; `storeConversationRecords`:276; `storeConversationOutbox`:277 | `chatSendsFor, discardChat, dismissOffer, httpOrigin, killSession, pendingInteractions, replica, resurrectSession, sendChat, setSessionDraft, trpc`; stable hub; issues (normalized projections/user state and replica-derived models); sessions; machines; drafts; owner handle; inspect downstream ports/imperative reads; messageRecords, outboxDeadLetters, chatSendsFor through conversation/store-ports | On demand route; tabs may remain mounted after visit |
| `apps/mobile/src/screens/SessionScreen.tsx` | `useStoreActions`:69; `useReplica`:70; `useSessions`:71; `useSession`:72; `useHarnessDescriptors`:75; `useSpawnPending`:76; `useSpawnPrompt`:77; `useIssue`:78; `useBooting`:79 | stable mutation actions; replica handle / downstream exit lookup; sessions; one session via legacy sessions index/find; trpc (RPC-backed descriptors); pendingSpawnIds; pendingSpawnPrompts; one issue via legacy normalized issue facade; replica cursor, sessions, issueProjections | On demand route; tabs may remain mounted after visit |
| `apps/mobile/src/screens/SessionsScreen.tsx` | `useSessions`:30; `useIssues`:31; `useBooting`:34 | sessions; issues (normalized projections/user state and replica-derived models); replica cursor, sessions, issueProjections | On demand route; tabs may remain mounted after visit |
| `apps/mobile/src/terminal/TerminalPane.native.tsx` | `useHub`:52; `useConnected`:53; `useSpawnPending`:54; `useSessions`:57 | stable hub; hub / independent connection stream; pendingSpawnIds; sessions | On demand route; tabs may remain mounted after visit |
| `apps/mobile/src/terminal/TerminalPane.web.tsx` | `useHub`:39; `useConnected`:40; `useIssues`:41; `useSessions`:44; `useSpawnPending`:116 | stable hub; hub / independent connection stream; issues (normalized projections/user state and replica-derived models); sessions; pendingSpawnIds | On demand route; tabs may remain mounted after visit |

### Mobile inbox, pulse, reference and support access (16 modules)

Mount: On demand route/component; PodiumLinkHost always mounted at root. Pool coverage: Core/header/ref readers reusable; mobile surfaces still use legacy accessors. Ownership: POD-5172; shared stable access POD-5161.

| Module | Call sites (line) | Inputs / entities read | Mount |
| --- | --- | --- | --- |
| `apps/mobile/src/components/IssueColorSheet.tsx` | `useStoreActions`:37 | stable mutation actions | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/components/OfferArtifactStrip.tsx` | `useHttpOrigin`:50 | stable httpOrigin | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/components/PodiumLinkHost.tsx` | `useHttpOrigin`:37; `useIssues`:38; `useSessions`:39; `useBooting`:40 | stable httpOrigin; issues (normalized projections/user state and replica-derived models); sessions; replica cursor, sessions, issueProjections | Always mounted at mobile root |
| `apps/mobile/src/components/RefChip.tsx` | `useIssues`:88 | issues (normalized projections/user state and replica-derived models) | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/components/TaskSheet.tsx` | `useTrpc`:97; `useTrpc`:192; `useStoreActions`:193; `useHttpOrigin`:356 | stable trpc; stable mutation actions; stable httpOrigin | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/components/WorkIssueMenu.tsx` | `useStoreActions`:58 | stable mutation actions | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/components/task-detail/IssueAgentPanel.tsx` | `useHttpOrigin`:35 | stable httpOrigin | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/components/useComposerAttachments.ts` | `useTrpc`:95 | stable trpc | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/hooks/usePendingQuestion.ts` | `useTrpc`:13 | stable trpc | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/hooks/useRefreshableTab.tsx` | `useHub`:42; `useConnected`:43 | stable hub; hub / independent connection stream | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/lib/build-stamp.ts` | `useHttpOrigin`:124 | stable httpOrigin | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/lib/use-issue-detail.ts` | `useTrpc`:68; `useHub`:69 | stable trpc; stable hub | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/screens/InboxScreen.tsx` | `useTrpc`:49; `useStoreActions`:50; `useSessions`:122; `useIssues`:123; `useBooting`:127; `useOutboxSize`:128 | stable trpc; stable mutation actions; sessions; issues (normalized projections/user state and replica-derived models); replica cursor, sessions, issueProjections; outboxSize | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/screens/ProposalScreeningScreen.tsx` | `useIssues`:58; `useTrpc`:59; `useStoreActions`:60; `useBooting`:61 | issues (normalized projections/user state and replica-derived models); stable trpc; stable mutation actions; replica cursor, sessions, issueProjections | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/screens/session-link.ts` | `useTrpc`:23 | stable trpc | On demand route/component; PodiumLinkHost always mounted at root |
| `apps/mobile/src/screens/usePulseFeed.ts` | `useTrpc`:105; `useMachines`:107 | stable trpc; machines | On demand route/component; PodiumLinkHost always mounted at root |

## Imperative and indirect reads requiring explicit migration

| Site | What it actually reads | Disposition |
| --- | --- | --- |
| `apps/web/src/features/chat/use-chat-surface.ts:271,559` | `issueProjections` to find an issue sequence; `drafts[sessionId]` to seed the controller | Actual legacy data reads even without a selector call at that site. POD-5173. |
| `apps/web/src/features/chat/use-chat-send.ts:325,326`; `apps/mobile/src/components/SessionConversation.tsx:276,277` | `storeConversationRecords/Outbox` use `conversation/store-ports.ts:23–25,43,66` to read/subscribe to messageRecords, dead letters and held sends | Actual hidden store readers; migrate the input ports while preserving the conversation/controller and existing outbox owner. POD-5173/POD-5171, coordinated with POD-5163. |
| `apps/web/src/features/worklist/use-pool-unified-work.ts:95,114,155` | Snapshot `paneA` and `fileTabs` influence trace and chosen pane. Reads at 91,181,192,197–206 acquire batching/actions. | Selection/file data must move to declared pool locals. Keep command dispatch on the owner; do not blanket-delete all snapshot calls. POD-5077/POD-4973/POD-5174. |
| `apps/web/src/app/header-data.ts:19` and `app/store-worklist-pool.ts:117` | Stable trpc and actions, not legacy derivation output | Stable-access cleanup; pool registration remains one pool on the current runtime. POD-5161. |
| `apps/mobile/src/client/hooks.ts:286–291`; `screens/SettingsScreen.tsx:226` | Cursor plus snapshot sessions/issueProjections for boot state; cursor displayed in diagnostics | Use a declared load/readiness/diagnostic source; no replacement replica or raw synchronous missing-row read. POD-5161/POD-5166. |

`app/SyncLoader.tsx:165,279`, `lib/sync-progress.ts:46`, mobile `MobileSyncBoundary.tsx:59`/`mobile-sync-progress.ts:60`, `ReducedMotionProvider.web.tsx:15,37`, transcript/controller snapshots (`useTranscriptWindow.ts:667,672,697`, `use-chat-send.ts:36,362`, mobile SessionConversation:244,371) and pool-projection snapshots (`IssueChipLiveness.tsx:38,42`) are independent progress/platform/stream/pool stores. They match the supplemental grep but do not read the legacy publish pipeline. Presence and host metrics likewise have independent publishers; their legacy handle acquisition still appears in the access inventory.

## Child steps and ordering

These are internal decomposition children, not new independent proposals. No child was started or claimed. All need a coordinator start note allocating non-overlapping product files and shared pool/diagnostic ownership. Stable-access removal is the prerequisite; then prioritize always-mounted and frequently-used context before utility screens. This is a mount/frequency recommendation, not a measured speed-up ranking. The measured earlier workspace/sidebar/board/mobile issue lanes retain their order and ownership.

| Recommended order | Child | Scope / effort | Trivial portion |
| --- | --- | --- | --- |
| 1 | POD-5161 — Client access and preferences | Shared owner access, UI preferences, catalog/descriptor/lock/presence inputs; shared files must be serialized | Stable API/action/hub/origin acquisition |
| 2 | POD-5163 — Message and recovery banners | Root and conversation banners; declare message/interaction/dead-letter views | Recovery/dismiss methods only |
| 3 | POD-5173 — Chat context pool readers | Web context, mentions, artifact lookup, imperative snapshots and conversation ports; after POD-5092 | API/origin/action acquisition |
| 4 | POD-5162 — Shell dialogs and dock | Global dialogs, links and dock; serialize AppShell after POD-5077 | Stable chrome actions |
| 5 | POD-5164 — Superagent thread pool readers | Web/mobile threads and focus; declare private thread/session/event relations | Refresh/API handles only |
| 6 | POD-5171 — Mobile session pool readers | Session screen, conversation ports, session list, both terminal platforms; after POD-4972/POD-5113 | Action/transport acquisition |
| 7 | POD-5172 — Mobile inbox and pulse | Inbox, screening, health and mobile refs; after POD-4972 | RPC/accessor-only support |
| 8 | POD-5165 — Command and launch menus | Retained command palette, new panel/task choices and mobile launch sheets | Catalog/descriptor/request handles |
| 9 | POD-5166 — Settings screens pool readers | Settings, mobile diagnostics, activation and setup | Most web settings RPC selectors |
| 10 | POD-5167 — Automation and specification screens | Automation/run entities and target relations; specs repo choice | Specs API handle |
| 11 | POD-5168 — Workflow screens pool readers | Placement/subject context, RPC read models and merge-queue access | Workflow/lock API handles |
| 12 | POD-5169 — Usage and message ledgers | Usage, cost and message-ledger API readers | All identified selectors are stable API handles |
| 13 | POD-5170 — File and Git viewers | HTTP/file/Git request methods and viewer preferences | Git methods and most file handles |
| 14 | POD-5174 — Legacy reader retirement audit | Delete accepted fallback paths after startup defaults/rollback windows; reconcile other lanes | Static type/helper relocation only |

Each screen follows the parent recipe: declared schema/relations first; startup-latched OFF switch; existing mutation owner; synthetic and ludovico-only operator replay comparison with zero differences; store-level zero legacy-derivation counters; real-browser before/after on the operator-sized corpus; operator-controlled default followed by deletion in about a week. New checks must reject planted mistakes. Four cutoff rules apply to every row: one reader/no peeks, resident-only indexes, declared summaries for unloaded rows, and nonblocking LOADING plus batched loads.

Existing ownership stays explicit: POD-5077 owns workspace/mission/page/session pane and switching (including the web terminal consumers named in the known list); POD-5080 owns board/explorer; POD-5081 owns mobile issue/mission; POD-4973 owns sidebar pilot acceptance; POD-5079 owns header; POD-5121 owns web chip retirement. POD-5083 removes the pipeline only after all reader owners finish. Scope overlaps in AppShell, FlightDeckWaterfall, NewIssueDialog, use-chat-surface, mobile hooks/provider and shared schema/diagnostics require serialization, not concurrent edits by these children.

**Exit condition:** no production web/mobile surface reads a legacy snapshot field or published slice, including through aliases, conversation ports, event callbacks, retained hidden components or switched fallback paths whose retirement is due. Writes still use the existing owner/outbox. Static types/helpers, test fixtures and independent stream/progress/pool snapshots must be identified explicitly rather than counted as data readers or silently deleted. The present inventory does not satisfy that condition.

## Validation for this first-step deliverable

This change is documentation and issue structure only. Bun 1.4.2 matches mise.toml, and `bun run setup:worktree` completed its checkout-local frozen install. Source call sites, named selectors, conversation adapters, route composition and pool declarations were read directly. No tests, typecheck, lint, benchmark, browser drive or operator-data replay ran, because no runtime implementation or new automated check was added. Future product children use focused foreground checks on flatblock; runs that report times use bench:flatblock. No operator server or daemon was restarted.

## Viewmodel import appendix

These imports are not automatically additional store subscriptions. Some are pure formatting/types, some derive from the props/RPC data supplied by a reader above, and published-slice imports are marked. The full symbol list is necessary for the later viewmodel deletion: relocate still-used pure APIs/types rather than dropping them. File:line below is the import declaration's first line; the raw-scan appendix records the matching module-specifier line too.

| Module | Import line(s) and bindings | Classification |
| --- | --- | --- |
| `apps/mobile/app/session/[sessionId]/terminal.tsx` | 1: `import { panelLabel, sessionDotTone, sessionTitle } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/client/trpc.ts` | 10: `import type { AskAnswerChoice } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/mobile/src/components/AskQuestionCard.tsx` | 1: `import { type AskAnswerChoice, isChosenOption, isPreviewLayout, parseAskQuestions, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/IssueCloseSheet.tsx` | 1: `import type { IssueCloseConcern, IssueNavigationModel } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/mobile/src/components/IssueColorSheet.tsx` | 1: `import type { IssueNavigationModel } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/mobile/src/components/LaunchConfigurationFields.tsx` | 3: `import { reposToViews } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/components/MessageNoticeBanner.tsx` | 3: `import { messageNotices } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/components/MissionDeck.tsx` | 4: `import { buildFlightDeckRows, continuationPresenceLine, deckIssueState, deckSessions, deckViewEmptyLine, type FlightDeckFoldMap, type FlightDeckFoldState, type FlightDeckMode, type FlightDeckRow, flightDeckRowHasPayload, flightDeckRowIsFolded, formatClock, type IssueContinuation, type IssueNavigationModel, isCoordinatorSession, issueAbandoned, issueContinuation, issueNote, missionDepartures, motionPhase, presenceNote, readFlightDeckFolds, sessionAsksOnIssue, sessionRole, sessionSettled, sessionTitle, treeGuides, writeFlightDeckFolds, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/NewWorkButton.tsx` | 9: `import { AGENT_NOT_READY_COPY, activationAgentIsReady, agentReadinessOnMachines, lastUsedMaps, launchAgentKind, machineViewsFromWire, type RepoNavView, resolveSpawnTargetMachine, spawnTargetForRepo, usableMachines, worklistSlice, } from '@podium/client-core/viewmodels'` | Contains slice/type API; any subscription is in the reader table |
| `apps/mobile/src/components/PendingInteractionBand.tsx` | 1: `import { type PendingInteractionAction, type PendingInteractionCard, pendingInteractionCards, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/components/RefChip.tsx` | 2: `import { type IssueReferenceModel, resolveIssueReference } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/components/SessionActionCard.tsx` | 2: `import { segmentOfferText } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/SessionCard.tsx` | 2: `import { agentColorHex, type DotTone, type SessionCardModel } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/SessionConversation.tsx` | 17: `import { chatActivity, composerState, defaultChatCapable, latestPendingQuestion, matchesQuestionInteraction, OPTIMISTIC_SEND_CEILING_MS, pendingAskFromState, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/components/SessionLifecycle.tsx` | 2: `import { type ExitedAction, exitedRecovery } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/SharedFiles.tsx` | 1: `import { isImagePath } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/TaskFiltersSheet.tsx` | 1: `import type { BoardFilter, IssuesOrdering } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/mobile/src/components/TaskSheet.tsx` | 3: `import { groupRelations, operationalState, presenceNote, sessionNeedsHuman, sessionTitle, subIssuesOf, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/components/TranscriptList.tsx` | 1: `import { type ChatBlock, failLine, formatChurn, latestPendingQuestion, type ParsedEnvelope, resultPreview, toolBatchTitle, toolRunFailures, toolVerdict, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/WorkIssueMenu.tsx` | 2: `import { discoveredPlacement, type IssueNavigationModel } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/components/WorkRowParts.tsx` | 1: `import { deriveFleetPresence, deriveGitStamp, FLEET_KIND_LIMIT, type MissionProgress, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/spine.tsx` | 1: `import { type CollapsedSummary, type DeckIssueState, type IssueNote, type PresenceNote, type SessionRole, sessionSettled, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/task-detail/IssueActivity.tsx` | 3: `import { type ActivityEntry, type ActivityItem, eventClock, groupActivityFeed, type IssueEventIcon, type IssueEventLine, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/task-detail/IssueAgentPanel.tsx` | 3: `import { artifactKind } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/components/task-detail/IssueBanners.tsx` | 2: `import { ISSUE_STAGE_LABELS } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/task-detail/IssueNow.tsx` | 2: `import { motionPhase, sessionTitle } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/task-detail/IssueProperties.tsx` | 2: `import { groupRelations, ISSUE_STAGE_LABELS, type IssueEdge, sessionTitle, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/components/task-detail/IssueSubIssues.tsx` | 2: `import { confirmedWorkingAgentCountsByIssue, taskStateWord } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/hooks/usePendingQuestion.ts` | 1: `import { latestPendingQuestion } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/lib/configured-issue-launch.ts` | 1: `import { spawnIssueAgent } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/lib/deck-rows.ts` | 1: `import { type FlightDeckFoldMap, type FlightDeckRow, flightDeckRowIsFolded, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/lib/issue-artifacts.ts` | 2: `import { artifactKind, artifactUrl, basename } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/lib/issue-close.ts` | 1: `import { blockingCloseConcerns, type IssueCloseConcern, type IssueNavigationModel, issueCloseConcerns, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/lib/issue-detail.ts` | 2: `import type { ActivityComment, IssueEvent } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/mobile/src/lib/mission-session.ts` | 1: `import { sessionNeedsHuman } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/lib/task-board.ts` | 2: `import { type BoardFilter, boardIssues, filterBoardIssues, filterBoardScope, flattenRowGroups, type IssueRow, type IssuesOrdering, issueRowsByStage, orderIssues, partitionIssueTree, type TaskProgress, taskProgressMap, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/lib/transcript-feed.ts` | 1: `import { type ChatBlock, type ChatRow, computeTranscript, envelopePrincipal, formatChurn, isAskUserQuestion, isChosenOption, MACHINE_CONTEXT_RE, machineContextLabel, type ParsedEnvelope, parseAskQuestions, parseEnvelopeBatch, searchBlocks, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/lib/use-issue-detail.ts` | 2: `import { type ActivityComment, type ActivityItem, buildActivityFeed, type IssueEvent, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/lib/work-menu.ts` | 1: `import type { IssueNavigationModel } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/mobile/src/lib/work-sections.ts` | 1: `import { rowWaitingCount, type UnifiedIssueRow, type UnifiedWorkGroup, type UnifiedWorkRow, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/screens/InboxScreen.tsx` | 3: `import { pendingAskFromState, sessionCardModel } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/screens/IssueScreen.tsx` | 3: `import { resolveIssueEdge, subIssuesOf } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/screens/IssuesScreen.tsx` | 4: `import { type BoardFilter, clearChip, confirmedWorkingAgentCountsByIssue, filterChips, type IssueRow, readSharedIssuesDisplay as readMobileTaskDisplay, type TaskProgress, taskStateWord, writeSharedIssuesDisplay as writeMobileTaskDisplay, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/screens/MissionDetailsScreen.tsx` | 3: `import { type IssueNavigationModel, missionRootFor, missionSessions as missionSessionsOf, worklistSlice, } from '@podium/client-core/viewmodels'` | Contains slice/type API; any subscription is in the reader table |
| `apps/mobile/src/screens/MissionScreen.tsx` | 4: `import { isSessionWorking, type MissionProgress, missionCrewLabel, missionProgress, missionRootFor, missionSessions as missionSessionsOf, sessionNeedsHuman, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/screens/NewIssueScreen.tsx` | 2: `import { codingRoleHarness, ISSUE_STAGE_LABELS, reposToViews, repoUsageAt, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/screens/PulseScreen.tsx` | 1: `import { type AccountQuotaGroup, agentLabel, agentShortLabel, type CapacityView, capacityView, formatCostWeightRatio, formatReset, formatShare, formatTokens, formatUsd, formatWindowSpan, groupQuotaByAccount, type MachineOperationsView, modelLimitNote, percentTone, type QuotaLedgerView, type QuotaTone, quotaLedger, splitQuotaWindows, statusNote, type UsageDay, type UsageProvider, usageSummary, useGrantedHostMetrics, useGrantedMachineQuota, useGrantedQuotaHistory, visibleFleetOperations, windowElapsedPercent, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/screens/SessionScreen.tsx` | 2: `import { isDraftAgentVessel, sessionTitle } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/screens/SessionsScreen.tsx` | 3: `import { sessionCardModel } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/screens/SettingsScreen.tsx` | 2: `import { connectedDeviceViews, type MachineOperationsView, visibleFleetOperations, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/screens/SuperagentScreen.tsx` | 2: `import { matchesQuestionInteraction } from '@podium/client-core/viewmodels'`; 10: `import { buildImagePrompt, superagentSlice } from '@podium/client-core/viewmodels'` | Contains slice/type API; any subscription is in the reader table |
| `apps/mobile/src/screens/WorkListRow.tsx` | 19: `import { formatClock, type IssueNavigationModel, isDraftAgentVessel, type MissionProgress, rowHasWorkingSession, rowMotionPhase, rowMotionTiming, rowPendingDecision, rowUnreadEmphasized, rowWaitingCount, type UnifiedWorkRow, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/screens/WorkScreen.tsx` | 2: `import { type IssueNavigationModel, issueDisplayTitle, missionProgress, type MissionProgress, rowAwaitsTuck, rowCanBringBack, rowStatusLine, type UnifiedIssueRow, type UnifiedWorkRow, worklistSlice, reuseUnifiedWorkRows, } from '@podium/client-core/viewmodels'` | Contains slice/type API; any subscription is in the reader table |
| `apps/mobile/src/screens/capacity-refresh.ts` | 1: `import type { MachineCapacityReading, MachineCapacityReadings, } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/mobile/src/screens/session-absence.ts` | 18: `import { type ReferentState, resolveReferent } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/mobile/src/screens/usePulseFeed.ts` | 1: `import { type MachineCapacityReadings, machineViewsFromWire } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/mobile/src/terminal/TerminalPane.web.tsx` | 1: `import { resolveIssueReference } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/AppShell.tsx` | 6: `import { selectedMissionRoot } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/CommandPalette.tsx` | 1: `import type { IssueNavigationModel } from '@podium/client-core/viewmodels'`; 4: `import { issueReferenceModel, lastUsedMaps, panelLabel, type RepoNavView, reposToViews, resolveDefaultAgent, spawnTargetForRepo, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/FlightDeck.tsx` | 9: `import { archivedSessionsForIssue, buildFlightDeckRows, type CollapsedSummary, type DeckIssueState, type DeckState, deckIssueState, deckSessions, deckViewEmptyLine, type FlightDeckFoldMap, type FlightDeckFoldState, type FlightDeckMode, type FlightDeckRow, flightDeckRowDefaultFolded, flightDeckRowHasPayload, flightDeckRowIsFolded, type IssueContinuation, type IssueNavigationModel, type IssueNote, isCoordinatorSession, issueAbandoned, issueContinuation, issueDisplayTitle, issueNote, issueOwnContentUnread, type MissionDeparture, machineViewsFromWire, missionDepartures, missionIssueIds, missionProgress, missionRootFor, motionPhase, nativeSubagentRows, type PresenceNote, presenceNote, readFlightDeckFolds, reposToViews, reuseFlightDeckRows, type SessionRole, selectedMissionRoot, sessionAsksOnIssue, sessionNeedsHuman, sessionRole, sessionSettled, sessionUnreadEmphasized, continuationPresenceLine as sharedContinuationPresenceLine, spawnIssueAgent, subtreeUnread, treeGuides, writeFlightDeckFolds, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/FlightDeckHandoff.tsx` | 2: `import { deriveHandoffNext, deriveHandoffNow, missionSessions, reviewReturnCount, summarizeHandoffSessions, type HandoffNowEntry, type HandoffTranscriptPair, type IssueNavigationModel, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/FlightDeckWaterfall.tsx` | 7: `import { deckSessions, type FlightDeckMode, type FlightDeckRow, isCoordinatorSession, nativeSubagentRows, sessionAsksOnIssue, sessionSettled, sessionUnreadEmphasized, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/FoldedFlightDeckBar.tsx` | 5: `import { buildFlightDeckRows, type MissionProgress, missionCrewLabel, missionProgress, selectedMissionRoot, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/MissionCostChip.tsx` | 2: `import { COST_HEDGE, costHarnessLabel, formatCostExact, formatCostMark, formatCostWeightRatio, formatCount, formatTokens, type TaskCostView, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/MissionGauge.tsx` | 1: `import { type missionProgress, missionCrewLabel } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/app/NewPanelMenu.tsx` | 3: `import type { RecentFileEntry, RepoView, WorktreeView } from '@podium/client-core/viewmodels'`; 4: `import { reposToViews } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/RightDock.tsx` | 2: `import { cwdInWorktree, issueForCwd, reposToViews, resolveActiveWorktree, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/RightRail.tsx` | 5: `import { cwdInWorktree, issueForCwd, reposToViews, resolveActiveWorktree, shippingPanelModel, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/StatusPerformanceStats.tsx` | 1: `import { bucketCostUsd } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/app/StatusStrip.tsx` | 1: `import { issueReferenceModel } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/app/Workspace.tsx` | 5: `import type { Pane, WorktreeView } from '@podium/client-core/viewmodels'`; 6: `import { allTabIds, emptyWorkspace, isCoordinatorSession, missionIssueIds, missionRootFor, orphanSessionFor, reposToViews, resizeSplit, type SplitAxis, selectedMissionRoot, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/command-palette.ts` | 32: `import type { IssueReferenceModel } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/app/flight-deck-display.ts` | 1: `import type { IssueNavigationModel } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/app/flight-deck-waterfall.ts` | 2: `import { motionPhase, sessionNeedsHuman, sessionSettled } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/app/panel-deck.ts` | 2: `import type { PaneId, SplitAxis, SplitNode, TabId, WorkspaceLayout, } from '@podium/client-core/viewmodels'`; 9: `import { paneOfTab } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/app/store.tsx` | 34: `import { attachWorklistPool } from './store-worklist-pool' /** The web store: the shared store, with `trpc` carrying the full AppRouter type. */ export type Store = CoreStore<Trpc> export type { IssueViewModel, UserFocus } from '@podium/client-core/react' export type { MainView } from '@podium/client-core/router' export type { FileTab } from '@podium/client-core/viewmodels'`; 43: `import type { SliceDefinition } from '@podium/client-core/viewmodels'` | Contains slice/type API; any subscription is in the reader table |
| `apps/web/src/app/use-desktop-close-tab.ts` | 2: `import { allTabIds, emptyWorkspace, focusedPane } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/app/use-handoff-transcript.ts` | 3: `import { pairLatestPromptAndAnswer, parseEnvelopeBatch, selectLatestPromptSession, type HandoffTranscriptPair, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/components/GitStamp.tsx` | 1: `import { deriveGitStamp } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/components/IssueFleetSummary.tsx` | 33: `import { deriveFleetPresence, FLEET_KIND_LIMIT } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/components/IssueReference.tsx` | 1: `import { resolveIssueReference, type IssueReferenceModel as IssueReferenceView } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/components/RefMiniview.tsx` | 5: `import { type IssueReferenceModel, issueReferenceModel } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/automations/NewAutomationDialog.tsx` | 2: `import { machineViewsFromWire } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/automations/automation-form.ts` | 32: `import { type MachineAvailability, type MachineView, repoUsageAt, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/AskUserQuestionCard.tsx` | 1: `import { type AskAnswerChoice, type AskQuestion, isChosenOption, isPreviewLayout, optionPreview, parseAskQuestions, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/AttributionMark.tsx` | 1: `import type { TranscriptAttribution } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/chat/ChatBlockView.tsx` | 1: `import { formatChurn, isImagePath, isInteractiveTool, MACHINE_CONTEXT_RE, mcpLabel, parseEnvelopeBatch, type TranscriptAttribution, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/ChatRail.tsx` | 1: `import type { ChatRow } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/chat/ChatView.tsx` | 2: `import type { SuperThreadRef } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/chat/MachineContextRow.tsx` | 1: `import { machineContextLabel } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/MessageEnvelopeGroup.tsx` | 17: `import { envelopePrincipal, type ParsedEnvelope } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/MessageNotices.tsx` | 11: `import { type MessageNotice, messageNotices } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/chat/OfferArtifactStrip.tsx` | 3: `import { artifactKind, artifactUrl, basename } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/chat/OfferText.tsx` | 1: `import { segmentOfferText } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/PendingInteractionBar.tsx` | 2: `import { pendingInteractionCards } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/chat/SendUserFileBlock.tsx` | 1: `import { isImagePath } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/ToolBatchView.tsx` | 1: `import { formatClock, resolveToolEdit, toolEditUnifiedDiff } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/ToolBlock.tsx` | 2: `import { resolveToolEdit } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/ToolEditDiff.tsx` | 1: `import { type ToolEditLine, type ToolEditView, toolEditLines, toolEditMagnitude, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/TranscriptFeed.tsx` | 2: `import type { ChatActivity, ChatBlock, ChatRow, RenderableRow, TranscriptAttributionTable, TranscriptPhase, TranscriptSearchState, } from '@podium/client-core/viewmodels'`; 11: `import { attributionForRole, isInteractiveTool, sessionWaking, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/TranscriptSearchBar.tsx` | 1: `import type { TranscriptSearchState } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/chat/TranscriptStandby.tsx` | 2: `import { panelLabel } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/TranscriptTail.tsx` | 2: `import { type ChatActivity, type ChatRow, formatClock, toolCallPhrase, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/chat.ts` | 2: `import type { ChatRow } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/chat/issue-chip-refs.ts` | 1: `import type { IssueReferenceSource } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/chat/transcript-compute-client.ts` | 1: `import { computeTranscript, transcriptSearchState, type TranscriptComputeInput, type TranscriptComputeResult, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/transcript-compute.worker.ts` | 1: `import { computeTranscript, parseEnvelopeBatch, transcriptSearchState, type TranscriptComputeInput, type TranscriptComputeResult, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/transcript-time.ts` | 1: `import type { ChatRow } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/chat/use-chat-send.ts` | 11: `import type { ChatBlock, ChatSendRoute, ComposerState, SuperThreadRef, } from '@podium/client-core/viewmodels'`; 17: `import { chatSendRoute, OPTIMISTIC_SEND_CEILING_MS } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/chat/use-chat-surface.ts` | 8: `import { type AskAnswerChoice, type ChatActivity, type ChatRow, type ChatSessionReference, type ChatVerbosity, type ComposerState, chatActivityState, chatSessionReference, composerState, isOperatorPrompt as isOperatorPromptOf, isOperatorPromptRow as isOperatorPromptRowOf, lastAnswer as lastAnswerOf, livePendingAskIndex as livePendingAskIndexOf, type OperatorPromptOptions, parseEnvelopeBatch, pendingAskFromState, matchesQuestionInteraction, type RenderableRow, renderableRows, type SuperThreadRef, type TranscriptAttributionTable, type TranscriptPhase, type TranscriptSearchState, transcriptAttributionTable, transcriptPhase, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/chat/use-headless-turn.ts` | 2: `import type { ChatSendRoute, SuperThreadRef } from '@podium/client-core/viewmodels'`; 3: `import { UNKNOWN_THREAD_REFUSAL } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/chat/use-transcript-reveal.ts` | 1: `import type { ChatRow } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/chat/useTranscriptWindow.ts` | 8: `import { applyChatVerbosity, type ChatVerbosity } from '@podium/client-core/viewmodels'`; 10: `import type { TranscriptSearchState } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/cost/TaskCostSection.tsx` | 38: `import { COST_HEDGE, type CostAmount, type SessionCostView, type TaskCostView, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/cost/cost-format.ts` | 34: `import { costHarnessLabel, formatCostExact, formatCostRounded, formatCostWeightRatio, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/cost/useMissionCost.ts` | 1: `import { costCohort, type TaskCostView, taskCostView } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/cost/useTaskCost.ts` | 31: `import { costCohort, type TaskCostView, taskCostView } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/files/AssetFilePanel.tsx` | 1: `import type { FileScope } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/files/DownloadFileButton.tsx` | 1: `import type { FileScope } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/files/FilePanel.tsx` | 1: `import type { FileScope } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/files/HtmlFilePanel.tsx` | 8: `import { type FileScope, scopeKey } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/files/JsonFilePanel.tsx` | 11: `import { type FileScope, scopeKey } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/files/MarkdownFilePanel.tsx` | 10: `import { type FileScope, scopeKey } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/files/OpenInBrowserButton.tsx` | 1: `import type { FileScope } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/files/TableFilePanel.tsx` | 2: `import type { FileScope } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/files/WorktreeFileTree.tsx` | 2: `import { basename } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/files/open-in-browser.ts` | 1: `import type { FileScope } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/files/useFileDocument.ts` | 2: `import { type FileScope, scopeKey } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/IssueCompactControls.tsx` | 3: `import { discoveredPlacement, issueNeedsHuman, motionPhase, type ProposalPlacement, sessionNeedsHuman, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/IssueContextMenu.tsx` | 1: `import type { IssueNavigationModel } from '@podium/client-core/viewmodels'`; 3: `import { discoveredPlacement, type ProposalPlacement, reposToViews, spawnIssueAgent, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/IssuePanelView.tsx` | 3: `import { artifactKind, artifactUrl, basename, buildActivityFeed, deckDestinationFor, groupRelations, type IssueEvent, issueDisplayTitle, issueForPanel, operationalState, type PresenceKind, type PresenceNote, presenceNote, reposToViews, sessionNeedsHuman, subIssuesOf, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/NewIssueDialog.tsx` | 2: `import { type RepoView, reposToViews, repoUsageAt } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/explorer/IssueExplorerList.tsx` | 3: `import { operationalState } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/explorer/explorer-context.tsx` | 2: `import { missionIssueIds, selectedMissionRoot } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/explorer/explorer-list.ts` | 2: `import { filterBoardScope, issueIsActionable } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-card.ts` | 1: `import { ISSUE_STAGE_LABELS, rankedTaskStateSlots, taskAheadCount, taskStateWord, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-context-menu.ts` | 2: `import type { IssueNavigationModel } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/issues/issue-hierarchy.ts` | 1: `import { type IssueRow as CoreIssueRow, flattenRowGroups as coreFlattenRowGroups, issueRowsByStage as coreIssueRowsByStage, partitionIssueTree as corePartitionIssueTree, } from '@podium/client-core/viewmodels'`; 9: `import type { IssuesOrdering } from './issues-display' /** * The hierarchical issue-tracker view (#85), typed for this app. * * THE DERIVATION ITSELF NOW LIVES IN CLIENT-CORE (POD-724). `partitionByParent`, * `partitionIssueTree`, `issueRowsByStage` and `flattenRowGroups` moved to * `@podium/client-core/viewmodels/issue-board-rows` unchanged, because the phone's * Tasks tab has to show the same rows in the same order and could not while they * were typed over `IssueViewModel`. What stays here is the `IssueViewModel`-shaped * façade — same names, same signatures, so no call site or test in this app * changed — plus the two derivations that genuinely read desktop-only fields. */ export { partitionByParent } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-lifecycle.tsx` | 2: `import type { IssueNavigationModel } from '@podium/client-core/viewmodels'`; 3: `import { blockingCloseConcerns, type IssueCloseConcern, issueCloseConcerns, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/issue-list.ts` | 1: `import { groupIssuesByStage as coreGroupIssuesByStage, flattenStageGroups, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-menu-commands.ts` | 1: `import { spawnIssueAgent } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-menu-config.ts` | 1: `import type { IssueNavigationModel } from '@podium/client-core/viewmodels'`; 2: `import { discoveredPlacement, type ProposalShape } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-menu-palette.ts` | 2: `import { reposToViews } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-page-commands.ts` | 15: `import type { ActivityComment, IssueEvent, RelationEntry } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/issues/issue-page-model.ts` | 10: `import { type ActivityComment, type ActivityItem, buildActivityFeed, type IssueEvent, subIssuesOf, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/issue-page/IssueActivity.tsx` | 31: `import { type ActivityDay, type ActivityEntry, type ActivityItem, eventClock, eventStamp, groupActivityFeed, type IssueEventIcon, type IssueEventLine, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-page/IssueAgentActivity.tsx` | 43: `import { artifactKind, artifactUrl, basename } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/issue-page/IssueDetailHeader.tsx` | 13: `import { motionPhase } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/issue-page/IssueNow.tsx` | 30: `import { motionPhase, motionTiming } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-page/IssueParentRow.tsx` | 35: `import type { IssueEdge } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/issues/issue-page/IssueRelations.tsx` | 28: `import { groupRelations } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-page/IssueSessionsBlock.tsx` | 31: `import { motionPhase, motionTiming } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issue-page/issue-edges.tsx` | 56: `import type { CrossBoundaryPolicy, IssueEdge } from '@podium/client-core/viewmodels'`; 57: `import { type ReferentExit, resolveIssueEdge } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/issues/issues-display.ts` | 2: `import { confirmedWorkingAgentCount as coreConfirmedWorkingAgentCount, confirmedWorkingAgentCountsByIssue as coreConfirmedWorkingAgentCountsByIssue, orderIssues as coreOrderIssues, readSharedIssuesDisplay, type TaskProgress, taskProgressMap, type IssuesOrdering, writeSharedIssuesDisplay, } from '@podium/client-core/viewmodels'`; 13: `import type { IssueViewModel } from '@/app/store' export type IssuesLayout = 'board' | 'list' /** Ordering is the SHARED vocabulary now (POD-724) — the phone's Tasks tab reads * the same union and calls the same comparator. */ export type { IssuesOrdering } export interface IssuesDisplay { layout: IssuesLayout ordering: IssuesOrdering /** Show internal (audience: 'agent') issues at top level (issue-as-workspace). * Default OFF — internal tasks only surface as children under their (visible, * human-audience) parent. */ showAgentTasks: boolean badges: { labels: boolean; type: boolean; estimate: boolean; due: boolean; sessions: boolean } } export { ISSUES_DISPLAY_KEY as DISPLAY_KEY } from '@podium/client-core/ui-state' export const DEFAULT_DISPLAY: IssuesDisplay = { layout: 'board', // Priority-first by default: the board's job is triage, so the most urgent // work sits at the top of each stage column. `updated` also churned the // columns every time an agent touched an issue; priority + seq holds still. ordering: 'priority', showAgentTasks: false, badges: { labels: true, type: true, estimate: true, due: true, sessions: true }, } const LAYOUTS = new Set<string>(['board', 'list']) /** Parse a persisted display-options blob, falling back field-by-field so a * stale or hand-edited value never breaks the view. */ export function readIssuesDisplay(raw: string | null): IssuesDisplay { const shared = readSharedIssuesDisplay(raw) const o = shared.source const badges = (typeof o.badges === 'object' && o.badges != null ? o.badges : {}) as Record< string, unknown > const badge = (k: keyof IssuesDisplay['badges']): boolean => typeof badges[k] === 'boolean' ? (badges[k] as boolean) : DEFAULT_DISPLAY.badges[k] return { layout: LAYOUTS.has(String(o.layout)) ? (o.layout as IssuesLayout) : DEFAULT_DISPLAY.layout, ordering: shared.ordering, showAgentTasks: shared.showAgentTasks, badges: { labels: badge('labels'), type: badge('type'), estimate: badge('estimate'), due: badge('due'), sessions: badge('sessions'), }, } } export function writeIssuesDisplay(d: IssuesDisplay): string { return writeSharedIssuesDisplay({ ordering: d.ordering, showAgentTasks: d.showAgentTasks, source: { ...d }, }) } // The board scope filter is platform-neutral and lives in client-core so the // phone board derives from the same predicate (POD-338). export { boardIssues, filterBoardScope } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/issues-view-model.ts` | 2: `import { filterBoardScope } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/issues/use-agent-fleet-options.ts` | 21: `import { type RepoView, reposToViews } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/machines/HostIndicators.tsx` | 8: `import { createHostSessionAggregatesSelector, hostAgentsViewFromCounts, hostLoadView, hostMemoryView, listReclaimableWorktreesClient, occupiedRootsFromKey, placeReclaimable, RECLAIMABLE_WORKTREE_THRESHOLD, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/machines/HostMemoryView.tsx` | 2: `import { formatMemBytes, hostMemoryView, panelLabel, reclaimSpaceLabel, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/machines/LoadPanel.tsx` | 4: `import { DEFAULT_LOAD_PER_CORE, formatMemBytes, hostDiskView, hostLoadView, hostMemoryView, createHostSessionAggregatesSelector, panelLabel, reclaimSpaceLabel, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/machines/QuotaIndicator.tsx` | 4: `import { type AccountQuotaGroup, agentLabel, agentShortLabel, formatReset, groupQuotaByAccount, modelLimitNote, paceHint, paceLabel, percentTone, type QuotaPace, type QuotaTone, splitQuotaWindows, statusNote, windowElapsedPercent, windowPace, windowScopeModel, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/machines/QuotaPanel.tsx` | 1: `import { type AccountQuotaGroup, agentLabel, formatReset, groupGatingPace, paceLabel, percentTone, type QuotaPace, quotaPoolVerdict, splitQuotaWindows, statusNote, windowElapsedPercent, windowScopeModel, windowShortLabel, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/machines/useQuotaSurge.ts` | 1: `import { quotaSurge } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/merge-queue/merge-queue-model.ts` | 2: `import { issuePendingDecision } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/setup/ColdStartComposer.tsx` | 4: `import { AGENT_NOT_READY_COPY, activationAgentIsReady, activationAgentReadiness, launchAgentKind, machineViewsFromWire, reposToViews, createRepositoryUsageSelector, indexedRepoUsageAt, type RepoView, resolveDefaultAgent, usableMachines, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/setup/FirstTaskActivation.tsx` | 3: `import { type ActivationAgentReadiness, activationAgentIsInstalled, activationAgentIsReady, activationAgentReadiness, activationReadinessCopy, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/shipping/ShippingPanel.tsx` | 1: `import { shippingActivityLabel, shippingElapsed, shippingPanelModel, type ShippingPanelRow, type ShippingWaitingLane, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/superagent/SuperagentView.tsx` | 2: `import { superagentSlice, threadById } from '@podium/client-core/viewmodels'` | Contains slice/type API; any subscription is in the reader table |
| `apps/web/src/features/superagent/concierge.ts` | 2: `import { reposToViews } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/terminal/AgentPanel.tsx` | 9: `import { formatClock, panelLabel, resolveIssueReference, resumeCommand, sessionWaking, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/terminal/DockShellPanel.tsx` | 3: `import { resolveIssueReference } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/terminal/SessionLifecyclePanes.tsx` | 18: `import { exitedRecovery } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/terminal/lifecycle-actions.ts` | 27: `import type { ExitedAction } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/terminal/panel-surface.ts` | 41: `import type { TerminalOutlook } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/terminal/use-panel-surface.ts` | 33: `import { defaultChatCapable, sessionTerminalOutlook, type TerminalOutlook, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/usage/QuotaLedger.tsx` | 1: `import { formatWindowDuration, type QuotaLedgerColumn, type QuotaLedgerStrip, type QuotaLedgerView, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/usage/UsageTasks.tsx` | 1: `import { formatCostWeightRatio, formatCount, formatShare, formatUsd, formatUsdExact, ISSUE_STAGE_LABELS, RATE_COHORT_MIN_REPLIES, type TaskCostRowView, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/usage/UsageView.tsx` | 1: `import { formatCostWeightRatio, formatCount, formatHour, formatShare, formatTick, formatTokens, formatUsd, formatUsdTick, formatWindowSpan, niceAxisMax, type UsageProvider, type UsageSummaryView, usageSummary, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/usage/useQuotaLedger.ts` | 1: `import { type QuotaLedgerView, quotaLedger } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/usage/useTaskCosts.ts` | 1: `import { type CostCohort, type TaskCostRowView, taskCostRows } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/workflows/ExecutionProfiles.tsx` | 28: `import { machineViewsFromWire, placementOptions, profilePlacement, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/workflows/RunProgress.tsx` | 29: `import { currentStepOf, runAdvances, runAttribution, runSubjectReference, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/workflows/WorkflowLibrary.tsx` | 16: `import { workflowLibraryEntries, workflowRevisionDetail, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/worklist/FoldedRowMenu.tsx` | 1: `import type { IssueNavigationModel } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/worklist/ManageProjectsDialog.tsx` | 2: `import { mergeVisibleProjectOrder } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/worklist/SidebarRail.tsx` | 75: `import { type MotionPhase, rowMotionPhase, rowStatusLine, rowWaitingCount, type UnifiedIssueRow, type UnifiedWorkRow, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/worklist/SidebarUnified.tsx` | 1: `import { type IssueNavigationModel, isDraftAgentVessel, issueDisplayTitle, type MissionProgress, missionProgress, orderProjectItems, placeWorklistSelection, planReorderKeys, type RepoNavView, reuseUnifiedWorkRows, rowAwaitsTuck, rowCanBringBack, type UnifiedIssueRow as UnifiedIssueRowView, type UnifiedWorkRow, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/worklist/UnifiedIssueRow.tsx` | 2: `import { type IssueNavigationModel, isDraftAgentVessel, issueDisplayTitle, type MissionProgress, missionProgress, pendingDecisionTitle, rowErrorLine, rowHasWorkingSession, rowMotionPhase, rowMotionTiming, rowPendingDecision, rowStatusLine, rowUnreadEmphasized, type UnifiedIssueRow as UnifiedIssueRowView, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/worklist/UnifiedWorktreeRow.tsx` | 2: `import { type IssueNavigationModel, partitionStaleSessions, type UnifiedWorkRow, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/worklist/WorkRowShell.tsx` | 1: `import type { MotionPhase } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/worklist/derivation.ts` | 10: `import { type WorklistSlice, worklistSlice } from '@podium/client-core/viewmodels'` | Contains slice/type API; any subscription is in the reader table |
| `apps/web/src/features/worklist/pool-row-data.ts` | 2: `import { errorPhrase, type IssueNavigationModel, type UnifiedIssueRow, type UnifiedWorkRow, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/worklist/pool-sidebar-rail.tsx` | 3: `import { agentBadge, type MotionPhase, mostUrgentSession } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/worklist/pool-sidebar.tsx` | 5: `import { type IssueNavigationModel, issueClosedFoldAt, planReorderKeys, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/worklist/row-progress.tsx` | 112: `import type { MissionProgress } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/features/worklist/sidebar-common.tsx` | 10: `import { agentBadge, agentColorHex, isSessionWorking, sessionIssueLinkage, } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/worklist/time-indicators.tsx` | 10: `import { isSessionWorking } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/worklist/use-pool-unified-work.ts` | 4: `import { pickPaneSession } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/features/worklist/use-sidebar-projects.ts` | 4: `import { type SidebarProject, type SidebarSections, worklistSlice, } from '@podium/client-core/viewmodels'` | Contains slice/type API; any subscription is in the reader table |
| `apps/web/src/features/worklist/use-unified-work.ts` | 16: `import { type IssueNavigationModel, missionIssueIds, missionRootFor, pickPaneSession, type RepoNavView, sessionsForIssueNav, sessionsForWorktree, worklistSlice, } from '@podium/client-core/viewmodels'` | Contains slice/type API; any subscription is in the reader table |
| `apps/web/src/features/worklist/work-filter.ts` | 22: `import { rowStatusLine, type UnifiedWorkRow } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/worklist/work-folds.tsx` | 2: `import { type IssueNavigationModel, issueClosedFoldAt, type UnifiedIssueRow as UnifiedIssueRowView, type UnifiedWorkRow, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/features/worklist/work-search.tsx` | 18: `import type { UnifiedWorkRow } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/lib/SessionContextMenu.tsx` | 3: `import { reposToViews } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/lib/WorkerLabel.tsx` | 2: `import { isUnstartedSession, panelLabel } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/lib/agent-capability.tsx` | 48: `import { type AgentRowStatus, agentFleetStatus, spawnAgentLabel as agentLabel, candidateFromAvailability, agentCapabilityHint as capabilityHint, agentCapabilityReason as capabilityReason, agentLoginWarning as loginWarning, SIGNED_OUT_HINT, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/lib/asset-url.ts` | 1: `import type { FileScope } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/lib/derive.ts` | 1: `import type { SessionView } from '@podium/client-core/session-values' /** * The web-side status-dot classname helper. * * This module used to also carry `export * from '@podium/client-core/viewmodels'`; 18: `import { type DotTone, sessionDotTone } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/lib/hooks/use-session-guard.ts` | 2: `import { isSessionWorking } from '@podium/client-core/viewmodels'` | Value/type helper API; source reader listed above |
| `apps/web/src/lib/issue-chip-liveness.ts` | 1: `import { type IssueReferenceModel, type IssueReferenceSource, canonicalIssueRef, issueReferenceModel, } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/lib/motion/AgentStatusGlyph.tsx` | 16: `import { motionPhase } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/lib/motion/MotionDemo.tsx` | 1: `import type { MotionPhase } from '@podium/client-core/viewmodels'` | Type only; no runtime store read |
| `apps/web/src/lib/motion/PhaseTimer.tsx` | 22: `import { formatClock, type MotionPhase } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |
| `apps/web/src/lib/session-context-menu.ts` | 2: `import { panelLabel } from '@podium/client-core/viewmodels'` | Value/type or pure derivation API; supplied inputs, no store/access hook call found here |

## Complete raw-match appendix

Union of the requested and extended scans, including every test, harness, fixture, comment-only hit and independent snapshot source. Line numbers are a lossless file-level index of all matches; the reproduction commands print the exact lines. Production entries expand into the reader/import tables or the independent-source explanation above. These raw counts must not be advertised as runtime reader counts.

| File | Matching line numbers | Census class |
| --- | --- | --- |
| `apps/mobile/app/session/[sessionId]/terminal.tsx` | 1 | Production reader/access module (expanded above) |
| `apps/mobile/src/client/MobileClientProvider.tsx` | 23, 44, 704 | Production reader/access module (expanded above) |
| `apps/mobile/src/client/MobileSyncBoundary.tsx` | 59 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/mobile/src/client/demo-mode.test.tsx` | 15, 16, 62 | Test/performance/support |
| `apps/mobile/src/client/demoData.ts` | 405 | Fixture/prose |
| `apps/mobile/src/client/hooks.ts` | 29, 30, 54, 57, 63, 111, 112, 116, 117, 122, 127, 132, 143, 148, 153, 157, 163, 167, 203, 209, 225, 234, 242, 286 | Production reader/access module (expanded above) |
| `apps/mobile/src/client/mobile-replica.test.ts` | 1154, 1156, 1166, 1204, 1215 | Test/performance/support |
| `apps/mobile/src/client/mobile-slices.test.tsx` | 23, 28, 94 | Test/performance/support |
| `apps/mobile/src/client/mobile-sync-progress.test.ts` | 15, 23, 37, 40, 46, 49, 51, 84, 92, 95, 109, 125, 127, 131, 133, 138 | Test/performance/support |
| `apps/mobile/src/client/mobile-sync-progress.ts` | 60 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/mobile/src/client/shell.tsx` | 62 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/mobile/src/client/test-support.tsx` | 6, 21, 172 | Test/performance/support |
| `apps/mobile/src/client/trpc.ts` | 10 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/AskQuestionCard.tsx` | 6 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/ConfiguredIssueLaunchSheet.tsx` | 7, 42 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/IssueCloseSheet.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/IssueColorSheet.tsx` | 1, 10, 37 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/LaunchConfigurationFields.tsx` | 3, 7, 53 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/MessageNoticeBanner.tsx` | 1, 3, 24 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/MissionDeck.tsx` | 33, 67 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/NewWorkButton.tsx` | 2, 21, 28, 99, 102 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/OutboxRecoveryPanel.test.tsx` | 18 | Test/performance/support |
| `apps/mobile/src/components/OutboxRecoveryPanel.tsx` | 17, 28, 184 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/PendingInteractionBand.test.tsx` | 8, 25 | Test/performance/support |
| `apps/mobile/src/components/PendingInteractionBand.tsx` | 5, 10, 42, 45 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/RefChip.tsx` | 2 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/SessionActionCard.tsx` | 2 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/SessionCard.tsx` | 2 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/SessionConversation.tsx` | 10, 25, 43, 158, 189, 244, 267, 371 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/SessionLifecycle.tsx` | 2 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/SharedFiles.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/ShellErrorBanner.test.tsx` | 17, 51 | Test/performance/support |
| `apps/mobile/src/components/TaskFiltersSheet.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/TaskSheet.artifact.test.tsx` | 109 | Test/performance/support |
| `apps/mobile/src/components/TaskSheet.tsx` | 10, 24, 193 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/TranscriptList.pending-ask.test.tsx` | 86 | Test/performance/support |
| `apps/mobile/src/components/TranscriptList.tsx` | 11 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/WorkIssueMenu.tsx` | 2, 12, 58 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/WorkRowParts.tsx` | 6 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/WorkspaceContinuityNotice.tsx` | 4, 19 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/spine.tsx` | 8 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/task-detail/GitReviewSection.tsx` | 5, 42 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/task-detail/IssueActivity.tsx` | 10, 44 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/task-detail/IssueAgentPanel.tsx` | 3 | Production reader/access module (expanded above) |
| `apps/mobile/src/components/task-detail/IssueBanners.tsx` | 2 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/task-detail/IssueNow.tsx` | 2 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/task-detail/IssueProperties.tsx` | 7 | Production helper/type import (expanded above) |
| `apps/mobile/src/components/task-detail/IssueSubIssues.tsx` | 2 | Production helper/type import (expanded above) |
| `apps/mobile/src/hooks/ReducedMotionProvider.web.tsx` | 15, 37 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/mobile/src/hooks/usePendingQuestion.ts` | 1 | Production reader/access module (expanded above) |
| `apps/mobile/src/lib/configured-issue-launch.ts` | 1 | Production helper/type import (expanded above) |
| `apps/mobile/src/lib/deck-rows.test.ts` | 1 | Test/performance/support |
| `apps/mobile/src/lib/deck-rows.ts` | 5 | Production helper/type import (expanded above) |
| `apps/mobile/src/lib/issue-artifacts.ts` | 2 | Production helper/type import (expanded above) |
| `apps/mobile/src/lib/issue-close.ts` | 6 | Production helper/type import (expanded above) |
| `apps/mobile/src/lib/issue-detail.ts` | 2 | Production helper/type import (expanded above) |
| `apps/mobile/src/lib/mission-session.ts` | 1 | Production helper/type import (expanded above) |
| `apps/mobile/src/lib/task-board.test.ts` | 3, 10 | Test/performance/support |
| `apps/mobile/src/lib/task-board.ts` | 15 | Production helper/type import (expanded above) |
| `apps/mobile/src/lib/transcript-feed.ts` | 15 | Production helper/type import (expanded above) |
| `apps/mobile/src/lib/use-issue-detail.ts` | 7 | Production reader/access module (expanded above) |
| `apps/mobile/src/lib/work-menu.test.ts` | 1 | Test/performance/support |
| `apps/mobile/src/lib/work-menu.ts` | 1 | Production helper/type import (expanded above) |
| `apps/mobile/src/lib/work-sections.test.ts` | 8 | Test/performance/support |
| `apps/mobile/src/lib/work-sections.ts` | 6 | Production helper/type import (expanded above) |
| `apps/mobile/src/screens/InboxScreen.tsx` | 3, 13, 50 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/IssueScreen.tsx` | 3, 23, 25, 193, 195 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/IssuesScreen.tsx` | 14, 27, 74 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/MissionDetailsScreen.tsx` | 2, 8, 12, 32, 37 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/MissionScreen.tsx` | 12, 19, 65 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/NewIssueScreen.selectors.test.tsx` | 4, 30, 31, 81, 90 | Test/performance/support |
| `apps/mobile/src/screens/NewIssueScreen.tsx` | 7, 12, 47 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/ProposalScreeningScreen.tsx` | 7, 60 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/PulseScreen.tsx` | 30 | Production helper/type import (expanded above) |
| `apps/mobile/src/screens/SessionScreen.tsx` | 2, 12, 17, 69, 70 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/SessionsScreen.tsx` | 3 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/SettingsScreen.tsx` | 6, 13, 47 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/SuperagentScreen.tsx` | 2, 3, 4, 10, 20, 22, 76, 77, 93, 129 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/WorkListRow.tsx` | 31 | Production helper/type import (expanded above) |
| `apps/mobile/src/screens/WorkScreen.memo.test.tsx` | 27, 28 | Test/performance/support |
| `apps/mobile/src/screens/WorkScreen.tsx` | 1, 14, 35, 146, 157 | Production reader/access module (expanded above) |
| `apps/mobile/src/screens/capacity-refresh.ts` | 4 | Production helper/type import (expanded above) |
| `apps/mobile/src/screens/normalized-issues.test.tsx` | 15, 199 | Test/performance/support |
| `apps/mobile/src/screens/session-absence.ts` | 18 | Production helper/type import (expanded above) |
| `apps/mobile/src/screens/usePulseFeed.ts` | 1 | Production reader/access module (expanded above) |
| `apps/mobile/src/terminal/TerminalPane.web.tsx` | 1 | Production reader/access module (expanded above) |
| `apps/mobile/src/terminal/terminal-pane.test.tsx` | 38, 145 | Test/performance/support |
| `apps/web/harness/coldstart-store.ts` | 150 | Harness/browser evidence |
| `apps/web/harness/deck-store-stub.ts` | 159, 163, 167, 183 | Harness/browser evidence |
| `apps/web/harness/explorer-entry.tsx` | 172 | Harness/browser evidence |
| `apps/web/harness/explorer-store.ts` | 128, 132, 136, 152 | Harness/browser evidence |
| `apps/web/harness/issue-page-store.ts` | 111, 115, 119, 135 | Harness/browser evidence |
| `apps/web/harness/loadpanel-store.ts` | 173, 174, 175, 176 | Harness/browser evidence |
| `apps/web/harness/mobile-promo-store.ts` | 11, 13 | Harness/browser evidence |
| `apps/web/harness/newtask-store.ts` | 116, 120, 124 | Harness/browser evidence |
| `apps/web/harness/offer-store-stub.ts` | 57, 61 | Harness/browser evidence |
| `apps/web/harness/pending-ask-entry.tsx` | 18 | Harness/browser evidence |
| `apps/web/harness/proto-live-entry.tsx` | 280, 322, 350, 581 | Harness/browser evidence |
| `apps/web/harness/quota-ledger-entry.tsx` | 14 | Harness/browser evidence |
| `apps/web/harness/quota-walkthrough-entry.tsx` | 14 | Harness/browser evidence |
| `apps/web/harness/setup-store.ts` | 74, 78, 84, 88 | Harness/browser evidence |
| `apps/web/harness/sidebar-acceptance-attribution.py` | 71 | Harness/browser evidence |
| `apps/web/harness/sidebar-acceptance.vite.ts` | 10, 11, 12 | Harness/browser evidence |
| `apps/web/harness/sidebar-store.ts` | 17, 271, 274, 275, 276 | Harness/browser evidence |
| `apps/web/harness/updates-store.ts` | 141, 143 | Harness/browser evidence |
| `apps/web/harness/usage-sheet-store-stub.ts` | 42 | Harness/browser evidence |
| `apps/web/harness/usage-tasks-entry.tsx` | 17 | Harness/browser evidence |
| `apps/web/harness/usage-tasks-fixture.ts` | 11 | Harness/browser evidence |
| `apps/web/src/app/AppShell.tsx` | 6, 98, 203, 259, 416, 440, 459, 460, 461, 462, 474, 477 | Production reader/access module (expanded above) |
| `apps/web/src/app/ApprovalDialog.tsx` | 6, 22 | Production reader/access module (expanded above) |
| `apps/web/src/app/AutoContinueDialog.tsx` | 13, 21 | Production reader/access module (expanded above) |
| `apps/web/src/app/BrowserOpenOverlay.test.tsx` | 30 | Test/performance/support |
| `apps/web/src/app/BrowserOpenOverlay.tsx` | 6, 60, 61 | Production reader/access module (expanded above) |
| `apps/web/src/app/CommandPalette.test.tsx` | 69, 70, 71 | Test/performance/support |
| `apps/web/src/app/CommandPalette.tsx` | 1, 12, 85, 102, 143, 268, 305 | Production reader/access module (expanded above) |
| `apps/web/src/app/CommandPaletteBoundary.test.tsx` | 10 | Test/performance/support |
| `apps/web/src/app/CommandPaletteBoundary.tsx` | 4, 18 | Production reader/access module (expanded above) |
| `apps/web/src/app/FlightDeck.departures.test.tsx` | 13 | Test/performance/support |
| `apps/web/src/app/FlightDeck.test.tsx` | 14, 45, 125, 165, 2732 | Test/performance/support |
| `apps/web/src/app/FlightDeck.tsx` | 59, 139, 190, 689, 1076, 1086, 2954, 2989 | Production reader/access module (expanded above) |
| `apps/web/src/app/FlightDeckHandoff.tsx` | 11, 20, 118 | Production reader/access module (expanded above) |
| `apps/web/src/app/FlightDeckWaterfall.tsx` | 16, 72, 251, 608, 1155 | Production reader/access module (expanded above) |
| `apps/web/src/app/FoldedFlightDeckBar.test.tsx` | 12, 14, 20 | Test/performance/support |
| `apps/web/src/app/FoldedFlightDeckBar.tsx` | 11, 19, 296, 300 | Production reader/access module (expanded above) |
| `apps/web/src/app/MachinesPanel.tsx` | 12, 157 | Production reader/access module (expanded above) |
| `apps/web/src/app/MissionCostChip.test.tsx` | 64 | Test/performance/support |
| `apps/web/src/app/MissionCostChip.tsx` | 11, 17, 101 | Production reader/access module (expanded above) |
| `apps/web/src/app/MissionGauge.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/app/NewPanelMenu.tsx` | 3, 4, 47, 141, 409 | Production reader/access module (expanded above) |
| `apps/web/src/app/RightDock.test.tsx` | 100, 101 | Test/performance/support |
| `apps/web/src/app/RightDock.tsx` | 7, 29, 124, 138 | Production reader/access module (expanded above) |
| `apps/web/src/app/RightRail.test.tsx` | 11, 12 | Test/performance/support |
| `apps/web/src/app/RightRail.tsx` | 11, 17, 125, 137 | Production reader/access module (expanded above) |
| `apps/web/src/app/StatusPerformanceStats.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/app/StatusStrip.test.tsx` | 74, 75 | Test/performance/support |
| `apps/web/src/app/StatusStrip.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/app/SyncLoader.tsx` | 165, 279 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/web/src/app/TopBar.sidebar-pilot.test.tsx` | 6 | Test/performance/support |
| `apps/web/src/app/Workspace.test.tsx` | 125, 126, 494 | Test/performance/support |
| `apps/web/src/app/Workspace.tsx` | 5, 17, 73, 257, 283, 288, 808, 1570 | Production reader/access module (expanded above) |
| `apps/web/src/app/command-palette.ts` | 32 | Production helper/type import (expanded above) |
| `apps/web/src/app/flight-deck-display.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/app/flight-deck-waterfall.test.ts` | 1 | Test/performance/support |
| `apps/web/src/app/flight-deck-waterfall.ts` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/app/header-data.ts` | 1, 9, 17, 19, 24, 35, 36, 50, 114 | Production reader/access module (expanded above) |
| `apps/web/src/app/new-panel-menu.test.tsx` | 73, 74 | Test/performance/support |
| `apps/web/src/app/optimistic-spawn.test.ts` | 6 | Test/performance/support |
| `apps/web/src/app/panel-deck.test.ts` | 1 | Test/performance/support |
| `apps/web/src/app/panel-deck.ts` | 8, 9 | Production helper/type import (expanded above) |
| `apps/web/src/app/routes.tsx` | 6, 54 | Production reader/access module (expanded above) |
| `apps/web/src/app/store-viewstate.test.tsx` | 107, 121 | Test/performance/support |
| `apps/web/src/app/store-worklist-pool.test.tsx` | 135, 199 | Test/performance/support |
| `apps/web/src/app/store-worklist-pool.ts` | 5, 117, 214, 231, 237 | Production reader/access module (expanded above) |
| `apps/web/src/app/store.optimistic-spawn.test.tsx` | 3, 66, 103, 105 | Test/performance/support |
| `apps/web/src/app/store.provider-identity.test.tsx` | 8, 60, 165, 181, 190, 194, 379, 383 | Test/performance/support |
| `apps/web/src/app/store.route-loop.test.tsx` | 85, 95 | Test/performance/support |
| `apps/web/src/app/store.selectors.test.tsx` | 18, 33, 49, 53, 58, 63, 139, 141, 190 | Test/performance/support |
| `apps/web/src/app/store.session-index.test.tsx` | 17, 71, 90, 104, 127 | Test/performance/support |
| `apps/web/src/app/store.tsx` | 21, 22, 23, 41, 43, 127, 128, 133, 143, 153, 161, 167, 169, 173, 176, 186, 187 | Production reader/access module (expanded above) |
| `apps/web/src/app/theme.tsx` | 6, 104 | Production reader/access module (expanded above) |
| `apps/web/src/app/use-desktop-close-tab.ts` | 2, 5, 19 | Production reader/access module (expanded above) |
| `apps/web/src/app/use-handoff-transcript.test.tsx` | 31 | Test/performance/support |
| `apps/web/src/app/use-handoff-transcript.ts` | 8, 11, 45 | Production reader/access module (expanded above) |
| `apps/web/src/components/GitStamp.tsx` | 1, 11 | Production helper/type import (expanded above) |
| `apps/web/src/components/IssueFleetSummary.tsx` | 33 | Production helper/type import (expanded above) |
| `apps/web/src/components/IssueReference.tsx` | 1, 2, 6, 27, 28, 34 | Production reader/access module (expanded above) |
| `apps/web/src/components/PodiumLinkHost.test.tsx` | 25, 26 | Test/performance/support |
| `apps/web/src/components/PodiumLinkHost.tsx` | 5, 73, 85 | Production reader/access module (expanded above) |
| `apps/web/src/components/RefMiniview.test.tsx` | 33, 37, 38 | Test/performance/support |
| `apps/web/src/components/RefMiniview.tsx` | 3, 5, 34, 73, 74, 81, 143, 554, 555, 573 | Production reader/access module (expanded above) |
| `apps/web/src/features/automations/AutomationsView.tsx` | 6, 18 | Production reader/access module (expanded above) |
| `apps/web/src/features/automations/NewAutomationDialog.test.tsx` | 22, 23 | Test/performance/support |
| `apps/web/src/features/automations/NewAutomationDialog.tsx` | 2, 6, 110 | Production reader/access module (expanded above) |
| `apps/web/src/features/automations/ScheduledSection.tsx` | 16, 304 | Production reader/access module (expanded above) |
| `apps/web/src/features/automations/automation-form.test.ts` | 1 | Test/performance/support |
| `apps/web/src/features/automations/automation-form.ts` | 21, 36 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/AskUserQuestionCard.tsx` | 8 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/AttributionMark.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/ChatBlockView.tsx` | 9 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/ChatComposer.test.tsx` | 25, 26 | Test/performance/support |
| `apps/web/src/features/chat/ChatComposer.tsx` | 7, 330 | Production reader/access module (expanded above) |
| `apps/web/src/features/chat/ChatRail.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/ChatView.drop.test.tsx` | 25, 32, 101, 119, 120, 125, 144 | Test/performance/support |
| `apps/web/src/features/chat/ChatView.header.test.tsx` | 88, 106, 107, 112 | Test/performance/support |
| `apps/web/src/features/chat/ChatView.headless.test.tsx` | 98, 120, 121, 126 | Test/performance/support |
| `apps/web/src/features/chat/ChatView.machine-offline.test.tsx` | 92, 111, 112, 117 | Test/performance/support |
| `apps/web/src/features/chat/ChatView.offline.test.tsx` | 78, 95, 96, 101 | Test/performance/support |
| `apps/web/src/features/chat/ChatView.partial-world.test.tsx` | 80, 101, 102, 107 | Test/performance/support |
| `apps/web/src/features/chat/ChatView.pending-ask.test.tsx` | 76, 92, 93, 98 | Test/performance/support |
| `apps/web/src/features/chat/ChatView.reactivation.test.tsx` | 95, 114, 115, 120 | Test/performance/support |
| `apps/web/src/features/chat/ChatView.test.tsx` | 86, 127, 145, 146, 151 | Test/performance/support |
| `apps/web/src/features/chat/ChatView.tsx` | 2, 9, 39, 217, 222 | Production reader/access module (expanded above) |
| `apps/web/src/features/chat/IssueChipLiveness.fallback.test.tsx` | 1, 17, 18 | Test/performance/support |
| `apps/web/src/features/chat/IssueChipLiveness.pool.test.tsx` | 9, 11 | Test/performance/support |
| `apps/web/src/features/chat/IssueChipLiveness.test.tsx` | 1, 22, 25 | Test/performance/support |
| `apps/web/src/features/chat/IssueChipLiveness.tsx` | 3, 5, 24, 38, 39, 42, 52, 53 | Production reader/access module (expanded above) |
| `apps/web/src/features/chat/MachineContextRow.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/MessageEnvelopeGroup.tsx` | 17 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/MessageNotices.tsx` | 11, 15, 34, 80 | Production reader/access module (expanded above) |
| `apps/web/src/features/chat/OfferArtifactStrip.test.tsx` | 66, 67 | Test/performance/support |
| `apps/web/src/features/chat/OfferArtifactStrip.tsx` | 3, 7, 35, 43 | Production reader/access module (expanded above) |
| `apps/web/src/features/chat/OfferText.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/PendingInteractionBar.test.tsx` | 11, 19, 68 | Test/performance/support |
| `apps/web/src/features/chat/PendingInteractionBar.tsx` | 2, 7, 48 | Production reader/access module (expanded above) |
| `apps/web/src/features/chat/SendUserFileBlock.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/ToolBatchView.test.tsx` | 20 | Test/performance/support |
| `apps/web/src/features/chat/ToolBatchView.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/ToolBlock.tsx` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/ToolEditDiff.tsx` | 6 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/TranscriptFeed.daymarks.test.ts` | 1 | Test/performance/support |
| `apps/web/src/features/chat/TranscriptFeed.motion.test.tsx` | 1 | Test/performance/support |
| `apps/web/src/features/chat/TranscriptFeed.tailslot.test.tsx` | 1 | Test/performance/support |
| `apps/web/src/features/chat/TranscriptFeed.tsx` | 10, 15 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/TranscriptFeed.turns.test.ts` | 1 | Test/performance/support |
| `apps/web/src/features/chat/TranscriptSearchBar.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/TranscriptStandby.tsx` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/TranscriptTail.test.tsx` | 1 | Test/performance/support |
| `apps/web/src/features/chat/TranscriptTail.tsx` | 7 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/TurnPreview.test.tsx` | 9 | Test/performance/support |
| `apps/web/src/features/chat/chat.ts` | 2, 8, 32, 89 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/imageInput.test.ts` | 1 | Test/performance/support |
| `apps/web/src/features/chat/issue-chip-refs.test.ts` | 1 | Test/performance/support |
| `apps/web/src/features/chat/issue-chip-refs.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/test-support/client-core-mock.ts` | 9 | Test/performance/support |
| `apps/web/src/features/chat/test-support/fake-store-handle.ts` | 25 | Test/performance/support |
| `apps/web/src/features/chat/transcript-compute-client.ts` | 6 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/transcript-compute.worker.ts` | 7 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/transcript-time.test.ts` | 1 | Test/performance/support |
| `apps/web/src/features/chat/transcript-time.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/transfer-items.ts` | 2 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/web/src/features/chat/use-chat-send.optimistic.test.ts` | 38, 43 | Test/performance/support |
| `apps/web/src/features/chat/use-chat-send.ts` | 16, 17, 36, 61, 362 | Production reader/access module (expanded above) |
| `apps/web/src/features/chat/use-chat-surface.ts` | 2, 34, 38, 60, 242, 268, 271, 559, 660 | Production reader/access module (expanded above) |
| `apps/web/src/features/chat/use-headless-turn.ts` | 2, 3 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/use-transcript-reveal.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/chat/useTranscriptWindow.ts` | 8, 10, 228, 667, 672, 697 | Production helper/type import (expanded above) |
| `apps/web/src/features/cost/TaskCostSection.test.tsx` | 1, 230 | Test/performance/support |
| `apps/web/src/features/cost/TaskCostSection.tsx` | 43, 65 | Production helper/type import (expanded above) |
| `apps/web/src/features/cost/cost-format.ts` | 4, 5, 14, 39, 77 | Production helper/type import (expanded above) |
| `apps/web/src/features/cost/rate-oracle.test.ts` | 1 | Test/performance/support |
| `apps/web/src/features/cost/useMissionCost.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/cost/useTaskCost.ts` | 24, 31 | Production helper/type import (expanded above) |
| `apps/web/src/features/files/AssetFilePanel.tsx` | 1, 4, 35 | Production reader/access module (expanded above) |
| `apps/web/src/features/files/DownloadFileButton.test.tsx` | 9 | Test/performance/support |
| `apps/web/src/features/files/DownloadFileButton.tsx` | 1, 5, 29 | Production reader/access module (expanded above) |
| `apps/web/src/features/files/FileBrowserModal.test.tsx` | 10, 13, 14, 15 | Test/performance/support |
| `apps/web/src/features/files/FileBrowserModal.tsx` | 7, 32 | Production reader/access module (expanded above) |
| `apps/web/src/features/files/FilePanel.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/files/HtmlFilePanel.test.tsx` | 3, 56, 63, 64, 65 | Test/performance/support |
| `apps/web/src/features/files/HtmlFilePanel.tsx` | 8, 11, 44 | Production reader/access module (expanded above) |
| `apps/web/src/features/files/JsonFilePanel.test.tsx` | 53, 55, 56 | Test/performance/support |
| `apps/web/src/features/files/JsonFilePanel.tsx` | 11, 22, 79 | Production reader/access module (expanded above) |
| `apps/web/src/features/files/MarkdownFilePanel.test.tsx` | 30 | Test/performance/support |
| `apps/web/src/features/files/MarkdownFilePanel.tsx` | 10, 15, 44 | Production reader/access module (expanded above) |
| `apps/web/src/features/files/MarkdownPreview.tsx` | 6, 30 | Production reader/access module (expanded above) |
| `apps/web/src/features/files/OpenInBrowserButton.test.tsx` | 11 | Test/performance/support |
| `apps/web/src/features/files/OpenInBrowserButton.tsx` | 1, 5, 33 | Production reader/access module (expanded above) |
| `apps/web/src/features/files/TableFilePanel.tsx` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/features/files/WorktreeFileTree.test.tsx` | 20, 29, 30, 31 | Test/performance/support |
| `apps/web/src/features/files/WorktreeFileTree.tsx` | 2, 9, 182 | Production reader/access module (expanded above) |
| `apps/web/src/features/files/open-in-browser.test.ts` | 1 | Test/performance/support |
| `apps/web/src/features/files/open-in-browser.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/files/useFileDocument.ts` | 2, 5, 29 | Production reader/access module (expanded above) |
| `apps/web/src/features/git/DiffSheet.test.tsx` | 84 | Test/performance/support |
| `apps/web/src/features/git/DiffSheet.tsx` | 8, 492 | Production reader/access module (expanded above) |
| `apps/web/src/features/git/GitPanelView.test.tsx` | 48 | Test/performance/support |
| `apps/web/src/features/git/GitPanelView.tsx` | 8, 107 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/IssueAgentSettings.tsx` | 6, 56 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/IssueCompactControls.test.tsx` | 80, 81, 82 | Test/performance/support |
| `apps/web/src/features/issues/IssueCompactControls.tsx` | 9, 32, 245, 342, 508, 518 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/IssueContextMenu.agent-entry.test.tsx` | 13, 24, 25 | Test/performance/support |
| `apps/web/src/features/issues/IssueContextMenu.close-guard.test.tsx` | 14, 24, 25 | Test/performance/support |
| `apps/web/src/features/issues/IssueContextMenu.live.test.tsx` | 30, 39, 40, 41 | Test/performance/support |
| `apps/web/src/features/issues/IssueContextMenu.tsx` | 1, 8, 27, 140 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/IssuePage.activity.test.tsx` | 2, 94, 95, 96, 97 | Test/performance/support |
| `apps/web/src/features/issues/IssuePage.agent-data.test.tsx` | 59, 60, 61 | Test/performance/support |
| `apps/web/src/features/issues/IssuePage.agent-start.test.tsx` | 15, 68, 69, 70, 71 | Test/performance/support |
| `apps/web/src/features/issues/IssuePage.attribution.test.tsx` | 51, 52, 53 | Test/performance/support |
| `apps/web/src/features/issues/IssuePage.issue-switch-reset.test.tsx` | 63, 64, 68 | Test/performance/support |
| `apps/web/src/features/issues/IssuePage.subissues.test.tsx` | 59, 60, 61, 62 | Test/performance/support |
| `apps/web/src/features/issues/IssuePanelView.artifact-open.test.tsx` | 52, 53, 54 | Test/performance/support |
| `apps/web/src/features/issues/IssuePanelView.inspector.test.tsx` | 2, 146, 147, 148 | Test/performance/support |
| `apps/web/src/features/issues/IssuePanelView.scroll.test.tsx` | 114, 115, 116 | Test/performance/support |
| `apps/web/src/features/issues/IssuePanelView.subissue-nav.test.tsx` | 104, 105, 106 | Test/performance/support |
| `apps/web/src/features/issues/IssuePanelView.tsx` | 20, 41, 355, 559, 635, 858, 872 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/IssuesView.bulk-close.test.tsx` | 86, 87 | Test/performance/support |
| `apps/web/src/features/issues/IssuesView.tsx` | 10, 53, 54, 55, 56, 57, 61, 62, 63, 64 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/LaunchBox.tsx` | 52 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/web/src/features/issues/NewIssueDialog.agent-start.test.tsx` | 14, 48, 49, 50 | Test/performance/support |
| `apps/web/src/features/issues/NewIssueDialog.tsx` | 2, 18, 219 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/explorer/IssueExplorer.test.tsx` | 53, 54, 55 | Test/performance/support |
| `apps/web/src/features/issues/explorer/IssueExplorer.tsx` | 7, 115 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/explorer/IssueExplorerList.tsx` | 3, 9, 38, 39 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/explorer/explorer-context.tsx` | 2, 15, 85, 89 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/explorer/explorer-list.test.ts` | 1 | Test/performance/support |
| `apps/web/src/features/issues/explorer/explorer-list.ts` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-board-filter.ts` | 7 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/web/src/features/issues/issue-card.ts` | 6 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-context-menu.ts` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-hierarchy.test.ts` | 10 | Test/performance/support |
| `apps/web/src/features/issues/issue-hierarchy.ts` | 6, 16, 23 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-lifecycle.test.ts` | 8 | Test/performance/support |
| `apps/web/src/features/issues/issue-lifecycle.tsx` | 2, 7, 11, 30, 85, 148, 249 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/issue-list.ts` | 4, 11 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-menu-commands.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-menu-config.ts` | 1, 2 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-menu-palette.ts` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-page-commands.ts` | 15 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-page-model.ts` | 16, 22, 95, 111 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/issue-page/IssueActivity.tsx` | 17, 40 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-page/IssueAgentActivity.tsx` | 43, 48, 55 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/issue-page/IssueDetailHeader.test.tsx` | 15 | Test/performance/support |
| `apps/web/src/features/issues/issue-page/IssueDetailHeader.tsx` | 13, 18, 66 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/issue-page/IssueNow.tsx` | 30 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-page/IssueParentRow.test.tsx` | 16, 30, 31 | Test/performance/support |
| `apps/web/src/features/issues/issue-page/IssueParentRow.tsx` | 35 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-page/IssueProperties.tsx` | 73, 106, 115 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/issue-page/IssueRelations.tsx` | 28 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-page/IssueSessionsBlock.tsx` | 31 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issue-page/issue-edges.test.tsx` | 54, 55 | Test/performance/support |
| `apps/web/src/features/issues/issue-page/issue-edges.tsx` | 56, 57, 60, 113, 114, 122, 124 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/issue-page/use-eviction-guard.test.tsx` | 31 | Test/performance/support |
| `apps/web/src/features/issues/issue-page/use-eviction-guard.ts` | 44, 54 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/issues-display.test.ts` | 2 | Test/performance/support |
| `apps/web/src/features/issues/issues-display.ts` | 11, 78 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/issues-view-model.ts` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/features/issues/use-agent-fleet-options.ts` | 21, 25, 53 | Production reader/access module (expanded above) |
| `apps/web/src/features/issues/use-issue-status-apply.tsx` | 6, 39, 40 | Production reader/access module (expanded above) |
| `apps/web/src/features/machines/ConnectionIndicator.tsx` | 7, 17 | Production reader/access module (expanded above) |
| `apps/web/src/features/machines/HostIndicators.tsx` | 17, 23, 201, 209 | Production reader/access module (expanded above) |
| `apps/web/src/features/machines/HostMemoryView.tsx` | 7, 21, 164, 465 | Production reader/access module (expanded above) |
| `apps/web/src/features/machines/LoadPanel.tsx` | 13, 17, 531 | Production reader/access module (expanded above) |
| `apps/web/src/features/machines/OutboxRecovery.tsx` | 49, 69, 242 | Production reader/access module (expanded above) |
| `apps/web/src/features/machines/QuotaIndicator.tsx` | 21 | Production helper/type import (expanded above) |
| `apps/web/src/features/machines/QuotaPanel.tsx` | 15 | Production helper/type import (expanded above) |
| `apps/web/src/features/machines/host-lifecycle-settings.ts` | 5, 21 | Production reader/access module (expanded above) |
| `apps/web/src/features/machines/load-panel-legend.test.tsx` | 87, 111, 112, 113, 114 | Test/performance/support |
| `apps/web/src/features/machines/multimachine-indicators.test.tsx` | 85, 127, 128, 129, 130 | Test/performance/support |
| `apps/web/src/features/machines/outbox-recovery.test.tsx` | 52 | Test/performance/support |
| `apps/web/src/features/machines/reclaim-panel.test.tsx` | 84, 111, 112, 113, 114 | Test/performance/support |
| `apps/web/src/features/machines/useQuotaSurge.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/merge-queue/merge-queue-model.ts` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/features/messages/MessageLedgerView.tsx` | 14, 109 | Production reader/access module (expanded above) |
| `apps/web/src/features/mobile-handoff/MobileHandoffChip.tsx` | 5, 24, 25 | Production reader/access module (expanded above) |
| `apps/web/src/features/mobile-handoff/MobilePromoCard.tsx` | 3, 29, 30 | Production reader/access module (expanded above) |
| `apps/web/src/features/mobile-handoff/mobile-handoff.test.tsx` | 54, 55 | Test/performance/support |
| `apps/web/src/features/mobile-handoff/mobile-handoff.ts` | 32, 151, 171 | Production reader/access module (expanded above) |
| `apps/web/src/features/settings/MachinesPanel.test.tsx` | 18, 19 | Test/performance/support |
| `apps/web/src/features/settings/SettingsView.close-guard.test.tsx` | 25, 26 | Test/performance/support |
| `apps/web/src/features/settings/SettingsView.tsx` | 9, 260 | Production reader/access module (expanded above) |
| `apps/web/src/features/settings/sections/accounts.test.tsx` | 60, 62, 63, 64 | Test/performance/support |
| `apps/web/src/features/settings/sections/accounts.tsx` | 5, 71, 220, 378 | Production reader/access module (expanded above) |
| `apps/web/src/features/settings/sections/experimental.mobx-sidebar.test.tsx` | 30 | Test/performance/support |
| `apps/web/src/features/settings/sections/network.test.tsx` | 10 | Test/performance/support |
| `apps/web/src/features/settings/sections/network.tsx` | 3, 31 | Production reader/access module (expanded above) |
| `apps/web/src/features/settings/sections/notifications.tsx` | 6, 223 | Production reader/access module (expanded above) |
| `apps/web/src/features/settings/sections/privacy.test.tsx` | 32, 33 | Test/performance/support |
| `apps/web/src/features/settings/sections/privacy.tsx` | 23, 69, 253 | Production reader/access module (expanded above) |
| `apps/web/src/features/settings/sections/repos.tsx` | 12, 32 | Production reader/access module (expanded above) |
| `apps/web/src/features/settings/sections/shared.test.tsx` | 11, 13, 14, 15 | Test/performance/support |
| `apps/web/src/features/settings/sections/superagent.tsx` | 4, 62 | Production reader/access module (expanded above) |
| `apps/web/src/features/settings/sections/updates.test.tsx` | 38 | Test/performance/support |
| `apps/web/src/features/settings/sections/updates.tsx` | 8, 111 | Production reader/access module (expanded above) |
| `apps/web/src/features/settings/sections/workllm.test.tsx` | 11, 13, 14, 15 | Test/performance/support |
| `apps/web/src/features/settings/use-forced-setting.test.tsx` | 7 | Test/performance/support |
| `apps/web/src/features/settings/use-forced-setting.ts` | 2, 107 | Production reader/access module (expanded above) |
| `apps/web/src/features/setup/ColdStartComposer.capability.test.tsx` | 96 | Test/performance/support |
| `apps/web/src/features/setup/ColdStartComposer.default-agent.test.tsx` | 150 | Test/performance/support |
| `apps/web/src/features/setup/ColdStartComposer.machine-use.test.tsx` | 95 | Test/performance/support |
| `apps/web/src/features/setup/ColdStartComposer.modes.test.tsx` | 115 | Test/performance/support |
| `apps/web/src/features/setup/ColdStartComposer.test.tsx` | 111 | Test/performance/support |
| `apps/web/src/features/setup/ColdStartComposer.tsx` | 16, 23, 169 | Production reader/access module (expanded above) |
| `apps/web/src/features/setup/ExistingPodiumActivation.test.tsx` | 32 | Test/performance/support |
| `apps/web/src/features/setup/ExistingPodiumActivation.tsx` | 21, 100 | Production reader/access module (expanded above) |
| `apps/web/src/features/setup/FirstTaskActivation.test.tsx` | 73 | Test/performance/support |
| `apps/web/src/features/setup/FirstTaskActivation.tsx` | 9, 26, 124 | Production reader/access module (expanded above) |
| `apps/web/src/features/setup/GitHubProjectIntake.test.tsx` | 61 | Test/performance/support |
| `apps/web/src/features/setup/GitHubProjectIntake.tsx` | 9, 46 | Production reader/access module (expanded above) |
| `apps/web/src/features/setup/OnboardingWizard.test.tsx` | 13 | Test/performance/support |
| `apps/web/src/features/setup/OnboardingWizard.tsx` | 2, 57 | Production reader/access module (expanded above) |
| `apps/web/src/features/setup/RepoPickerModal.tsx` | 27, 131 | Production reader/access module (expanded above) |
| `apps/web/src/features/setup/RepoScanFlow.capability.test.tsx` | 75, 77, 78, 79 | Test/performance/support |
| `apps/web/src/features/setup/RepoScanFlow.machine.test.tsx` | 85, 87, 88, 89 | Test/performance/support |
| `apps/web/src/features/setup/RepoScanFlow.tsx` | 8, 85 | Production reader/access module (expanded above) |
| `apps/web/src/features/setup/VpsFirstActivation.test.tsx` | 26 | Test/performance/support |
| `apps/web/src/features/setup/VpsFirstActivation.tsx` | 17, 121 | Production reader/access module (expanded above) |
| `apps/web/src/features/setup/use-activation-route.test.tsx` | 28 | Test/performance/support |
| `apps/web/src/features/shipping/ShippingPanel.tsx` | 7 | Production helper/type import (expanded above) |
| `apps/web/src/features/specs/SpecsView.tsx` | 20, 63 | Production reader/access module (expanded above) |
| `apps/web/src/features/superagent/ConciergeButton.tsx` | 5, 23 | Production reader/access module (expanded above) |
| `apps/web/src/features/superagent/SuperagentView.test.tsx` | 133, 157, 158, 161, 162 | Test/performance/support |
| `apps/web/src/features/superagent/SuperagentView.tsx` | 2, 8, 87, 118 | Production reader/access module (expanded above) |
| `apps/web/src/features/superagent/concierge.ts` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/features/superagent/useIssueEvents.test.tsx` | 17 | Test/performance/support |
| `apps/web/src/features/superagent/useIssueEvents.ts` | 4, 51 | Production reader/access module (expanded above) |
| `apps/web/src/features/terminal/AgentPanel.tsx` | 1, 15, 43, 226, 273, 274, 304 | Production reader/access module (expanded above) |
| `apps/web/src/features/terminal/DockShellPanel.tsx` | 3, 9, 53, 223 | Production reader/access module (expanded above) |
| `apps/web/src/features/terminal/SessionLifecyclePanes.tsx` | 18, 22, 75 | Production reader/access module (expanded above) |
| `apps/web/src/features/terminal/agent-panel-active.test.tsx` | 123, 139, 140, 145 | Test/performance/support |
| `apps/web/src/features/terminal/agent-panel-arbitration.test.tsx` | 114, 128, 129, 137 | Test/performance/support |
| `apps/web/src/features/terminal/agent-panel-draft-flush.test.tsx` | 106, 121, 122, 129 | Test/performance/support |
| `apps/web/src/features/terminal/dock-shell-lifecycle.test.ts` | 9 | Test/performance/support |
| `apps/web/src/features/terminal/dock-shell-lifecycle.tsx` | 5, 53 | Production reader/access module (expanded above) |
| `apps/web/src/features/terminal/dock-shell-parked.test.tsx` | 44, 45 | Test/performance/support |
| `apps/web/src/features/terminal/dock-shell-server-wins.test.tsx` | 61, 62 | Test/performance/support |
| `apps/web/src/features/terminal/handover-pane.test.tsx` | 73, 87, 88, 95 | Test/performance/support |
| `apps/web/src/features/terminal/lifecycle-actions.ts` | 27 | Production helper/type import (expanded above) |
| `apps/web/src/features/terminal/panel-surface.test.ts` | 2 | Test/performance/support |
| `apps/web/src/features/terminal/panel-surface.ts` | 41 | Production helper/type import (expanded above) |
| `apps/web/src/features/terminal/session-lifecycle-banners.test.tsx` | 18 | Test/performance/support |
| `apps/web/src/features/terminal/test-support/presence-mock.ts` | 22 | Test/performance/support |
| `apps/web/src/features/terminal/use-panel-surface.ts` | 37, 41, 116 | Production reader/access module (expanded above) |
| `apps/web/src/features/terminal/use-terminal-appearance.ts` | 3, 23 | Production reader/access module (expanded above) |
| `apps/web/src/features/usage/QuotaLedger.test.tsx` | 1 | Test/performance/support |
| `apps/web/src/features/usage/QuotaLedger.tsx` | 6 | Production helper/type import (expanded above) |
| `apps/web/src/features/usage/UsageTasks.test.tsx` | 1 | Test/performance/support |
| `apps/web/src/features/usage/UsageTasks.tsx` | 10 | Production helper/type import (expanded above) |
| `apps/web/src/features/usage/UsageView.test.tsx` | 35 | Test/performance/support |
| `apps/web/src/features/usage/UsageView.tsx` | 15, 18, 57 | Production reader/access module (expanded above) |
| `apps/web/src/features/usage/useQuotaLedger.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/usage/useTaskCosts.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/workflows/ExecutionProfiles.test.tsx` | 7 | Test/performance/support |
| `apps/web/src/features/workflows/ExecutionProfiles.tsx` | 32, 37, 61 | Production reader/access module (expanded above) |
| `apps/web/src/features/workflows/RunProgress.tsx` | 1, 34, 39, 97 | Production reader/access module (expanded above) |
| `apps/web/src/features/workflows/WorkflowLibrary.tsx` | 19 | Production helper/type import (expanded above) |
| `apps/web/src/features/workflows/WorkflowsView.test.tsx` | 60, 76, 77, 81, 84 | Test/performance/support |
| `apps/web/src/features/workflows/WorkflowsView.tsx` | 7 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/web/src/features/workflows/use-workflows.ts` | 9, 53, 83 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/FoldedRowMenu.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/worklist/ManageProjectsDialog.test.tsx` | 9, 15 | Test/performance/support |
| `apps/web/src/features/worklist/ManageProjectsDialog.tsx` | 2, 6, 14 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/PanelRow.oom-outcome.test.tsx` | 19 | Test/performance/support |
| `apps/web/src/features/worklist/PanelRow.open-todos.test.tsx` | 16 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarPerfPanel.tsx` | 9, 140 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/SidebarRail.design-3b.test.tsx` | 78, 116, 117, 118, 119, 120 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarRail.tsx` | 82, 87, 245 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/SidebarUnified.bring-back.test.tsx` | 114, 151, 152, 153, 154, 155 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.evict.test.tsx` | 82, 116, 117, 118, 119, 120 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.flat-rows.test.tsx` | 174, 206, 207, 208, 209, 210 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.lifecycle.test.tsx` | 107, 148, 149, 150, 152, 157, 158 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.new-task.test.tsx` | 97, 146, 147, 148, 149, 150 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.pinned.test.tsx` | 107, 176, 177, 178, 180, 185, 186 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.pool-actions.test.tsx` | 8, 17, 65, 67, 100, 194, 207, 324, 350, 459, 505, 507, 542, 559, 581, 596, 631, 671, 676, 762, 910, 913, 1159, 1161, 1171, 1211, 1219, 1221 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.pool.test.tsx` | 4, 5, 56, 61, 89, 129, 182, 190, 191, 204, 209, 216, 220, 225, 226, 263, 302, 303, 350, 353, 356, 359, 364 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.progress.test.tsx` | 110, 142, 143, 144, 145, 146 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.rename.test.tsx` | 77, 114, 115, 116, 118, 123, 124 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.search.test.tsx` | 99, 135, 136, 137, 138, 139 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.selected-weight.test.tsx` | 88, 130, 131, 132, 134, 139, 140 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.shortcuts.test.tsx` | 99, 131, 132, 133, 134, 135 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.tsx` | 16, 38, 162 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/SidebarUnified.tuck.test.tsx` | 90, 138, 139, 140, 142, 147, 148 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.unread.test.tsx` | 109, 162, 163, 164, 166, 171, 172 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.working-unread.test.tsx` | 85, 139, 140, 141, 143, 148, 149 | Test/performance/support |
| `apps/web/src/features/worklist/SidebarUnified.working.test.tsx` | 73, 164, 165, 166, 168, 173, 174 | Test/performance/support |
| `apps/web/src/features/worklist/UnifiedIssueRow.handoff.test.tsx` | 2 | Test/performance/support |
| `apps/web/src/features/worklist/UnifiedIssueRow.memo.test.tsx` | 24 | Test/performance/support |
| `apps/web/src/features/worklist/UnifiedIssueRow.tsx` | 17 | Production helper/type import (expanded above) |
| `apps/web/src/features/worklist/UnifiedWorktreeRow.tsx` | 6 | Production helper/type import (expanded above) |
| `apps/web/src/features/worklist/WorkRowShell.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/features/worklist/derivation.ts` | 10, 11, 29 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/new-task.ts` | 32, 55 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/pool-row-data.ts` | 7 | Production helper/type import (expanded above) |
| `apps/web/src/features/worklist/pool-sidebar-rail.tsx` | 3, 13, 36, 163 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/pool-sidebar.tsx` | 9, 34, 97, 140, 646, 795 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/row-progress.tsx` | 112 | Production helper/type import (expanded above) |
| `apps/web/src/features/worklist/sidebar-common.attribution.test.tsx` | 34 | Test/performance/support |
| `apps/web/src/features/worklist/sidebar-common.drawer.test.tsx` | 7 | Test/performance/support |
| `apps/web/src/features/worklist/sidebar-common.error.test.tsx` | 8 | Test/performance/support |
| `apps/web/src/features/worklist/sidebar-common.roster.test.tsx` | 10 | Test/performance/support |
| `apps/web/src/features/worklist/sidebar-common.tsx` | 15, 36, 171, 401, 410, 415, 668, 669, 696 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/sidebar-common.unread-chip.test.tsx` | 8 | Test/performance/support |
| `apps/web/src/features/worklist/time-indicators.tsx` | 10 | Production helper/type import (expanded above) |
| `apps/web/src/features/worklist/use-pool-unified-work.ts` | 3, 4, 86, 91, 95, 114, 155, 181, 192, 197, 200, 201, 202, 204, 206, 244 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/use-sidebar-projects.ts` | 8, 14, 27, 36, 61 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/use-unified-work.navigation.test.tsx` | 4, 12, 13, 14 | Test/performance/support |
| `apps/web/src/features/worklist/use-unified-work.ts` | 25, 35, 90, 125, 131 | Production reader/access module (expanded above) |
| `apps/web/src/features/worklist/work-filter.ts` | 22 | Production helper/type import (expanded above) |
| `apps/web/src/features/worklist/work-folds.tsx` | 7 | Production helper/type import (expanded above) |
| `apps/web/src/features/worklist/work-search.tsx` | 18 | Production helper/type import (expanded above) |
| `apps/web/src/lib/SessionContextMenu.live.test.tsx` | 22, 37, 38, 39 | Test/performance/support |
| `apps/web/src/lib/SessionContextMenu.tsx` | 3, 28, 90, 105 | Production reader/access module (expanded above) |
| `apps/web/src/lib/SnoozeControl.tsx` | 8, 64 | Production reader/access module (expanded above) |
| `apps/web/src/lib/WorkerLabel.tsx` | 2 | Production reader/access module (expanded above) |
| `apps/web/src/lib/agent-capability.tsx` | 57 | Production helper/type import (expanded above) |
| `apps/web/src/lib/asset-url.ts` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/lib/at-mention/useFileMentions.ts` | 3, 39 | Production reader/access module (expanded above) |
| `apps/web/src/lib/derive-headless.test.ts` | 6 | Test/performance/support |
| `apps/web/src/lib/derive-issue-nav.test.ts` | 6 | Test/performance/support |
| `apps/web/src/lib/derive-issues.test.ts` | 1 | Test/performance/support |
| `apps/web/src/lib/derive-session-grouping.test.ts` | 11 | Test/performance/support |
| `apps/web/src/lib/derive-sidebar.test.ts` | 6 | Test/performance/support |
| `apps/web/src/lib/derive-unified.test.ts` | 25 | Test/performance/support |
| `apps/web/src/lib/derive-worktree-move.test.ts` | 1 | Test/performance/support |
| `apps/web/src/lib/derive.ts` | 5, 18 | Production helper/type import (expanded above) |
| `apps/web/src/lib/dock-panel.test.ts` | 13 | Test/performance/support |
| `apps/web/src/lib/harness-descriptors.ts` | 8, 25 | Production reader/access module (expanded above) |
| `apps/web/src/lib/hooks/use-session-guard.ts` | 2, 5, 43 | Production reader/access module (expanded above) |
| `apps/web/src/lib/issue-chip-liveness.test.ts` | 1 | Test/performance/support |
| `apps/web/src/lib/issue-chip-liveness.ts` | 6 | Production helper/type import (expanded above) |
| `apps/web/src/lib/issue-reference-pool.test.ts` | 5, 19, 20 | Test/performance/support |
| `apps/web/src/lib/kernelReplica.cross-tab.test.ts` | 186, 187 | Test/performance/support |
| `apps/web/src/lib/kernelReplica.http.test.ts` | 88, 89, 92, 93, 108, 118, 128, 130 | Test/performance/support |
| `apps/web/src/lib/kernelReplica.retention.test.tsx` | 200 | Test/performance/support |
| `apps/web/src/lib/motion/AgentStatusGlyph.tsx` | 16 | Production helper/type import (expanded above) |
| `apps/web/src/lib/motion/MotionDemo.tsx` | 1 | Production helper/type import (expanded above) |
| `apps/web/src/lib/motion/PhaseTimer.tsx` | 22 | Production helper/type import (expanded above) |
| `apps/web/src/lib/motion/index.ts` | 7 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/web/src/lib/recency-order.test.ts` | 2 | Test/performance/support |
| `apps/web/src/lib/session-context-menu.ts` | 2 | Production helper/type import (expanded above) |
| `apps/web/src/lib/sidebar-check.test.ts` | 15, 21, 41, 62 | Test/performance/support |
| `apps/web/src/lib/sticky-prompts.ts` | 4, 25 | Production reader/access module (expanded above) |
| `apps/web/src/lib/sync-progress.test.ts` | 12, 19, 34, 50 | Test/performance/support |
| `apps/web/src/lib/sync-progress.ts` | 46 | Comment, definition, independent source or build metadata; not a surface store read |
| `apps/web/src/lib/use-feature.ts` | 16, 74 | Production reader/access module (expanded above) |
| `apps/web/src/lib/use-persisted-ui-state.test.tsx` | 29 | Test/performance/support |
| `apps/web/src/lib/use-persisted-ui-state.ts` | 3, 36, 58 | Production reader/access module (expanded above) |
| `apps/web/src/lib/useConversationSearch.ts` | 2, 25 | Production reader/access module (expanded above) |
| `apps/web/src/perf/kernel-scenarios.frontend-perf.tsx` | 15, 16, 17, 20, 101, 109, 110, 111, 112, 374, 382, 383, 392, 400, 411, 418, 419, 425, 435, 436, 441, 459, 467, 472, 483 | Test/performance/support |
| `apps/web/src/perf/large-state.frontend-perf.tsx` | 3, 43, 44 | Test/performance/support |
| `apps/web/src/perf/responsive-filtering.frontend-perf.tsx` | 83, 85, 88, 89, 92, 93, 96, 100, 101, 103 | Test/performance/support |
| `apps/web/src/perf/scoped-session-render.test.tsx` | 166, 246, 252, 259, 264 | Test/performance/support |
| `apps/web/src/perf/slice-render-count.test.tsx` | 39, 62, 64, 65, 232, 238, 239, 243, 245, 246, 247, 248 | Test/performance/support |
| `apps/web/src/perf/tuck-fanout.probe.tsx` | 20, 51, 52, 249, 284 | Test/performance/support |
| `apps/web/test/chat.test.ts` | 1 | Harness/browser evidence |
| `apps/web/test/derive.machines.test.ts` | 1 | Harness/browser evidence |
| `apps/web/test/derive.test.ts` | 17 | Harness/browser evidence |
| `apps/web/test/header-pool.browser.tsx` | 2, 37, 42, 73 | Harness/browser evidence |
| `apps/web/test/issue-chips.browser.tsx` | 6, 72, 81, 141, 146, 179 | Harness/browser evidence |
| `apps/web/test/pool-memory.browser.tsx` | 10, 134, 136, 142, 213, 214, 215, 244, 245, 251 | Harness/browser evidence |
| `apps/web/test/shell.structure.test.ts` | 57, 69 | Harness/browser evidence |
| `apps/web/test/sidebar-acceptance.browser.tsx` | 6, 9, 125, 146, 148, 153, 219, 220, 223, 236, 242, 250 | Harness/browser evidence |
| `apps/web/test/sidebar-actions.browser.tsx` | 8, 61, 68, 87, 101 | Harness/browser evidence |
| `apps/web/test/sidebar-pool-perf.browser.tsx` | 69 | Harness/browser evidence |
| `apps/web/test/sidebar-renderer.browser.tsx` | 4, 51, 73, 79, 147, 150, 153, 154, 155, 156 | Harness/browser evidence |
