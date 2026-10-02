# Client access and preference readers

POD-5161 · 2026-10-02 · integration target `integrate/4286-pilot`.
Baseline reader inventory: [POD-5082](POD-5082-legacy-reader-inventory.md), especially the shared-runtime and preference consumer groups.

## Scope and ownership

Stable catalog, descriptor, merge-lock, presence, feature, theme, and mobile action/transport access now uses the existing runtime handle without a snapshot subscription. This does not add another runtime, replica, outbox, socket, or mutation owner. Reactive entity hooks outside this allocation retain their current paths.

The coordinator allocated the web pool attachment, new preference schema/source/diagnostic, `pool.ts`, `runtime-pool.ts`, theme/density/terminal appearance, and only the density-owner acquisition in `AppShell.tsx`. The shared core provider was not changed. Existing attachment tests and three overlapping facades remain with POD-4973.

Mobile stable accessors are included. The coordinator explicitly reserved `MobileClientProvider.tsx` and mobile `usePersistedUiState`, `useCollapsed`, and `useCollapsedSet` for the mobile attachment sequence. POD-5220 tracks those reactive hooks after POD-4976. This report does not claim the mobile reactive preference migration is complete.

## Reader and rollout contract

`preferences-data-layer.ts` defaults OFF and latches the URL choice once per app load. Add `mobxPreferences=1` on initial load to enable; remove it and reload to roll back. Principal changes do not reselect the switch. `mobxPreferencesCheck=1` additionally installs the lazy, on-demand `window.__preferenceCheck()` diagnostic. Diagnostics report counts and mismatch positions, never saved keys or values.

`PREFERENCE_SCHEMA` declares the scalar entity, routed home, fields, no relations, and no unloaded summaries. A read validates the key against the existing UI routing declarations before source access. The single reader is `pool.row('preference', key)`; its first answer is `LOADING`. A microtask loads all demanded keys together. Source notifications refresh only resident/demanded keys, never enumerate the replica or preference namespace. Unchanged values do not invalidate projections.

The existing runtime UI port owns reads, optimistic writes, rollback, hydration, local migration, and rescope. The preference attachment adds one source subscription to the existing shared pool. Disposal detaches immediately, refuses subsequent reads, cancels queued loads, and clears old observable rows after React render. The enabled hook paints its parsed loading default while the pool loads and never falls through to a legacy reader.

Pre-auth theme behavior is preserved; its mirror only acquires the UI writer. Density, sticky prompts, terminal appearance, and other generic web persisted preferences use declared pool reads when enabled. The switch remains OFF in this change. POD-5222 tracks removal of the fallback about a week after the operator records a default-ON date; no retirement date has been invented.

## Real Chromium evidence

Run on flatblock in `~/podium-test-5161` with checkout-local Bun 1.4.2 and `.toolchain` libraries. `client-access-proof.ts` owns one Vite process and one Chromium instance, with the real offline `StoreProvider` and existing runtime attachment. The fixture has 5,600 synthetic issues and 5,014 sessions. It drives 200 session activity events, then 20 rounds of three preference writes, then clicks the sticky-prompts button and observes `Off`.

The before arm reproduces the previous stable-selector/UI subscription acquisitions. The after arm mounts the actual migrated hooks, including terminal appearance and shared transport hooks. This is a bounded reader proof, not a whole-app interaction benchmark. No operator records leave ludovico.

| Phase | Before selector calls | After selector calls | Before subscriber wakes | After subscriber wakes | After legacy derivations | After legacy preference reads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 200 activity events | 800 | 0 | 800 | 400 | 0 | 0 |
| 20 preference rounds | 160 | 0 | 80 | 40 | 0 | 0 |

Pool source subscriptions still receive updates, hence nonzero total wakes. No preference component commits during unrelated activity. Preference writes cause 20 commits in each arm. Four demanded preference rows load in one initial batch; the final differential reports **0 differences, 0 pending, 4 positions**. The activity phase loads no additional preference rows.

The counts-only run needed no timing lease. The timed run held `bench:flatblock` and released it immediately afterward. One Chromium sample, milliseconds:

| Phase | Before task time | After task time | Before script time | After script time | Before React commit duration | After React commit duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Activity | 537.316 | 506.479 | 0.024 | 5.318 | 0 | 0 |
| Preferences | 68.021 | 62.001 | 30.622 | 33.639 | 7.800 | 8.200 |

These timings do not establish a broad speedup; the strong result is eliminated legacy reader work with matching output. Task time includes synthetic fixture delivery. The legacy-read counter instruments the new fallback hook; the manually reconstructed before arm is represented by selector counts instead.

`browser-red.log` records the planted enabled-path fallback failing with `Legacy preference/transport reader executed`. After restoring the code, both counts-only and timed runs completed with zero browser errors. Attached screenshots show the synthetic preference surface after the actual button interaction.

## Saved operator preference replay

`preference-replay.ts` is host-guarded to ludovico. It reads the existing authenticated loopback layout endpoint, keeps values only in memory, exposes read-only UI ports, and compares through the same pool diagnostic. It neither writes to the operator layout nor starts/restarts services. Only this count result is retained:

```json
{"differences":0,"pending":0,"positions":37,"first":null,"storedKeys":37}
```

This covers all 37 returned saved layout rows. Browser device-local preferences are covered by synthetic lifecycle tests and Chromium, not claimed as operator replay evidence.

## Focused validation and sensitivity

Validation uses `bun run test:file -- <exact files>` on flatblock, never raw runners or a package/full suite. Affected `@podium/client-core`, `@podium/client-graph`, `@podium/web`, and `@podium/mobile` typechecks passed using the shared cache. The later web-only check after test-support edits passed all 16 dependency tasks (15 cached).

The initial 12-file selection covers 58 tests: shared transport subscriptions; catalog/lock/presence existing behavior; startup latch; persisted hooks; pool declarations, batching, hydration, optimism, rollback, clear, disposal, offline/StrictMode/principal changes; theme/density/terminal parsing; and mobile owner identity. One catalog async-flush expectation was corrected, and the affected three files then passed all 19 tests. Together the passing outputs cover those 58 tests; this is not a lean-gate or full-suite claim.

Every new test case was subjected to a failing control in the isolated checkout and restored:

| Check | Planted defect caught |
| --- | --- |
| Shared transport access | Reintroduced four legacy subscriptions |
| Mobile stable access | Reintroduced a snapshot selector |
| Persisted UI access | Reintroduced a snapshot selector |
| Startup switch | Removed startup latching |
| Declared/batched reactive preferences | Replaced loaded values; differential reported mismatches |
| Source disposal | Removed source unsubscription |
| Offline/StrictMode/principal lifecycle | Forced the enabled path through the fallback; counted 19 legacy reads |
| Render-safe principal teardown assertion | Cleared observable rows synchronously during provider render |
| Chromium enabled path | Forced fallback and failed the zero-reader assertion |

The first pool-control invocation had a fixture import typo and is explicitly not sensitivity evidence; corrected controls reached and failed all three intended assertions.

The exact facade selection named 68 files / 564 tests. Final evidence covers 514 passing tests (55 wholly passing files) and 50 existing failures across 13 files. The initial candidate run had 64 failures; 14 came from accidentally bridging two real-provider tests. Removing those two imports restored both files to 23/23 passing. No product code changed to accommodate test mocks.

The same 15 failing files were run on the unchanged integration baseline `d4dda28b52`: **50 failures, 79 passes**. All 50 failing test names are identical to the candidate's remaining failures; no baseline-only failures exist. These are tracked in unclaimed Proposed POD-5224:

- `ChatView.test.tsx`: 12 missing `subscribeKnownRefPrefixes` mock exports.
- `ColdStartComposer.modes.test.tsx`: 2 session-name expectation mismatches.
- `VpsFirstActivation.test.tsx`: 5 obsolete setup-command text expectations.
- `IssuePage.activity`, `IssuePage.agent-data`, `IssuePage.subissues`: 8 missing-session fixture failures.
- `IssuePanelView.subissue-nav`, `PanelRow.oom-outcome`, `PanelRow.open-todos`, and `sidebar-common.attribution`, `.roster`, `.unread-chip`, `.error`: 23 missing-provider fixture failures.

The facade selection is deliberately not reported as green. Raw candidate, baseline, and restored-real-provider logs are attached with the focused controls and typecheck logs. No exhaustive suite or lean gate was run.

## Test facade inventory

A global core-handle mock would intercept real-provider checks. The opt-in `apps/web/src/test-support/mock-core-store-handle.ts` instead bridges each provider-free test's existing mocked web snapshot. The existing shared `features/chat/test-support/fake-store-handle.ts` exposes that same owner's UI/transport fields while retaining message/outbox snapshot identity. Chat and terminal facades inherit that bridge without individual edits.

The following files add only the opt-in helper import:

- `apps/web/src/app/new-panel-menu.test.tsx`
- `apps/web/src/features/chat/ToolBatchView.test.tsx`
- `apps/web/src/features/files/HtmlFilePanel.test.tsx`
- `apps/web/src/features/files/JsonFilePanel.test.tsx`
- `apps/web/src/features/files/MarkdownFilePanel.test.tsx`
- `apps/web/src/features/git/DiffSheet.test.tsx`
- `apps/web/src/features/git/GitPanelView.test.tsx`
- `apps/web/src/features/issues/IssuePage.activity.test.tsx`
- `apps/web/src/features/issues/IssuePage.agent-data.test.tsx`
- `apps/web/src/features/issues/IssuePage.agent-start.test.tsx`
- `apps/web/src/features/issues/IssuePage.issue-switch-reset.test.tsx`
- `apps/web/src/features/issues/IssuePage.subissues.test.tsx`
- `apps/web/src/features/issues/IssuePanelView.artifact-open.test.tsx`
- `apps/web/src/features/issues/IssuePanelView.subissue-nav.test.tsx`
- `apps/web/src/features/issues/IssuesView.bulk-close.test.tsx`
- `apps/web/src/features/issues/explorer/IssueExplorer.test.tsx`
- `apps/web/src/features/machines/multimachine-indicators.test.tsx`
- `apps/web/src/features/mobile-handoff/mobile-handoff.test.tsx`
- `apps/web/src/features/settings/SettingsView.close-guard.test.tsx`
- `apps/web/src/features/settings/sections/experimental.mobx-sidebar.test.tsx`
- `apps/web/src/features/setup/ColdStartComposer.capability.test.tsx`
- `apps/web/src/features/setup/ColdStartComposer.default-agent.test.tsx`
- `apps/web/src/features/setup/ColdStartComposer.machine-use.test.tsx`
- `apps/web/src/features/setup/ColdStartComposer.modes.test.tsx`
- `apps/web/src/features/setup/ColdStartComposer.test.tsx`
- `apps/web/src/features/setup/FirstTaskActivation.test.tsx`
- `apps/web/src/features/setup/OnboardingWizard.test.tsx`
- `apps/web/src/features/setup/VpsFirstActivation.test.tsx`
- `apps/web/src/features/setup/use-activation-route.test.tsx`
- `apps/web/src/features/worklist/PanelRow.oom-outcome.test.tsx`
- `apps/web/src/features/worklist/PanelRow.open-todos.test.tsx`
- `apps/web/src/features/worklist/SidebarRail.design-3b.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.bring-back.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.evict.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.flat-rows.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.lifecycle.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.new-task.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.pinned.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.progress.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.rename.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.search.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.selected-weight.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.shortcuts.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.tuck.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.unread.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.working-unread.test.tsx`
- `apps/web/src/features/worklist/SidebarUnified.working.test.tsx`
- `apps/web/src/features/worklist/sidebar-common.attribution.test.tsx`
- `apps/web/src/features/worklist/sidebar-common.drawer.test.tsx`
- `apps/web/src/features/worklist/sidebar-common.error.test.tsx`
- `apps/web/src/features/worklist/sidebar-common.roster.test.tsx`
- `apps/web/src/features/worklist/sidebar-common.unread-chip.test.tsx`
- `apps/web/src/perf/slice-render-count.test.tsx`

POD-4973 owns `IssuePage.attribution.test.tsx`, `agent-panel-active.test.tsx`, and `SidebarUnified.pool-actions.test.tsx`; none was edited here. The shared chat handle also supplies terminal active's owner, and its 17 tests passed. The two real-provider tests `SidebarUnified.pool.test.tsx` and `mobile-handoff.pool.test.tsx` keep their original handles.
