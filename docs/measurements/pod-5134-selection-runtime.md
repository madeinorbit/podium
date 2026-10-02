# Selection runtime work cuts

POD-5134 removes shared work from the pool sidebar's startup path: repeated
whole-array optimistic folds, activity-only workspace routing/pruning, repeated
workspace-root resolution, and the explorer provider's all-issue target read.
The sidebar's gesture membership scan remains assigned to POD-5088; the
coordinator explicitly excluded its ordering change from this landing.

Selection state CPU p95 falls **38% at 1× and 61% at 4×**. At 4×, paint p95
falls **283.4 → 204.4 ms (28%)**; at 1× it is **61.8 → 63.8 ms**. The **16 ms
frame target remains unmet**. The implementation landed at `1f370aebd5`;
the exact revision's 4× capture is complete. The remaining all-issue model
caller is the shared promo's first-task predicate, filed as **POD-5215**.

## Browser comparison

Every cell below contains forty retained observations per arm. CPU is the
union of synchronous measured work, not the sum of nested helper intervals.

| Event | 1× pool state CPU p95, ms | 4× pool state CPU p95, ms |
| --- | --- | --- |
| Selection | 38.5 → 23.9 | 277.6 → 107.4 |
| Unrelated heartbeat | 38.8 → 31.4 | 215.8 → 161.5 |
| Title edit | 32.4 → 29.1 | 183.3 → 172.1 |
| Session phase | 33.1 → 30.9 | 278.9 → 147.3 |
| Draft actions | 1.5 → 1.8 | 7.3 → 6.2 |

| Selection paint p95 | Before, ms | After, ms |
| --- | --- | --- |
| 1× pool | 61.786 | 63.811 |
| 4× pool | 283.408 | 204.367 |

The unchanged legacy control also moved: selection paint **173.1 → 193.9 ms**
and state CPU **211.8 → 243.5 ms**. Raw absolute before/after figures are retained
without using the control shift to normalize a claimed paint win. All complete
records satisfy the load limit (largest recorded load **7.08**). At 4× the
legacy control shifts **1,417.9 → 1,345.0 ms paint** and **2,119.2 → 2,074.1 ms
CPU**. Code and correctness/count checks preserve the OFF path; these control
time shifts are reported rather than interpreted as an OFF implementation cut.
There is no demonstrated 1× draft-action improvement.

In the candidate's 1× pool trace number three,
input-to-selected-DOM took 46.4 ms and selected-DOM-to-paint 6.6 ms; across the
forty pool clicks those p95s were 56.5 and 6.8 ms respectively. Trace event
categories are inclusive: its 43.8 ms event dispatch includes 42.9 ms function
calls and must not be added to them.

The final comparison uses the same instrumented, ordinary production fixture
in both builds, with separate headline and sampled attribution runs.

## Attribution before the cut

The accepted run in [POD-4948 acceptance](pod-4948-acceptance.md) reported pool
selection input-to-paint p95 **67.0 / 239.8 ms** at 1× / 4×, with state CPU p95
**39.6 / 185.4 ms**. Heartbeat and title-edit state CPU were similarly expensive
despite zero sidebar pool derivations. Its profiles locate work outside the
sidebar: workspace/mission lookup, global issue models, session ownership and
optimistic/runtime publication.

The continuation adds named boundaries inside that same fixture. The following
are **means of six pool observations at 4×**, in milliseconds, from
`before-profiles`. These are inclusive intervals: nested entries must not be
added together, and they are attribution evidence, not headline p95s.

| Event | Largest measured shared boundaries before |
| --- | --- |
| Selection | issue-user optimistic recompute 71.33; runtime reactions 22.85; old issue recompute 15.58; issue-read timer 14.87; store publish 11.32 |
| Unrelated heartbeat | reactions 56.38; workspace prune 35.30; session-view construction 15.88; session/issue follow 8.80; cwd follow 7.10 |
| Title edit | reactions 11.40; old issue recompute 6.32; projection recompute 4.73; issue-read timer 3.87; publish 3.53 |
| Session phase | reactions 74.65; prune 47.65; session-view construction 16.83; session/issue follow 11.42; cwd follow 8.63 |
| Draft actions | publish 3.23; pending-by-row 0.35; reactions 0.05; snapshot 0.02 |

In the original acceptance attribution, all-issue `modelsFor` averaged
33.15 / 89.82 / 114.18 / 84.94 ms for selection / heartbeat / title / phase at
4×. Workspace-key and mission-root resolution averaged 35.60 and 39.42 ms per
selection. This report distinguishes the shared explorer caller from callers
owned by the main-pane migration, rather than changing its cache globally.

The continuation's sampled selection stacks attribute **1.44 / 9.76 ms** at
1× / 4× to the unchanged pool `sessionMembership` scan (inclusive sampled means,
six profiles per cell). This is a remaining cost for POD-5088, not an attempted
tie-order fix here.

## Per-event cuts and remaining consumers

The following **inclusive means from the forty headline observations at 4×**
compare the same named boundaries. They provide every event's attribution even
where the separate after sampling run stopped on a later load spike.

| Event | Boundary means before → after, ms |
| --- | --- |
| Selection | issue-user fold **71.02 → 0.58**; old issue fold **16.07 → 0.37**; modelsFor **33.93 → 31.30**; issue-read timer **13.19 → 11.57**; publish **10.64 → 10.20** |
| Heartbeat | prune **39.66 → 0**; issue follow **10.38 → 0**; cwd follow **8.83 → 0**; modelsFor **95.05 → 88.64**; session views **15.82 → 20.04** |
| Title | modelsFor **122.16 → 116.21**; old issue fold **7.15 → 4.21**; workspace key **8.67 → 8.28**; publish **3.84 → 3.29** |
| Phase | prune **40.85 → 0**; issue follow **10.81 → 0**; cwd follow **9.89 → 0**; modelsFor **102.58 → 83.80**; session views **16.14 → 15.87** |
| Draft | publish **4.55 → 3.88**; selectors **2.48 → 2.09**; workspace key **1.30 → 1.51**; pending-by-row **0.36 → 0.30** |

The valid after selection profiles trace the remaining `modelsFor` samples to
**MobilePromoCard → useHasFirstTask → useReplicaIssues → useAllIssueViewModels**.
The hook at `features/mobile-handoff/mobile-handoff.ts:170` asks only whether
any non-deleted issue exists; archived issues and drafts both count. It is
shared sidebar chrome, so these times should not be assigned to the main pane.
This separately shippable pool predicate is recorded as proposed **POD-5215**,
with a `discovered-from` link and coordination mail; it has not been claimed.

The six valid after pool-click profiles per scale attribute **0.77 / 7.98 ms**
at 1× / 4× to the unchanged gesture `sessionMembership` scan. Its before means
were 1.44 / 9.76 ms; since this function was not edited, the difference is not
claimed as a code improvement. `selectedMissionRoot` and `missionIssueIds`
have **zero sampled time** after, compared with 16.71 and 5.00 ms respectively
at 4× before. The explorer's direct legacy-hook and enumeration checks also
prove zero calls on its switched path.

Shared runtime issue-read timers, workspace-key lookups on copied state,
snapshot publication and session-view reconstruction still cost work. The
scalar cache covers the actual opted-in state; fresh navigation snapshots
still resolve their roots. These consumers and the promo predicate explain
why this cut alone cannot reach the frame target. Store-level legacy worklist
derivations remain zero in all pool headline records; the nonzero residual
slice counter is `sessionById`, on heartbeat/phase frames.

## What changed

- `enablePoolRuntimeWork()` is called once by the existing startup attachment
  when `mobxSidebar=1`. It changes the existing mutation owner's work; there is
  one runtime, replica and outbox. Switch off keeps the original engine paths.
- The optimistic ledger indexes its current writer base by ID and folds only
  addressed overlays. It keeps the original fold/coverage predicates, array
  order, insert handling, absent-marker behavior and shallow identity rules.
  Duplicate IDs fall back to the original implementation. The position cache
  is invalidated on base replacement and cleared on disposal; it creates no
  additional pool row or relation index.
- Workspace routing/fallback/pruning checks session identity, owner and cwd.
  Activity-only frames skip those reactions. Link arrival, read timers and visit
  baselines still run. Issue topology dirties pruning until the next session
  frame, preserving removal of stale workspace tabs after membership changes.
- Workspace-key resolution memoizes one scalar result on the existing state,
  keyed by projection-array identity, selection and worktree. Replacement,
  eviction and rescoping invalidate it.
- The switched explorer navigation provider uses `poolExplorerTarget`, with
  `poolMissionRoot` and `poolMissionContains`, through declared parent/sender
  relations and the pool reader. It reads only the selected/focused path and
  waits on `LOADING` plus the pool's batched loader. Its trail, tabs, query,
  scroll cache, closed-dock behavior and empty-replica ride-out stay intact.
  This seam is available to POD-5077; moving its main-pane callers is separate.
- Draft occupancy uses the resume-collapsed R2 session family plus the declared
  `headlessOccupied` scalar summary. Raw activity timestamps cannot establish
  occupancy: an all-parked twin may collapse onto another issue. Exited,
  non-archived headless sessions count; archived ones do not. The bit lives
  beside existing session summaries and adds no relation or MobX objects.

Old-record issue inputs remain behind `temporary-issue-input.ts`. The pool
helpers add no `peek` callers, secondary runtime or hand-maintained relation.

## Correctness evidence

All correctness runs used `~/podium-test-5134` on flatblock, the checkout's
private pinned Bun toolchain and bounded foreground commands. Focused results
are not a suite or lean-gate verdict.

- 35 selected engine/state checks passed: the new differential/budget cases,
  stable optimistic folds, atomic navigation publication, coalesced publication,
  stale workspace tabs and session-pane links. The pool-on routing, keyed folds,
  coverage and scalar cache were each proven red on planted faults; the later
  issue-topology dirty-bit case also failed on its planted omission.
- The sidebar pool-actions file passed 41 checks. The final explorer file
  passed 27, including zero legacy-hook calls and no corpus enumeration for
  target resolution. The parked-twin check failed specifically when the raw
  activity shortcut was restored.
- Final addressed-feed and schema files passed 24 and 59 checks. Both object
  census arms passed six cells each, with their two explicit skipped controls;
  all startup/first-paint baselines stayed equal, including idle/pending writer
  variants. The new summary check failed when exited headless seats were
  incorrectly excluded.
- Scoped cached typecheck covered client-core, client-graph, web and
  worklist-proto: 17/17 tasks succeeded, 14 cached. The coordinator withdrew an
  uncached rerun because no missing cache input was identified. Scoped lint
  reported no errors.
- The existing work-per-change file wrote seven arm reports before its bounded
  full-file run expired in the expensive legacy control. A separate focused
  legacy `NO` control completed: one executed check, seven deselected. This is
  combined per-arm evidence, not a successful full-file gate. Existing budget
  violations in its reports are retained, not presented as new passes.
- Two pre-existing OFF runtime assertions were reproduced on baseline
  `bdb9012521` (shipping-lane deletion and two pending unread mutations). The
  coordinator assigned their repair separately and accepted this issue's
  focused gate; this landing does not claim the complete runtime file is green.

The final read-only Ludovico target replay covered **5,786 issues, 5,079
sessions, 21,626 checks and 3,118 loading steps, with zero differences**. Checks
cover null/self/formal-root focus for every issue, plus sender-owner focus when
present; this is not an all-pairs matrix. A planted always-empty target yielded
**16,607 differences**. Only counts, positions, opaque IDs and source hashes
were exported. Raw operator payloads/logs and the private adapter directory
were deleted; no operator server or daemon was restarted or reconfigured.

## Measurement method and provenance

`apps/web/harness/selection-runtime.ts` continues the accepted synthetic
production fixture and plan: Chromium 153.0.8010.12, 1800×1000 viewport, startup
URL switch, fixed advancing clock, fresh arm contexts, six warmups and forty
retained observations per arm/event/scale. Arms alternate first position.
Selection uses a trusted pointer click on six distinct mounted targets.

Headline input-to-paint ends at the first same-renderer Chromium `Paint` after
the selected DOM mutation; the two-RAF condition is retained as an observation
guard. Synchronous state CPU is the union of measured runtime, delivery,
selector and shared helper intervals; row-render intervals are excluded and
nested intervals are not summed. Paint and CPU measure different windows.
Attribution uses separate six-observation, 1 ms sampled profiles. The after
run completed all five 1× event cells and the 4× selection/heartbeat cells
(84 valid observations, none above load eight), then stopped before retaining
4× title/phase/draft records on a load guard. Only complete valid sampled cells
are used; forty-observation boundary means supply the per-event comparison.
A sampled
profile or a two-RAF proxy is never used as a headline paint measurement.

All timing captures held `bench:flatblock`. Each retained record includes host
load and uptime; the collector rejects a host load above eight. Startup mode,
six-target nomination and required input/selected/paint evidence guards each
rejected a planted fault. Positive captures also check selected state, fixture
errors and real IndexedDB settlement.

The before build is `097cf1204`; before profiles were captured at `444718d40f`.
The original before headline run at `b6522c5f56` completed all 1× cells but hit
its foreground timeout partway through 4×. The comparison uses its complete
1× cells and **the entire fresh `before4x` retry**, also at `b6522c5f56`.
Partial 4× cells from the expired run are preserved but excluded. Phase/draft
were not patched into a fresh context: the retry ran the complete event
sequence, preserving its selection and title preconditions.

The first after ordinary-production build is `b24f9c7eba`, with the complete
1× capture at `2ef1bc8204`. Two early 4× attempts (`after4x`, `after4x-retry`)
aborted on the load guard after 13 and 24 partial observations; each contains
one observation above load eight. **All 37 partial observations are excluded**
from the comparison and the raw files remain available with a void manifest.

The implementation landed ff-only at `1f370aebd5` over `520d68c316`, under
`merge:integrate/4286-pilot`; ancestry was verified and the mutex released. The
coordinator requested landing before the remaining timing to unblock old-record
removal, with this issue kept open. The exact landed SHA was rebuilt for the
fresh, complete `landed4x` capture. The rebase changed no production code in `apps/web/src`,
`packages/client-core/src` or `packages/client-graph/src` (its web delta is a
diagnostic test); the diagnostic changes brought by integration are inactive
in these checker-off captures. The initial landed-capture host load was 1.73.

Source checkpoints, per-arm raw records, traces, CPU profiles, targets and proof logs are attached
to POD-5134; these synthetic evidence files remain uncommitted.

## Remaining work

POD-5215 owns the discovered promo predicate; it remains Proposed for another
agent. POD-5077 owns main-pane reads still backed by legacy snapshots and slices.
POD-5088 owns the gesture session scan and its session-order decision. The
snapshot publish pipeline remains until step 07. The diagnostic replay also
exposed the pre-existing cyclic-provenance nesting problem, filed separately
as proposed POD-5177 with a `discovered-from` link; it is not claimed here.
