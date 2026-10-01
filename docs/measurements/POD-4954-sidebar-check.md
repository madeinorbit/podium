# POD-4954 — ordered sidebar differential

The checker compares the exact legacy worklist derivation with the pool's sidebar model on the same data and clock. The original synthetic acceptance was green, while the initial operator replay found **eight mismatch locations**, covered by **POD-5056 through POD-5060**. The POD-5063 follow-up below resolves them: **zero mismatches across 1,071 comparison positions**.

## Usage and comparison contract

Tests can call `checkSidebar(pool, store, sidebarState)` from `@podium/client-graph/diagnostics/sidebar-check`. The result contains the mismatch count, first section/row/field location, expected and actual IDs, loading count, and comparison sizes. An optional fourth callback receives every mismatch location for offline triage. `compareSidebarSnapshots` accepts independently built snapshots for focused fault checks.

Reload the app with `?mobxSidebar=1&mobxSidebarCheck=1` to enable the developer check. Both choices freeze at startup; the check flag alone cannot enable the pool. The first comparison runs after five seconds and repeats every five seconds. `startSidebarCheck` also accepts a positive `intervalMs` for harnesses. The performance panel shows waiting, checking, match, different or error, the check count, and the first location when different.

The checker runs on a timer, outside mount/render and outside a MobX reaction. It reads the existing StoreProvider runtime and its attached pool. It adds no runtime, replica, feed subscription, mutation owner, pool index or peek reader. Its legacy imports live in a lazy diagnostic entry, excluded from the product entry; without both flags there is no diagnostic import, timer or legacy comparison.

Sections are compared in order: pinned, each project band's open/snoozed/closed lanes, then a supplemental `all-visible` list. Header facts include labels, aliases, repository paths, ordering and fold state. Issue rows include the complete existing sidebar oracle payload, presentation inputs, normalized session rosters and status text; worktree rows include visible/stale sessions, selection and issue-owner provenance. Missing keys, extra rows, reordering and nested field changes fail. `all-visible` checks the pool's own enumerated IDs, rather than asking it only for the legacy IDs, so a retained evicted row cannot hide.

One mismatch is counted per differing row or header, with its first differing field. A row can appear in a display lane and `all-visible`, so the row count is **comparison positions**, not unique issues. Loading remains a separate count and yields `waiting` in the developer report. Only the test/offline driver drains batched loads; the checker itself never hydrates or blocks for a load.

Comparison work is bracketed with `beginSidebarCheck` before any pool or legacy reads. The passive telemetry meter classifies it as `checkWork`, excluding it from idle and incoming-update work. Diagnostic snapshots can recompute unobserved MobX values; these executions remain comparison work. The S5 reset fence ignores end callbacks from an earlier measurement generation, including callbacks that finish during a later comparison (POD-5017 folded in here).

## Negative controls

All controls ran in the foreground on flatblock in `~/podium-test-4954`, with the pinned checkout-local toolchain and timeouts. Every source plant used a `cp` backup and `cp` restore before accepting its clean result. WIP checkpoints preceded edits and runs.

| Plant | Observed failure | Checkpoint |
| --- | --- | --- |
| Drop `color` from the real pool row payload | Corpus comparison fails with 1,004 mismatching positions; first field `color` | `9beb9e9b3` |
| Reverse the real pool's sidebar bands | Corpus comparison fails with 30 differing section positions; first field `section` | `a5492d650` |
| Drop removal events so an evicted row remains | `evictWithoutRevision` fails with 27 mismatching positions; first field `id` | `7e854b4c3` |
| Omit the outside comparison bracket | Timer test finds comparison rows/derivation in idle work instead of `checkWork` | `c3a407d3d` |
| Enable check in legacy mode, skip timer cleanup, report errors as matches | Four selected startup/teardown/state assertions fail | `a789b343f` |
| Hash the legacy `origin` enum while preserving `intentOrigin` | Export fidelity regression fails | `7b92844ba` |
| Suppress the every-location callback | All six fault cases fail their complete-location assertions | `ba19ed30c` |
| Remove the reset-generation guard | Both old-completion cases fail: before and during the next check | `7a4b039d9` |

## Synthetic acceptance

The new differential ran at **1x and 4x**, comparing the initial corpus, every one of the **16 methodology changes**, and rescope growth and return: **19 checkpoints per scale**, all with zero differences and zero pending loads. It also compared cold bootstrap and two fresh principals after batched loading. Observed pool snapshots stayed alive throughout scenario and generated-change replay to expose stale computed caches.

The generated-change run uses the existing gate seed/step settings and `forceSidebarValues`. Defaults were **seeds 1, 2 and 3, 200 changes each**; every step was compared, including reload/rebind, selection and fold/order changes. All **600** comparisons were equal. The five synthetic result files are written under the ignored harness browser results directory as `sidebar-check-1x`, `sidebar-check-4x` and `sidebar-check-seed-{1,2,3}` JSON.

The combined prototype run collected the new differential, existing sidebar oracle and existing legacy oracle: **37 tests, three files, green** at `7f3245855`. Adding complete-location reporting later required only the changed ordered-comparison group: **eight passed, six replay tests deselected** at `8938db8d6`; comparison behavior with no callback was unchanged.

## Operator export — ludovico only

The offline CLI is `packages/worklist-proto/harness/src/oracle/sidebar-replay.ts --snapshot <export.json.gz>`, run with the pinned Bun and `--conditions=@podium/source`. It rejects any host other than ludovico. The export is seeded into an in-memory kernel replica, and both derivations read that same snapshot and clock. No running app, browser, second production runtime or live write is used by the replay.

The export and raw command logs stayed in the ignored local `.live` directory. The shell redirected all exporter/replay output there, printed only the replay's counts and opaque-ID locations, and removed all three files in an exit trap. No export, dump, screenshot, path value or row content was copied, committed, attached or mailed. A subsequent directory census found no remaining files.

The first export exposed a fidelity error: `origin` was hashed while normalized `intentOrigin` was retained. The exporter now preserves both enum spellings; its regression was proven red and the **15-test shape file** was green at `3bdf32c7c` before the faithful replay.

Initial replay at `ce73b0feb` (session-order fidelity corrected below): **5,602 issues, 5,013 sessions, 35 sections, 1,070 row-comparison positions, eight mismatches, zero pending loads**. Three issue-row differences each appear twice; two section headers differ. Every observed location is covered below. Indices are zero-based; section keys and field values were withheld because they can contain private paths or text.

| Follow-up under POD-4948 | First field | Observed positions `(sectionIndex, rowIndex)` |
| --- | --- | --- |
| POD-5056 — Sidebar fleet presence | `fleet.total` | `(1, 1)`, `(34, 759)` |
| POD-5057 — Sidebar timing anchor | `timing.sinceMs` | `(19, 74)`, `(34, 481)` |
| POD-5058 — Sidebar continuation reference | `continuation.ref` | `(19, 79)`, `(34, 503)` |
| POD-5059 — Sidebar section label | `label` | `(22, null)` |
| POD-5060 — Sidebar repository path | `repoPath` | `(31, null)` |

The follow-ups contain only the three opaque issue IDs and these locations/counts. They must verify export fidelity while reducing each case to synthetic data before changing product behavior. No real-data mismatch has been suppressed or allowlisted.

## Closing validation

All tests, typecheck and lint ran over SSH on flatblock, sequentially, using only this issue's checkout-local dependency graph and toolchain. The local ludovico run was solely the explicitly requested offline real-data acceptance. Passed checks were not repeated on unchanged code; changed comparison reporting and the reset fence received focused follow-up checks.

| Check | Result | Checkpoint |
| --- | --- | --- |
| Prototype differential + existing sidebar/legacy oracles, package config | 37 passed, three files | `7f3245855` |
| Export shape/fidelity, package config | 15 passed, one file | `3bdf32c7c` |
| Every-location reporting group, package config | 8 passed, 6 deselected | `8938db8d6` |
| Startup flag, app owner attachment, timer/error/accounting | 25 passed, three web files | `89c3d4bdb` |
| Perf generation fence and direct timer consumer via `test:file` | 11 core + 2 web passed | `6177cd884` |
| Existing pool gate's row-field exhaustiveness and oracle parity | 2 passed, long L4b replay deselected | `ea75351ee` |
| Uncached typecheck, `--only` client-core/client-graph/worklist-proto/web | 4 projects green | `393b6b3b9` |
| Graph/prototype package lint, merge-shadowing, span-effects | Green; 158 span bodies, 0 unclassified effects | `80b858855` |
| Lean gate | **Green: 4 of 1,696 files (0.2%), 153 executed tests** | `1a04a86f2` |

The lean gate's counts are from its own report: runtime boot 16, server router wiring 41, daemon connection state 56, test configuration 40. The first lean attempt failed because flatblock had no `node` spelling for a Turbo subprocess; adding the start-note-approved `.toolchain/node -> bun` alias fixed that checkout-only prerequisite. Only the failed lean gate was retried. The default gate's typecheck stage had already been replaced by the operator-required uncached affected-project run; span-effects and the unchanged four-file lean runner then supplied the remaining stages.

These are focused correctness and boot/wiring results. No whole-suite, long L4b, performance benchmark or browser lane ran. The changed boundary is timer ownership/accounting, covered by focused runtime tests; no pointer, OS, browser-new-tab or desktop-shell dispatch changed. Documentation and final trailing-whitespace cleanup do not require repeating runtime checks.

At the original checker landing, every observed real-data difference was filed under POD-4948; POD-5056–POD-5060 remained open. The follow-up below closes that parity work. The operator's pilot landing target is `integrate/4286-pilot`; publishing or moving `dev/mw` remains a separate operator decision.


## POD-5063 real-data follow-up

A fresh ludovico-only export contains **5,610 issues, 5,014 sessions, 35 sections and 1,071 comparison positions**. Its initial replay reproduced all eight locations. The final replay, after rebasing the five child commits onto POD-4955, reports **0 differences, 0 pending loads, no first difference and an empty locations list**. No comparison was suppressed or allowlisted.

| Child | Field | Fresh-export positions | New checks failing with planted faults | Restored checks passing |
| --- | --- | --- | --- | --- |
| POD-5056 | `fleet.total` | `(1, 1)`, `(34, 760)` | 3 | 3 |
| POD-5057 | `timing.sinceMs` | `(19, 74)`, `(34, 482)` | 2 | 2 |
| POD-5058 | `continuation.ref` | `(19, 79)`, `(34, 504)` | 4 | 4 |
| POD-5059 | `label` | `(22, null)` | 2 | 2 |
| POD-5060 | `repoPath` | `(31, null)` | 4 | 4 |

Fleet and timing shared a replay-input defect: transport order selected a different exact-rank resume twin from the actual runtime. Replay now seeds sessions in replica order. The permanent tie test constructs the real `ClientRuntime` and compares its legacy answer with replay; restoring the original transport-order input fails both tie variants. The pool's existing lower-ID tie rule and legacy behavior remain intact.

The three pool corrections follow the legacy rules: staffed continuation tips prefer activity regardless of closure, section labels come from the first root before nesting, and section paths prefer a registered root, then the first open issue, then the section key. The label reads existing group membership and cached placement; no cold-ID index, peek caller, runtime, replica, outbox or old-record field was added. Switch-off code was untouched.

All 15 new checks were proven red with targeted source faults and restored with `cp`. Closing validation on flatblock executed **27 checks in five focused files**, with nine deliberately deselected cases, plus both affected uncached type targets and scoped lint. The final combined-candidate run preserves POD-4955's rail counters, companion projection bridge and checker teardown. This is focused correctness evidence; no full-suite or performance claim is made.

The export and every raw replay/inspection log were deleted from ludovico after the final replay. Only counts, positions, field names and opaque IDs are retained as evidence. The independently shippable snoozed-roster label finding is Proposed POD-5070, unclaimed, with a discovered-from dependency on POD-5063.
