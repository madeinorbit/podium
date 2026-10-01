# POD-4956 — sidebar interaction parity

The pool sidebar uses the current store actions and outbox for every interaction. The initial focused interaction acceptance is green: **36 checks**, with clean S5 comparisons across pending writes, receipts, rollback, eviction and readmission. Two final resume-collapse navigation regressions and closing browser validation are in progress.

## Behavior and ownership

`use-pool-unified-work.ts` follows the formal mission at every depth, then the provenance chain of its attached sessions. Archived and headless senders can supply provenance; pane candidates keep the legacy membership filters and slice-order tie breaking. Selecting a child selects its mission root, keeps the clicked worktree/file candidates, traces the chosen session, batches navigation/read/defer/session-read, and focuses the clicked issue after the batch.

Navigation and provenance filter normal sessions through the existing R2 membership relation, which already applies resume collapse. Headless senders never collapse and remain eligible for provenance. Menu input is resolved on open from resident keys and the pool's one reader. It carries raw unread state, raw member IDs and child counts needed by the unchanged shared menus. Rows still use the existing rename editor, drag planning, folds, confirmations and command shortcuts. No pool mutation API, additional outbox, replica or runtime was added to the product path. The startup switch and legacy branch are unchanged.

Two shared-reader defects surfaced in the interaction acceptance:

- A cursor-only optimistic update kept its borrowed issue body. Refusal re-emitted that same body, and the identity fast return failed to restore the separate cursor lane. `tables.ts` now restores that lane on the unchanged-body path; equality still suppresses redundant notifications.
- Legacy mission presence counts nonarchived, nonexited headless and shell sessions as staffed. Normal and shell presence already comes from retained R2, preserving resume-twin collapse. The existing declared raw-session summary now carries only the missing headless staffing bit. `standingOf` consumes it during the existing own-row read, and `openOwnPartOf` reuses that standing for progress, vacancy and continuation. Visible rosters, session ownership and pane filters retain their current rules.

Both fixes have separate commits and exact pool-path negative controls. The summary retains two timestamps and one boolean, without retaining session records. Headless exit, archive and return transitions also stay clean. Gesture/menu membership covers resident sessions only. No new peek reader, row read, cold load or cold-row index was introduced by the presence supplement.

## Interaction coverage

| Surface | Evidence in `SidebarUnified.pool-actions.test.tsx` |
| --- | --- |
| Select issue/member | Mission root, explicit pane, trace/batch/focus order, deduplication, deep formal descendants, filed chains, headless/archived starters, spin-off departure, archived parents, shell/guest filtering; final collapsed-pane and collapsed-sender regressions pending |
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
| Required shared-arm checks, package config | 67 passed; final retained-session regressions 17 passed |
| MobX census, bare/idle/pending at 1x/4x | 6 passed, no issue-added tracking objects or reads |
| Default L4b correctness gate and built-in plants | Running |
| Chromium pointer/keyboard proof and four phase controls | Pending |
| Uncached affected-project typecheck | Pending |
| Scoped lint, span-effects and lean gate | Pending |
| Private live-data comparison | Pending; in memory on ludovico, no export or dump |

Tests, typecheck and lint run sequentially in `~/podium-test-4956` on flatblock with checkout-local Bun 1.4.2 and dependencies. This is focused evidence, not a whole-suite result. The unrelated focused-runner reporter option collision is Proposed POD-5096; standard verbose reporting supplies this issue's evidence.

The browser fixture contains synthetic rows only. Its driver uses the real mouse grip/drop boundary and rename keyboard input, waits for paint before diagnostic comparison, and records action-to-observed-paint delay and heap use. Those values include automation scheduling; heap includes the fixture and diagnostic oracle. They are interaction evidence, not a performance comparison. The principal/rebuild and no-legacy-derivation browser proof already landed under POD-4957 remains the pilot's separate performance evidence.

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
