# Session pane pool readers

The session panel, dock shell and chat header now have a pool read path for session status, urgency, machine metadata, ownership and the inputs to controls. The startup switch is off by default. Conversation and transcript reads retain their existing path, and writes retain the existing store actions and outbox.

## Scope and switch

`mobxSessionPane=1` selects the pool path; `mobxSessionPane=0` selects the legacy path. Both override the shared device pilot setting. The switch is read once at startup. `mobxSessionPaneCheck=1` additionally installs `window.__sessionPaneCheck()` for opt-in diagnostics.

The screen registers with the shared pool host. Its source borrows the existing runtime's panel mode, dock mappings, repository-loaded flag and pending-spawn set. It creates no second runtime, replica or outbox. Session and machine rows use the pool reader. Cold issue inputs use declared summaries and batched loading; worktree ownership uses existing inverse buckets along the cwd's ancestors, without an index over every issue.

The implementation is in [the pane reader](../../packages/client-graph/src/session-pane.ts), [its schema](../../packages/client-graph/src/session-pane-schema.ts), [the web hooks](../../apps/web/src/features/terminal/use-session-pane-inputs.ts) and [the parity check](../../packages/client-graph/diagnostics/session-pane-check.ts).

## Accepted ownership difference

POD-4286 approved the stated POD-98 ownership rule on 2026-10-02: an eligible explicit issue id wins; otherwise use the nearest containing worktree, matching cwd at a path boundary. Archived and deleted issues remain excluded. Legacy code instead took the first matching issue in collection order.

The initial private ludovico audit found 1,920 sessions with multiple eligible matches and 1,571 changed ownership choices among 5,135 sessions and 5,976 issues. This is an accepted, deliberate difference. Single-match cases preserve their previous choice. Separate planted checks prove the explicit-id and nearest-worktree halves of the rule.

## Evidence

Focused validation ran on flatblock in `~/podium-test-5092`, using its private `.toolchain` and checkout-local dependency links. No full suite or whole test lane ran.

- Twelve scoped test files passed, totaling 128 tests. They cover 23 synthetic session states, rendered panel values and lifecycle controls, dock wake targets, panel arbitration, the actual chat-header hook and shared host behavior.
- The pool hook path passed a legacy-collection access fence and recorded zero `sessionPane.*` legacy derivations. The legacy positive control recorded a derivation. Transcript calls remained on their existing route.
- Focused typecheck passed for `@podium/web`, `@podium/client-graph` and `@podium/client-core`. Focused lint passed for the changed graph source and diagnostics files.
- Twelve planted faults each produced a real failing assertion. They cover value parity, mismatch detection, cold loading, addressed updates, both ownership rules, tint inheritance, control inputs, source disposal, dock wake identity, the legacy-read fence and startup switch latching. Original bytes were restored after each run.

The completed private replay at candidate `4fdca006c2` covered 5,136 sessions, 5,979 issues and 5,142 comparison positions. It reported zero unintended differences and zero pending rows, with 1,572 accepted ownership differences as the live corpus changed. Only counts and comparison positions left ludovico; the operator server and daemon were neither restarted nor reconfigured. The replay and planted-fault summaries are also attached to the issue.

Later bounded replays after the shared-host rebase and additional capability fields did not complete; this is not a newer green replay result. A final replay remains follow-up evidence. The separate registry test currently fails on the notices and automations startup latches; POD-5307 owns that repair, outside this screen's scope.

## Remaining rollout evidence

POD-4286 cleared this code to land with the switch off after the planted checks completed. Same-SHA browser timing for session switching remains pending on POD-5091's generic `speed:gate --switch` option. The capture will vary only `mobxSessionPane`, hold `bench:flatblock` for its timing run and retain the other screen switches. No before/after timing claim is made here.

After the operator enables the screen by default, its legacy path is due for deletion within about a week, under the app-wide migration plan.
