# POD-5649 — addressed issue menu inputs

Measured 2026-10-06 on flatblock. Pilot baseline: `5d3e207ceb`;
baseline probe: `16e5706f32`; product candidate: `876dff947f`.

## Scope and result

The general issue-menu wrapper and sidebar menu resolver read hidden attachments
and repositories. The mission issue and session menu controls were already flat
following POD-5672. Only the two general issue-menu callers changed; action writers,
menu copy, candidate order, and entity models remain unchanged.

Both callers now borrow `readMissionActionInputs` and its existing keyed menu
computeds. Cascades and children use the existing scalar counts; handoff receives
its unique sender, containing source lane, and addressed drift fallback. Machine
payloads are requested by the existing opened target list, not its trigger. No
new model field, maintained index, deep comparer, or reaction-maintained data.

## Focused proof

`bun run test:file -- apps/web/src/lib/menu-input-growth.test.tsx`, one foreground
worker, no meter lease. The real menus and readers are mounted; the action owner
and pool attachment hook are fixture seams. The sidebar display projection is
stubbed in the baseline to isolate its menu resolver; the candidate throws if that
menu calls the display projection. Work counters are outside product code.

At 1x/4x, hidden issue attachments, repository scans, and source worktrees are
32/128. The source and two displayed destination machines stay fixed. Initial
open, target-list open, one destination becoming offline, that destination's
heartbeat, and the sender's heartbeat are measured independently. The test also
asserts destination order, updated rejection text, and the clicked handoff IDs.

| Route | Action | Before row calls 1x / 4x | After row calls 1x / 4x | After elements 1x / 4x |
| --- | --- | --- | --- | --- |
| issue | menu-open | 69 / 261 | 3 / 3 | 253 / 253 |
| issue | targets-open | 0 / 0 | 5 / 5 | 349 / 349 |
| issue | candidate-update | 69 / 261 | 5 / 5 | 324 / 324 |
| issue | heartbeat | 69 / 261 | 5 / 5 | 325 / 325 |
| issue | sender-heartbeat | 76 / 268 | 14 / 14 | 468 / 468 |
| sidebar-issue | menu-open | 70 / 262 | 3 / 3 | 253 / 253 |
| sidebar-issue | targets-open | 0 / 0 | 5 / 5 | 349 / 349 |
| sidebar-issue | candidate-update | 70 / 262 | 5 / 5 | 324 / 324 |
| sidebar-issue | heartbeat | 70 / 262 | 5 / 5 | 325 / 325 |
| sidebar-issue | sender-heartbeat | 77 / 269 | 14 / 14 | 209 / 209 |
| mission-issue | menu-open | 3 / 3 | 3 / 3 | 253 / 253 |
| mission-issue | targets-open | 5 / 5 | 5 / 5 | 349 / 349 |
| mission-issue | candidate-update | 5 / 5 | 5 / 5 | 324 / 324 |
| mission-issue | heartbeat | 5 / 5 | 5 / 5 | 325 / 325 |
| mission-issue | sender-heartbeat | 14 / 14 | 14 / 14 | 468 / 468 |
| session | menu-open | 3 / 3 | 3 / 3 | 261 / 261 |
| session | targets-open | 5 / 5 | 5 / 5 | 336 / 336 |
| session | candidate-update | 5 / 5 | 5 / 5 | 311 / 311 |
| session | heartbeat | 5 / 5 | 5 / 5 | 312 / 312 |
| session | sender-heartbeat | 15 / 15 | 15 / 15 | 476 / 476 |

Before: the general wrapper reads 33/129 session payloads, 33/129 repository
payloads and three machine payloads on open, candidate update, and heartbeat.
`issueHandoffAvailability` builds a member map over those supplied sessions;
`reposToViews` and `handoffAvailability` iterate the hidden source worktrees.
The sidebar resolver additionally materializes attachment and child IDs and
consults its display projection. The addressed inputs remove these passes.

After: the main menu reads only the opened issue, unique sender and source
repository. The opened picker additionally reads its two displayed destinations.
Row calls, derivation bodies and distinct collection elements are identical
between 1x and 4x for every route/action. A heartbeat may still read the addressed
source and displayed candidates; that work is bounded, and was already flat in
the mission/session controls. Pool ingest work is included in sender-update
counts, so those totals are not all menu work.

Baseline: 311 MiB peak process, 10,191 MiB minimum MemAvailable. Candidate:
293 MiB peak process, 9,828 MiB minimum MemAvailable. No cutoff approached.

## Validation

- Focused probe: one executed test, all four routes and five windows at 1x/4x.
- Issue-menu pool inputs and sidebar menu resolver: four executed tests in two
  focused files, including cold unique sender and pending payload behavior.
- Full `bun run typecheck`: all 31 package scopes, 29/29 successful Turbo tasks.
- `bun run test`: lean gate green, 154 tests in 4/1828 node-project files;
  span-effect, interaction-scan, MobX-private, untracked-read and clock-read gates
  green. Interaction census: 2,318 fingerprints, zero ratchet errors.
- Normal `apps/web` build and bundle-budget check: green.
- Full `speed:structural` under `meter:flatblock`: 21 passed, 2 failed, 7 skipped.
  The executable census remains red. All ten reported unexpected counters match
  the documented pilot census in `pod-5710-known-failures.json`: seven sidebar
  counters (POD-5716), the existing folded-header counter (POD-5639/POD-5716), and
  two accepted addressed MRU walks (POD-5708). The separate declared-query screen
  failure is the documented issue-detail guard pair (POD-5618), 55/151 and 49/145.
  No new unowned counter or menu failure appeared. Peak process: 5,986 MiB;
  minimum MemAvailable: 5,544 MiB.
- POD-4286 confirmed those exact failures on 2026-10-06 and authorized landing
  after the green web build, requesting no untouched-baseline comparison.

Census classifications remain unchanged; shifted fingerprints and removed scan
sites do not claim that the documented failures or other debt were repaired.
