# Worklist material input audit

The guard compares ordered inputs before derivation. It never compares results,
retains a row under a second key, or sorts away a visibility change. Unchanged
array/row references are the fast path; only changed rows are serialized. Cost is
linear in input length plus changed-row payload, with no issue × session join.
Signatures are ephemeral strings, not a cache of entities.

## Dependencies read

Read through `published`, `nav`, `rows`, `row-order`, `folds`, `visibility`,
`row-attention`, `session-ownership`, `session-urgency`, `session-status`, `focus`,
`mission`, `fleet`, issue helpers, `reposToViews`, and web/mobile row consumers.

| Input | Dependencies and decision |
| --- | --- |
| Sessions: ownership | Ordered `sessionId`, `issueId`, `cwd`, `archived`, `headless`, `agentKind`. Ownership indexes and provenance nesting must rebuild on membership changes. |
| Sessions: visibility | `status`, `stoppedAt`, `readAt`, `unread`; `agentState.phase`, `since`, `idle.kind`. Issue completion stamps also affect session decay. |
| Sessions: order and activity | `lastActiveAt`, `createdAt`, `draftUpdatedAt`, `snoozedUntil`, plus attention state. **lastActiveAt is material**, including mission continuation tip selection. |
| Sessions: attention and timing | `offer` presence/creation time; `busy`; `agentState` phase, since, workingMsTotal, idle/need/error and observationGap. Finished-issue offer suppression also reads issue lifecycle. |
| Sessions: row consumers | Name/title/kind, displayRef, issue linkage, stopReason, agentColor, handoffTarget, createdBy attribution, draft stamp; fleet reads nativeSubagentCount. Full sessions also reach contextual action menus, so remaining and unknown fields are conservatively material. |
| Session exclusions | Terminal geometry/geometryState, controllerId, epoch, clientCount, requestsGated/requestsDuplicate/requestsUnanswered; nested agentState.stateSource/stateConfidence/stateObservedAt. None is read by these derivations, row cells or row menus. No suffix-based timestamp exclusion. |
| Issues | Ordered full issue models, after the existing replica builder. Lifecycle/visibility, parent and discovered-from relations, coordinator/membership, snooze/pin/order, recency/read state, repo association, git state, display identity and draft labels are material. Full models reach row menus; retain all remaining/unknown model fields. Value-identical rebuilt models hit; differing issue content misses. |
| Repos | Ordered path, repoId, machineId, originUrl, branch; ordered worktree path and branch. These are exactly what reposToViews consumes, plus machineId for SEE scoping. Other repository wire metadata is not exported by the worklist. |
| Machines | Ordered IDs only: reposVisibleOnMachines performs a membership join. All non-ID fields are immaterial to this slice. Undefined/empty transitions and reordered or shorter feeds miss. |
| Pins | Ordered repos/worktrees paths. Panel pins are unread here. |
| Scalars | coarseNow and selectedIssueId. Clock rebuilds remain unchanged. |

This is intentionally a conservative session/issue guard, not a claim that every
retained field currently paints a cell. Unknown pass-through fields invalidate so
future row/menu readers cannot silently inherit stale values. A new exclusion
requires a dependency audit and a negative control.

## Evidence and limits

The focused A/B test uses seven real `useSlice` readers and the A2 store counters.
The legacy arm reinstates the old array-identity guard. Separate snapshot readers
render every changed diagnostic value, proving that updates still arrive.

Controlled session frames change geometry and agent observation time/confidence;
controlled machine frames change machine names. These are demonstrably immaterial
classes. This does **not** establish which fields changed in A1's 32 session-only
or 13 machine-only publications: that baseline records changed collection keys,
not per-field before/after payloads. In particular its lastActiveAt changes, if any,
must still derive. No extrapolated CPU saving or zero-idle claim is made.

Material controls exercise titles, process status, agent phase, issue stage,
snooze, staffing/ownership, eviction, readmission, order, machine scope and clock.
Every reader is compared with a fresh derivation. A title-omitting counterfactual
runs the same rendered-value oracle and must fail; deleting title from the real
signature also makes the ordinary title regression fail. The legacy performance
arm must fail the new zero-work assertion.

Measured by assertions in the focused run (three publications per class):

| Arm / input class | Publishes | Worklist derivations | Seven-reader commits | Diagnostic reader commits |
| --- | ---: | ---: | ---: | ---: |
| Legacy / session diagnostics | 3 | 3 | 21 | 3 |
| Material / session diagnostics | 3 | 0 | 0 | 3 |
| Legacy / machine name | 3 | 3 | 21 | 3 |
| Material / machine name | 3 | 0 | 0 | 3 |

All 14 material controls in each arm caused one derivation and one commit per
reader, with rendered values matching a fresh derivation. Both negative controls
were caught: the legacy arm fails the zero-work assertion and the title-omitting
mutant fails the rendered-value oracle.

Validation on 2026-09-18:

- `bun run typecheck -- --filter @podium/client-core`: 7 tasks successful,
  6 dependency tasks reused from cache.
- `bun run test:file -- packages/client-core/src/viewmodels/slices/worklist/material.test.tsx packages/client-core/src/viewmodels/slices/worklist/published.test.ts packages/client-core/src/viewmodels/slices/worklist/machine-scope.test.ts packages/client-core/src/viewmodels/slices/worklist/nav.partial-world.test.ts`:
  **4 files, 53 tests passed**. This is focused evidence, not a suite result.
- No browser lane: this changes pure store derivation, with no browser/OS event
  boundary. React commits were measured in the hermetic happy-dom test.


## Disable / revert

Revert this issue's commit, or restore the identity comparisons in
`worklistSlice.sourceEqual` (repos, machines, sessions, pins, issue models).
No schema, persistent state or row cache migration needs undoing. Keeping the
clock and membership checks is mandatory in either path.
