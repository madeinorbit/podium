# Selection runtime work cuts

POD-5134 removes shared work from the pool sidebar's startup path: repeated
whole-array optimistic folds, activity-only workspace routing/pruning, repeated
workspace-root resolution, and the explorer provider's all-issue target read.
The sidebar's gesture membership scan remains assigned to POD-5088; the
coordinator explicitly excluded its ordering change from this landing.

## Browser comparison

Candidate capture pending. The final comparison uses the same instrumented,
ordinary production fixture in both builds, with separate headline and sampled
attribution runs. The 16 ms input-to-paint target remains the acceptance bar.

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
Attribution uses separate six-observation, 1 ms sampled profiles. A sampled
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

The after ordinary-production build is `b24f9c7eba`. Source checkpoints,
per-arm raw records, traces, CPU profiles, targets and proof logs are attached
to POD-5134; these synthetic evidence files remain uncommitted.

## Remaining work

POD-5077 owns the main-pane reads still backed by legacy snapshots and slices.
POD-5088 owns the gesture session scan and its session-order decision. The
snapshot publish pipeline remains until step 07. The diagnostic replay also
exposed the pre-existing cyclic-provenance nesting problem, filed separately
as proposed POD-5177 with a `discovered-from` link; it is not claimed here.
