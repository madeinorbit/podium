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

The refreshed validation ran at candidate `f404b8db67` on flatblock in `~/podium-test-5092`, using its private `.toolchain` and checkout-local dependency links. It includes the relation engine, shared host and shared pilot-switch repair. Following POD-4286's explicit request, the whole focused batch held `bench:flatblock`; the lease was released immediately after the probes restored their source bytes. No full suite or whole test lane ran.

- Thirteen scoped test files passed, totaling 129 tests in two collected groups (7 graph tests and 122 web tests). They cover 23 synthetic session states, rendered panel values and lifecycle controls, dock wake targets, panel arbitration, the actual chat-header hook, shared host behavior and the repaired screen registry.
- The pool hook path passed a legacy-collection access fence and recorded zero `sessionPane.*` legacy derivations. The legacy positive control recorded a derivation. Transcript calls remained on their existing route.
- Focused typecheck passed for `@podium/web`, `@podium/client-graph` and `@podium/client-core`: 16 required tasks succeeded, including ten cache hits. Focused lint passed for the seven changed graph source and diagnostics files.
- Twelve planted faults each produced a real failing assertion. They cover value parity, mismatch detection, cold loading, addressed updates, both ownership rules, tint inheritance, control inputs, source disposal, dock wake identity, the legacy-read fence and startup switch latching. Original bytes were restored after each run.

The final private replay at candidate `9df0b71249`, after the shared-host rebase and capability-field additions, covered 5,139 sessions, 5,988 issues and 5,145 comparison positions. It reported zero unintended differences and zero pending rows, with 1,571 accepted ownership differences as the live corpus changed. Two hydration rounds drained the initially cold rows. Only counts and comparison positions left ludovico; the operator server and daemon were neither restarted nor reconfigured. The replay and planted-fault summaries are also attached to the issue.

Earlier bounded replays either failed to connect or did not complete. The result above is the completed run, using the source export condition. The earlier registry failure in the notices and automations startup latches was repaired by POD-5307 at `17fd640a3f`; the refreshed 13-file run confirms the registry is green with this screen registered.

## Startup attachment proof

The pane hooks choose their read path from the startup latch, including while the pool is absent. The session guard receives an empty array in that phase, so it also keeps its pool branch. No hook choice depending on pool availability was found.

[The attachment regression](../../apps/web/src/features/terminal/session-pane-attach.test.tsx) mounts the real StoreProvider, web pool host, runtime and session-pane source with the pilot on. AgentPanel, dock recovery controls and the actual chat-header hook render first without a pool, then with the attached pool and catalog enrichment. Both normal mode and StrictMode reach the expected values without a React hook warning, and the actual runtime's legacy pane counters remain zero.

After rebasing onto frozen session read views and the relation updates, candidate `5009621807` passed four focused files on flatblock: 7 graph tests and 17 web tests, totaling 24. The web typecheck passed all 16 required tasks, including ten cache hits. Focused Biome lint exited zero for the new test, with four non-null assertion warnings. This batch followed POD-4286's revised rule: wait while the one-minute load exceeds 8, without taking the timing lease.

A planted change made `usePaneSession` choose the legacy hook while the pool was absent and the pool hook after attachment. Both attachment cases failed; React's hook-order warning named AgentPanel and the changed hook slot. The driver verified restoration of the original source bytes. Its count-only summary is attached to the issue.

## Native transcript reference underlines

AgentPanel's native reference underlines now reuse the pool's device-side reference lookup when `mobxSessionPane=1`. The terminal asks for individual reference stages; only those demanded stages are observed. A stage change schedules the existing underline repaint without rebuilding the panel, while title-only changes do not repaint. Cold identities and rows load through the existing pool window. Watchers stop when the pane or pool departs. The off path retains its issue-array trigger and previous stage resolver. Transcript content and transport are unchanged.

The rendered comparison covers ordinary and archived issues, deleted and unavailable references, whitespace and leading-zero spellings, malformed and session tokens, cold local loading, stage updates and cleanup. It asserts that AgentPanel never calls `useReplicaIssues` on the pool path. The store-owned `sessionPane.referenceIssues` counter is zero on that path and positive on the legacy control.

Candidate `ee07a4c29b` passed four focused files on flatblock: 15 web tests and 13 terminal underline tests, totaling 28. Both real attachment modes remain green. The web typecheck passed all 15 required tasks. Forcing the reference hook back onto its legacy branch made four assertions fail, including actual runtime reference-read counts of four in normal mode and eight in StrictMode. Original source bytes were restored and verified.

After adding explicit types to test-only mock buttons, the reader, hook and comparison test passed focused lint at `b1065cf396`, with 20 non-null assertion warnings. Full-file AgentPanel lint still reports the pre-existing `pickModeWithTrace` dependency omission in its desktop shortcut effect. The same error was reproduced on integration baseline `0c19f9ca85`; this migration adds no lint error there. That separate work is recorded as Proposed POD-5346, and the legacy shortcut block is unchanged.

## Paired browser timing

The session-only pair is green. Four ordinary `speed:gate` captures ran on flatblock at frozen source `a747560f4d` (local tag `pod-5092-session-pair`), using POD-5091's generic URL overrides from `439580c135`. Every capture used the same source SHA, machine, browser, seed, targets and byte-identical minified production output. Only `mobxSessionPane` varied, in off/on/off/on order; `mobxPane=0` and `mobxSessionPaneCheck=0` stayed fixed. The fixed 4× fixture enforces at least 19,000 issues and 17,000 sessions. No operator RPC or feed call is permitted by the harness.

Each arm has two fresh-browser captures and twelve measured session samples in total. The existing gate comparator applied its fixed 10% median guard to the session action:

| Session input to actual Chromium Paint | Legacy | Pool |
| --- | ---: | ---: |
| Combined median | 1029.780 ms | 1018.880 ms |
| Worst sample | 1204.847 ms | 1144.907 ms |
| Capture 1 median | 1053.843 ms | 1027.626 ms |
| Capture 2 median | 1014.317 ms | 1001.261 ms |
| Spread between capture medians | 3.822% | 2.599% |

The pool median is 1.059% lower, smaller than the spread between captures. This proves the requested guard; it does not establish a meaningful speed improvement. All four ordinary gates also passed their historical five-action baseline checks, but those historical reductions are not attributed to this screen migration. The paired summary and four raw capture reports are attached to the issue. The timing lease covered the capture batch and was released immediately after it completed.

## Rollout

After the operator enables the screen by default, its legacy path is due for deletion within about a week, under the app-wide migration plan.
