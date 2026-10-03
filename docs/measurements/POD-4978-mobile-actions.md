# POD-4978 — mobile pool action parity

The pool WorkScreen uses the existing store actions and outbox for navigation,
tuck, read state, menu writes and reorder persistence. The real WorkIssueMenu,
prompt, status, close, colour and confirmation sheets remain in use. The legacy
WorkScreen body, startup latch and default-off switch are unchanged.

## Menu input correction

Menu compatibility data is acquired on the gesture through the pool's one row
reader. Delete's cascade count now uses the existing declared `pageSessions`
relation, matching the legacy task's raw membership. The displayed `sessions`
relation collapses resume twins, excludes headless agents and includes shells;
it therefore cannot supply that count. Raw membership preserves archived and
headless agents and resume twins while excluding shell sessions. A regression
compares the exact membership IDs with the independent legacy issue view.

The resolver supplies raw unread state even when a working agent suppresses
the row's painted unread badge. It carries the existing child counts, deferred
state and Bring back eligibility to the unchanged menu. It enumerates resident
keys only. A cold target returns no menu while the one reader queues its
batched load; repeated gestures coalesce, and absence never issues a write.
No pool mutation API, extra runtime, replica, outbox or peek reader was added.

## Action coverage

`apps/mobile/src/screens/WorkScreen.pool-actions.test.tsx` mounts the real
StoreProvider, canonical kernel replica, lazy mobile pool, RN-web SectionList,
WorkRow and action sheets. API promises are held, refused or accepted through
the real outbox. Platform/navigation chrome and sheet animation are replaced;
the native controls and their store action handlers are exercised.

| Action | Pool-path proof |
| --- | --- |
| Open | Mission navigation precedes deferred mark-read; refusal restores unread; draft and worktree sessions use the current navigation target |
| Mark read/unread | Both actual menu commands update immediately and rewind; raw unread survives painted busy suppression |
| Tuck | Immediate disappearance into Closed, refusal readmission, accepted value held until feed echo |
| Bring back | Recent closure returns to live and rewinds; closures older than a day retain the disabled explanation and queue no command |
| Unsnooze | Actual fold menu changes the lane immediately and restores it on refusal |
| Rename | Trimmed prompt value, acceptance awaiting echo, later refusal preserving the earlier value, cancel/whitespace/unchanged no-ops |
| Stage/close | Planning plus Done, Cancelled and Duplicate; explicit confirmation for active agents and open children; every refusal rewinds |
| Colour | Set and clear through the actual colour sheet; refusal restores both |
| Placement | Move to top level and into a mission through the actual menu, with native band rollback |
| Delete | Exact raw non-shell cascade count and existing confirmation; pending disappearance and refusal readmission |
| Reorder | Existing `planReorderKeys` and update actions in keyed/unkeyed project and pinned scopes; waiting-agent lifting retains the full ordering scope; every queued refusal restores the original order |
| Cold/absent menu | No menu or write while loading; repeated gestures produce one replica load; absent targets remain inert |

The current mobile vocabulary has no reorder buttons, following the existing
2026-08-28 device review. The tests cover the canonical reorder persistence
and the pool's resulting order without adding a new mobile control.

All **28 action checks** rejected planted faults before their restored result
counted. The final full action file passed on `integrate/4286-pilot` base
`becad6d447`, including its cold-index reader and runtime changes. It observed
**91 clean mobile side-by-side comparisons**, with zero differences or pending
rows. Guards reject a mounted legacy slice subscription or legacy row
derivation; only the explicit independent diagnostic oracle may evaluate the
legacy arm.

The initial restored run passed 22; six cases needed fixture fixes for
fold-persistence API wiring and the canonical `needs_user` phase. Only those
six were replanted and retried. The later full-file runs were necessary when
the integration reader/runtime changed; passing checks were not repeated for
unchanged inputs.

## Planted controls

Every plant uses a committed input and `cp` backup/restoration in the isolated
flatblock checkout. No assertions are weakened.

| Plant | Rejected checks |
| --- | ---: |
| Read truth instead of the shared optimism layer | 21 write/navigation checks |
| Final fold/reorder fixtures with that same omission | All 6 affected checks |
| Suppress session navigation | Both draft/worktree checks |
| Submit cancelled, blank or unchanged rename | All 3 no-op checks |
| Remove the Bring back age guard | 1 eligibility check |
| Bypass the cold-row reader | 1 loading/batching check |
| Restore displayed membership for cascade count | 1 exact delete-count check |

## Production phone and final gates

The required uncached mobile typecheck is green on the final integration
runtime. It initially found unsupported
`exact` options in Testing Library role queries and an untyped replica-call
capture. Removing the ignored options and declaring the existing call types
preserves the runtime assertions. Only the changed mobile project was retried;
the earlier green dependency checks and runtime action checks were retained.

The production Expo/Pixel Chromium test holds the real HTTP rename request,
asserts the pending pool title and mutation ID, refuses the request, checks the
restored title, then opens the mission. Its restored capture interleaves
off/on/off/on hard launches and records actual Chromium Paint, collected heap
and startup-to-row readiness. This is synthetic interaction evidence, not a
large-corpus performance acceptance claim. The restored four-arm capture is
queued behind the shared timing lease.

The corrected production phone fault control is valid: changing the menu's
submitted title to `Planted wrong mobile title` fails the requested optimistic
title assertion, and the failure context shows that wrong title in the row
with one queued mutation. The source was restored with `cp`. Earlier driver
attempts stopped before that assertion and are excluded. The driver scrolls
the virtualized row into view, holds real Chromium touch input, cancels the
original row gesture when the modal owns input, and taps the native sheet
controls.

The final lean gate is green: **154 checks in four of 1,783 collected node
files (0.2%)**. Its workspace typecheck reports 28/28 successful tasks, with
24 cache hits; span-effect lint reports 162 bodies, zero unclassified effects
and eight opaque bodies. The first lean run correctly rejected two uncovered
imports from the new mobile test. `turbo.json` now declares the shared action
fixture and mobile oracle in both mobile typecheck and test keys; the restored
gate verifies coverage.

The three added source files pass scoped Biome lint with no errors (34
warnings and one informational diagnostic). Root shadowing passes across
5,899 files. Full WorkScreen lint still reports its unchanged search-cache
memo dependencies, already present on the integration baseline. That separate
follow-up is **Proposed POD-5411**; the menu change does not remove the
intentional cache resets or hide the baseline error.

All fixtures are synthetic. The operator's live data remains on ludovico;
no screenshot, export or dump of it is used. Tests, typecheck and lint run
sequentially in `~/podium-test-4978` on flatblock with checkout-local Bun 1.4.2
and dependency links. Commands are bounded, and timing captures hold the
shared benchmark lease. These are focused results, not a whole-suite claim.

Landing target: `integrate/4286-pilot`. The operator owns promotion to `dev/mw`.
