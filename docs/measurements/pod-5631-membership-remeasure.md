# Remaining sidebar and phone membership work

Step 1 is complete. F08/W03 still has live group, band, phone section and worktree filter work. POD-5822 removed the old worktree whole-roster sort and the keyed phone section computeds; those are no longer build targets. No production file or existing test changed in this pass. Implementation is pending the next instruction, and this issue should remain open.

Measured pilot: `a3177c8f1718ad4ec9de051397c2790df3de57db`, 2026-10-09. The POD-5822 branch is an ancestor of this tip. The issue branch was rebased onto it before setup or measurement, and the pilot remained at that SHA through the final measurement. The frontend data guide and POD-5822 naming table were read at this base.

## What remains

| Area | Current evidence | Work that remains |
| --- | --- | --- |
| Desktop band/section membership | `packages/client-graph/src/worklist/sidebar.ts:169–178,227–234,255–369,373–395,428–445` | Keyed section, band-spec, band, group and roster views still return rebuilt records/arrays and compare structurally. Band specs enumerate projects/group keys, build a temporary map, sort twice and find saved aliases. A lane change rebuilds its band and the whole band-reference array. Layout keys still include all collapsed state. |
| Group row membership | `packages/client-graph/src/worklist/groups.ts:280–302,305–331,416–426` | `sidebarRows` slices all three root lanes, then applies the selection latch and structurally compares the bundle. Separate base/open/closed lists also copy their lanes; the latched closed list filters its lane. Group keys still collect/sort group heads. Existing `SortedLanes` filing is incremental; it is not evidence of a remaining whole-issue/session regroup. |
| Phone Work membership | `packages/client-graph/src/worklist/mobile.ts:55–75,87–124` | Lists now are lazy shallow-equal ID fields. `allIds` concatenates members; `attentionIds` filters them with a worktree-array membership check; `liveIds` filters with an attention-array membership check. Global attention and section-key lists flatten/visit all sections. `pending` scans all section members. Correct field ownership/equality did not remove these walks. |
| Phone native boundary | `apps/mobile/src/lib/work-sections.ts:145–196,289–320`; `apps/mobile/src/screens/WorkScreen.tsx:175–202` | The empty-search native projection still maps every section, conditionally walks/remaps a changed section's complete data, and compares the outer array. A fold reuses that native source but maps and compares every section descriptor. It does not rerun the pool search projection merely because the fold set changed. |
| Worktree membership/filter copies | `packages/client-graph/src/worklist/worktree.ts:25–40,47–85`; `packages/client-graph/src/worklist/sidebar.ts:74–91` | Candidate/represented/retained lists still walk their related set. `stale` slices stale candidates and filters sessions; `visible` filter-copies the entire ordered roster and checks `stale.includes`. Those projections rerun when roster membership/order actually changes. `waitingCount` also scans the roster on an order-only change (`worktree.ts:131`), a narrow scalar follow-up to avoid when narrowing phone membership inputs. |
| Live desktop consumers | `apps/web/src/features/worklist/pool-sidebar.tsx:113–135,169–184,255–274`; `pool-sidebar-rail.tsx:62–84`; `use-pool-unified-work.ts:195–210` | The sidebar builds slots for every band/lane, filters them for its count, reconstructs maps and compares every target value when sections change. The rail rebuilds bands and flattens all issue IDs before taking the shortcut prefix. Worktree selection copies/filter-joins that worktree's full session relation to pick a pane. These are source-read findings; the focused probe does not mount these React components or claim their complete interaction counts. |

The current `Worklist.view-model.ts` no longer contains the old rebuilt worktree projection cited by W03 at its historical line 79; the live membership questions moved to `WorklistWorktree`. Findings above use the agreed fields directly, including `sessions`, `sessionCount`, `workingCount`, `visibleChildIds` and `visibleDescendantIds`.

## What was removed or is no longer a live caller

- Worktree order is now an addressed `createQueryResult` over resident candidates (`worktree.ts:47–68`). Its order input reads each session's `sortKey`; initial demand sorts once in the data layer (`query-result.ts:109–120`), while later edits replace ordered tree paths. There is no whole-roster sort in the current worktree companion. POD-5822's unchanged heartbeat test confirms no Array sort on an unrelated heartbeat.
- Phone `MobileSection` / `MobileSectionsView` replaced the keyed section computeds. Their shallow lists preserve IDs and LOADING/readiness behavior; the remaining issue is their member walks and the native boundary above.
- Client-core `compose/worklist/rows.ts` and `nav.ts` now retain value types, not the legacy global constructors. Whole-world construction lives in `tests/worklist/legacy-values` as the oracle.
- No production callers remain for `partitionWorkItems`, `sessionsNeedChildRows`, `groupSessionsByParent`, `orderedSidebarProjects`, `orderProjectItems` or `orderProjectGroups`. `partitionStaleSessions` remains a compatibility fallback in `UnifiedWorktreeRow.tsx:71–72`; its only production JSX caller, `pool-sidebar.tsx:859`, passes a `WorklistWorktree`, so the fallback is not taken. `mergeVisibleProjectOrder` is used by the project-management dialog on save, not live sidebar/phone membership. `use-sidebar-projects.ts` has no production importer. These helpers do not justify an I+S live-sidebar claim at this tip.

## Fresh measurements

All commands ran in the foreground on flatblock in `~/podium-test-5631`, with a copied `.toolchain`, checkout-local frozen dependencies, pinned Bun 1.4.2 and `node -> bun`. No tests ran on the agent host and no validations overlapped.

`bun run speed:structural` ran under the acquired `meter:flatblock` lease: **30 checks passed, 7 filtered/skipped, 3 files**, 55 screen readers, 1,638 per-reader counters and **zero unexpected failures**. Five existing exceptions belong to POD-5421/POD-5422 (navigation and superagent); none is sidebar/phone section membership. Peak recorded process RSS was 4,844,004 KiB, within the census exception, with neither memory stop condition reached. The lease was released.

In that canonical corpus, desktop section projection and worktree derivations were zero on the heartbeat at both scales. The phone section reader ran one internal `WorklistIssue.rosterIds` derivation at each scale, but no `MobileSection` or `MobileSectionsView` projection. Selection and lane-change counters stayed flat. This green is the existing script's result, not proof that all F08/W03 triggers or rosters are bounded: its actions do not include fold or reorder, and it does not grow the changed band's roster independently.

The focused probe `tests/worklist/harness/src/sidebar-membership-remeasure.test.ts` holds the drawn prefix at five rows, uses the real phone native projection, keeps closed row bodies unmounted, and separately grows members (16→64 per band/roster, four bands fixed) or groups (4→16 bands, 16 members and roster sessions fixed). Each event checks its actual selection, fold, order or membership effect. Counts below are **distinct elements**, including observable fan-out; they are not timings or render counts.

| Trigger | Members 1x→4x | Groups 1x→4x | Row calls / derivation bodies at either scale |
| --- | ---: | ---: | ---: |
| Selection click | 51→51 | 51→171 | 0 / 1 |
| Native section fold | 6→6 | 6→18 | 0 / 1 |
| One issue reorder | 222→414 | 222→534 | 23 / 39 |
| One issue moves to snoozed | 189→237 | 189→309 | 22 / 40 |
| Unrelated session heartbeat | 116→116 | 116→212 | 6 / 7 |
| Roster-tail heartbeat moves it first | 98→146 | 98→98 | 8 / 20 |

Named mechanisms make the retained walks explicit: on reorder, `GroupNode.sidebarRows` visits 16→64 elements; `MobileSection.projectOpenIds` visits 14→62; `allIds`, `attentionIds` and `liveIds` each visit 15→63. On the roster-tail heartbeat, `WorklistWorktree.visible` and `waitingCount` each visit 16→64. The unrelated heartbeat reruns **zero band/group, phone section or worktree projection bodies**, and no ordering query, at both scales; its remaining group-sensitive total is observable fan-out, not a section rebuild. Native folding never scans member arrays in this probe, but still visits section descriptors (6→18).

The probe passes its event-effect checks and reports growth; it deliberately introduces no performance allowance or green performance claim. Complete per-reader attributions and canonical selected-reader counters are in [pod-5631-membership-counts.json](pod-5631-membership-counts.json). Raw canonical output is attached to the issue.

## Validation and limits

The unchanged `state-parity.test.tsx` passed all 75 cases, including phone fold/selection membership and worktree waiting/working/queued/stale parity with the frozen old implementation, plus the no-sort unrelated-heartbeat check. The unchanged `sidebar-bands.test.ts` passed: one changed band and section list at 4/16 bands, zero band-spec rebuilds. Those existing files were not rerun after the probe-only corrections. The final focused measurement file passed one case, with 315,464 KiB peak recorded RSS. No ordinary worker approached the 3 GiB stop threshold.

The first focused run stopped the new probe before measurements: the synthetic closed row omitted `closedReason`. Its fixture was corrected to the existing top-level-closure rule. A subsequent probe revision separated native-only folding from pool source reads, matching WorkScreen's two memo boundaries, and changed the roster heartbeat from an already-first session to the tail so it proves a real order change. The final counts above come only from that final probe.

No old production code was deleted and no new membership implementation was written, so this pass has no old/new replacement or mutation proof to claim. Existing parity evidence remains intact. Desktop fold mount/animation and phone cold/LOADING demand guards were source-reviewed, not browser-driven: desktop `FoldPanel` and row windows (`work-folds.tsx:272–330`, `pool-sidebar.tsx:513–540`) and phone `PoolFold` (`WorkScreen.tsx:423–427`) still guard body mounting; they are unchanged. The synthetic measurement uses resident records and does not establish new cold-index parity.

This evidence-only branch is committed but unlanded. The before-landing lean gate, full typecheck, interaction ratchet and normal web build were not run; no landing was attempted. Step 2 should address the measured projection/copy paths while preserving these guards and the POD-5822 field names. No unrelated fix or allowance was added.
