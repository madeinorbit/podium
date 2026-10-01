# POD-4956 — sidebar interaction parity

The pool sidebar uses the current store actions and outbox for every interaction. The focused interaction acceptance is green: **36 checks**, with clean S5 comparisons across pending writes, receipts, rollback, eviction and readmission. Closing package and browser validation is in progress.

## Behavior and ownership

`use-pool-unified-work.ts` follows the formal mission at every depth, then the provenance chain of its attached sessions. Archived and headless senders can supply provenance; pane candidates keep the legacy membership filters and slice-order tie breaking. Selecting a child selects its mission root, keeps the clicked worktree/file candidates, traces the chosen session, batches navigation/read/defer/session-read, and focuses the clicked issue after the batch.

Menu input is resolved on open from resident keys and the pool's one reader. It carries raw unread state, member IDs and child counts needed by the unchanged shared menus. Rows still use the existing rename editor, drag planning, folds, confirmations and command shortcuts. No pool mutation API, additional outbox, replica or runtime was added to the product path. The startup switch and legacy branch are unchanged.

Two shared-reader defects surfaced in the interaction acceptance:

- A cursor-only optimistic update kept its borrowed issue body. Refusal re-emitted that same body, and the identity fast return failed to restore the separate cursor lane. `tables.ts` now restores that lane on the unchanged-body path; equality still suppresses redundant notifications.
- Legacy mission progress counts nonarchived, nonexited headless and shell sessions as staffed. The existing declared raw-session summary now carries that staffing bit, consumed by `unitOwnPartOf`. Visible rosters, session ownership and pane filters retain their current rules.

Both fixes have separate commits and exact pool-path negative controls. The summary retains two timestamps and one boolean, without retaining session records. Gesture/menu membership covers resident sessions only. No new peek reader or cold-row index was introduced.

## Interaction coverage

| Surface | Evidence in `SidebarUnified.pool-actions.test.tsx` |
| --- | --- |
| Select issue/member | Mission root, explicit pane, trace/batch/focus order, deduplication, deep formal descendants, filed chains, headless/archived starters, spin-off departure, archived parents, shell/guest filtering |
| File/worktree/panel | Keep a mission file pane; no redundant/file trace; worktree containment; explicit panel; existing session-read command |
| Unloaded row | LOADING, no mutation/focus, repeated clicks coalesce into one two-row load |
| Rename | Enter, blur, Escape, whitespace, menu editor, immediate paint, refusal, accepted write awaiting echo, later-write rollback |
| Reorder/pin | `planReorderKeys` backfill; moved-row-only pin/unpin; existing update commands; every queued refusal rewinds |
| Tuck/folds | Tuck refusal, accepted tuck and echo, closed-row click latch, actual Bring back menu, grace-window disabled explanation |
| Archive/delete | Quick closed-fold exit, archive all, existing confirmation flows, optimistic disappearance and refusal readmission |
| Shared issue menu | Open in tasks, rename, pin/unpin, status/close, colour, raw read/unread, defer/undefer, placement, cascade counts, handoff, current visible/hidden vocabulary |
| Eviction/readmission | Clear previously seen selection, no deletion toast or re-request, normal readmission |
| Command hold 1–9 | Actual settled column order, folded/collapsed exclusion, select all nine, release/blur cleanup |

The synthetic action fixture removes compatibility fields that production canonical projections do not contain. The app's real optimism ledger and receipt chain drive the tests. Only diagnostic comparison code invokes the legacy oracle; a mounted pool consumer trying to read `worklistSlice` throws.

## Negative controls and closing evidence

All 36 new interaction checks rejected planted mistakes before their green result counted. Plants suppress or corrupt navigation, focus, rename, archive, reorder, tuck, menu input, eviction handling and shortcut numbering. Three additional exact checks reject the unchanged-body cursor omission and omission of the staffed summary. Every plant used `cp` backup/restore and WIP checkpoints.

| Check | Result |
| --- | --- |
| Focused pool-path interactions, web config | 36 passed |
| Exact shared-reader negative controls | 3 failed on plant; all 3 passed restored |
| Required shared-arm checks, package config | Pending |
| Chromium pointer/keyboard proof and four phase controls | Pending |
| Uncached affected-project typecheck | Pending |
| Scoped lint, span-effects and lean gate | Pending |
| Private live-data comparison | Pending; in memory on ludovico, no export or dump |

Tests, typecheck and lint run sequentially in `~/podium-test-4956` on flatblock with checkout-local Bun 1.4.2 and dependencies. This is focused evidence, not a whole-suite result. The unrelated focused-runner reporter option collision is Proposed POD-5096; standard verbose reporting supplies this issue's evidence.

The browser fixture contains synthetic rows only. Its driver uses the real mouse grip/drop boundary and rename keyboard input, waits for paint before diagnostic comparison, and records action-to-observed-paint delay and heap use. Those values include automation scheduling; heap includes the fixture and diagnostic oracle. They are interaction evidence, not a performance comparison. The principal/rebuild and no-legacy-derivation browser proof already landed under POD-4957 remains the pilot's separate performance evidence.

Landing target: `integrate/4286-pilot`. The operator owns promotion to `dev/mw`.
