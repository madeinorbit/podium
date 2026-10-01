# POD-4956 — sidebar interaction parity

The pool sidebar uses the current store actions and outbox for every interaction. **39 interaction checks** cover navigation, menus, editing, drag, folds and shortcuts, with clean S5 comparisons across pending writes, receipts, rollback, eviction and readmission. Chromium also verifies real pointer/keyboard input and immediate rename, pin and archive results, followed by refusal and restoration.

## Behavior and ownership

`use-pool-unified-work.ts` follows the formal mission at every depth, then the provenance chain of its attached sessions. Archived and headless senders can supply provenance; pane candidates keep the legacy membership filters and slice-order tie breaking. Selecting a child selects its mission root, keeps the clicked worktree/file candidates, traces the chosen session, batches navigation/read/defer/session-read, and focuses the clicked issue after the batch.

Navigation and provenance filter normal sessions through the existing R2 membership relation, which already applies resume collapse. Headless senders never collapse and remain eligible for provenance. A loading mission ancestor queues its load and returns before trace, navigation, read commands or focus; after hydration the child selects the true mission root. Menu input is resolved on open from resident keys and the pool's one reader. It carries raw unread state, raw member IDs and child counts needed by the unchanged shared menus. Rows still use the existing rename editor, drag planning, folds, confirmations and command shortcuts. No pool mutation API, additional outbox, replica or runtime was added to the product path. The startup switch and legacy branch are unchanged.

The full 38-check interaction run was repeated after POD-4969 landed normalized issue-record and user-state writes at `104c517df`; its changed mutation owner passed all checks. The final loading-ancestor case was then tested separately. The temporary legacy issue part remains inside that same integrated outbox entry until the record migration removes it.

Two shared-reader defects surfaced in the interaction acceptance:

- A cursor-only optimistic update kept its borrowed issue body. Refusal re-emitted that same body, and the identity fast return failed to restore the separate cursor lane. `tables.ts` now restores that lane on the unchanged-body path; equality still suppresses redundant notifications.
- Legacy mission presence counts nonarchived, nonexited headless and shell sessions as staffed. Normal and shell presence already comes from retained R2, preserving resume-twin collapse. The existing declared raw-session summary now carries only the missing headless staffing bit. `standingOf` consumes it during the existing own-row read, and `openOwnPartOf` reuses that standing for progress, vacancy and continuation. Visible rosters, session ownership and pane filters retain their current rules.

Both fixes have separate commits and exact pool-path negative controls. The summary retains two timestamps and one boolean, without retaining session records. Headless exit, archive and return transitions also stay clean. Gesture/menu membership covers resident sessions only. No new peek reader, row read, cold load or cold-row index was introduced by the presence supplement.

## Interaction coverage

| Surface | Evidence in `SidebarUnified.pool-actions.test.tsx` |
| --- | --- |
| Select issue/member | Mission root, explicit pane, trace/batch/focus order, deduplication, deep formal descendants, filed chains, headless/archived starters, spin-off departure, archived parents, shell/guest filtering, collapsed-pane and collapsed-sender regressions |
| File/worktree/panel | Keep a mission file pane; no redundant/file trace; worktree containment; explicit panel; existing session-read command |
| Unloaded row | LOADING, no mutation/focus, repeated clicks coalesce into one two-row load; a loaded child waits for its loading ancestor, then selects the true grandparent root |
| Rename | Enter, blur, Escape, whitespace, menu editor, immediate paint, refusal, accepted write awaiting echo, later-write rollback |
| Reorder/pin | `planReorderKeys` backfill; moved-row-only pin/unpin; existing update commands; every queued refusal rewinds |
| Tuck/folds | Tuck refusal, accepted tuck and echo, closed-row click latch, actual Bring back menu, grace-window disabled explanation |
| Archive/delete | Quick closed-fold exit, archive all, existing confirmation flows, optimistic disappearance and refusal readmission |
| Shared issue menu | Open in tasks, rename, pin/unpin, status/close, colour, raw read/unread, defer/undefer, placement, cascade counts, handoff, current visible/hidden vocabulary |
| Eviction/readmission | Clear previously seen selection, no deletion toast or re-request, normal readmission |
| Command hold 1–9 | Actual settled column order, folded/collapsed exclusion, select all nine, release/blur cleanup |

The synthetic action fixture removes compatibility fields that production canonical projections do not contain. The app's real optimism ledger and receipt chain drive the tests. Only diagnostic comparison code invokes the legacy oracle; a mounted pool consumer trying to read `worklistSlice` throws.

## Negative controls and closing evidence

All 39 new interaction checks rejected planted mistakes before their green result counted. Plants suppress or corrupt navigation, focus, rename, archive, reorder, tuck, menu input, eviction handling and shortcut numbering. Additional exact controls reject the unchanged-body cursor omission, omission of the staffed summary, raw resume-twin membership and selection while an ancestor is LOADING. Every plant used `cp` backup/restore and WIP checkpoints.

| Check | Result |
| --- | --- |
| Focused pool-path interactions, web config | 38 passed in the full run after normalized writes landed; final loading-ancestor case 1 passed separately |
| Exact shared-reader negative controls | 3 failed on plant; all 3 passed restored |
| Required shared-arm checks, package config | 67 passed, 2 skipped; final retained-session regressions 17 passed |
| MobX census, bare/idle/pending at 1x/4x | 6 passed, no issue-added tracking objects or reads |
| Default L4b correctness gate and built-in plants | Seeds 1/2/3 × 200 steps passed; all 21 built-in fault controls rejected |
| Chromium pointer/keyboard proof and four phase controls | Four controls rejected their plants after clean boot; positive run has 9 clean S5 checkpoints |
| Uncached affected-project typecheck | Graph, prototype and final web guard passed |
| Scoped lint and span-effects | Web and final guard zero errors, assertion/style warnings retained; both package linters green; span gate 160 bodies, 0 unclassified effects |
| Lean run and routing repair | Initial run 152/153 passed; the missing server-test lane was fixed and all 50 focused configuration/shard checks passed; the other 113 unchanged lean checks were retained |
| Private live-data comparison | Clean, no pending loads; live rows stayed in RAM on ludovico and only terminal counts were emitted; no result file, export or dump |

Tests, typecheck and lint run sequentially in `~/podium-test-4956` on flatblock with checkout-local Bun 1.4.2 and dependencies. This is focused evidence, not a whole-suite result. The unrelated focused-runner reporter option collision is Proposed POD-5096; standard verbose reporting supplies this issue's evidence.

The lean run executed all four prescribed files, 153 checks, out of 1,703 node-project files (0.2%). Its one failure identified POD-4971's new `relay.mail-eligibility-record.test.ts` missing from the generated roster. POD-5102's generator repair adds three lines across `apps/server/test-shards.json` and `apps/server/turbo.json`: boundary membership plus paired cache inputs. `scripts/test-configuration.test.ts` and `scripts/server-test-shards.test.ts` then passed all 50 checks. The three unchanged boot/router/connection files and their 113 checks were not repeated. No narrowed command is reported as a fresh complete lean-gate run.

The browser fixture contains synthetic rows only. Its driver uses the real mouse grip/drop boundary and rename keyboard input, waits for paint before diagnostic comparison, and records action-to-observed-paint delay and heap use. Those values include automation scheduling; heap includes the fixture and diagnostic oracle. They are interaction evidence, not a performance comparison. The principal/rebuild and no-legacy-derivation browser proof already landed under POD-4957 remains the pilot's separate performance evidence.

| Synthetic pending interaction | Action to observed paint | Heap at checkpoint |
| --- | ---: | ---: |
| Pointer reorder | 334.4 ms | 32.80 MiB |
| Drag to pin | 277.9 ms | 33.66 MiB |
| Inline rename | 57.7 ms | 32.32 MiB |
| Quick archive | 140.7 ms | 41.32 MiB |

The nine comparisons cover initial state and pending/refused state for each interaction. Archive refusal readmits the row. Four separate browser fault controls booted with a clean initial comparison, then failed when their corresponding write was suppressed or corrupted. Those controls ran with timing/heap collection disabled during another issue's benchmark window; the positive timed run held `bench:flatblock` and `test:heavy`, then released both.

Landing target: `integrate/4286-pilot`. The operator owns promotion to `dev/mw`.

## Census attribution

The last baseline writer was POD-4953 commit `3cb72877e`. Historical package-config runs measured all six census cases at each landing; the baseline and POD-4954 checkpoints were green. The following table accounts for every later delta. Other landings stayed red against the stale baseline without introducing another change.

| Landing | Delta from preceding checkpoint |
| --- | --- |
| POD-4954 `ec3882425` | None |
| POD-4955 `9577ef4f6` | Retained rail offer reads: first paint +73/+144 and first reactive run +73/+179 at 1x/4x; pending 4x bootstrap +1 read |
| POD-5056 `9064d418a`, POD-5057 `25528807a`, POD-5058 `7277a2f53` | None |
| POD-5059 `13a4095a0` | Eight cached `GroupNode.sidebarMetadata` computeds at both scales; corresponding declaration, construction, change and run counters +8 |
| POD-5060 `452c9a155` | Removes the temporary +8 computation runs, reusing the original metadata fallback |
| POD-5072 `fe4269e50`, POD-4957 `366244a62`, POD-5062 `de32891c4` | None |
| POD-5033 `3a827e0dd`, POD-5071 `2a156cd2c`, POD-4967 `dd0d3a6a6` | None |

The separate baseline commit changes 43 counters, each with a `perKeyChanges` explanation. Section owners stay at eight while visible rows grow from 732 to 2,928: the extra computed is per visible section. Rail summaries consume retained visible-session offers and cached verdicts; they retain counts, not another history index. The fixed 20-row observer window and list-root roster composition differ at 1x/4x, so the read delta is not four identical windows. Earlier history and sidebar attribution remains in the file.

An initial presence supplement incurred 725/2,899 extra first-reactive reads and a pending 1x bootstrap re-evaluation. `standingOf` now borrows `sessionFacts` once for both its existing activity fact and the headless boolean. Reusing that standing removes all avoidable work: the final six-case census matches integration exactly.
