# Per-owner attention totals

Base: `integrate/4286-pilot` at `2c4e3bd21e`, after POD-5822 landed.

## Remaining callers at this base

| Caller | Current input and answer | Required change |
| --- | --- | --- |
| `WorklistIssue.ownAttention` / `ownAttentionFields` | Retained `rosterIds`, per-session lazy verdict fields, per-question lazy row totals | Keep roster and total logic; move session timing/fleet facts from `WorklistSession` to the shared `SessionModel` |
| `WorklistIssue.ownActivityAt` / `activityAtOf` | Retained IDs and shared `SessionModel.activityMs` | Already follows the guide |
| `IssueModel.unread` | Replica timestamp and maintained seat activity summary; archive partitions only in the summary-free fallback | Already avoids rewalking unchanged history |
| `WorklistWorktree.timing` / `sidebarTiming` | Shown session roster, but reads raw `agentState`/`offer` across members when one changes | Sum narrow shared session facts in lazy owner fields |
| `WorklistWorktree.visibleFleet` / `fleetOf` | Shown session roster, but reads raw status/agent fields across members when one changes | Sum shared per-session fleet facts |
| `WorklistWorktree.visibleUnread` | Shown session roster, but `SessionModel.unread` is a plain stored-field getter | Cache the existing session field with `@lazy`, keeping its name and value |
| Web `workingSinceMs` | Tests only; production rows read model timing | Keep compatibility helper |
| Web `UnifiedIssueRow` legacy row helpers | Fallback for retained legacy rows; model rows read model timing/attention | Keep fallback; no new cache |
| Phone `worklistRowStatus` | Issue totals already use companions; worktree waiting copy selects a session over the shown roster | Text selection is outside totals/timestamps; keep today's clock source |
| Core focus/session/unread helpers and seat summaries | Pure compatibility/reference functions or record/data-layer inputs | No new reaction or history cache |

## Pre-removal parity proof

Flatblock, Bun 1.4.2, candidate `adebc0c01b`, with the old production timing and
fleet getters still present: `owner-totals.parity.test.ts` ran 22 tests, all
green. It compares old/new facts and owner answers on the same records,
including archived, headless, parked, errored, exited, absent and cold/LOADING
sessions, zero totals, invalid timestamps, offers, and heartbeat/read/archive
updates. The first run exposed a cold fixture missing its finished owner;
adding the owner made the inherited-residency fixture exercise LOADING.

The same candidate, with `POD5651_MUTATE=1` and the owner-parity group selected,
failed all seven selected cases with `__wrong_answer__` versus their real
timestamps/totals (15 other tests skipped). Only after this proof were the
production roster timing/fleet calls removed. The pure helpers remain the
independent reference; session facts now have their shared model as home.

## Owner work census

Flatblock, candidate `fed933c4f1`, `meter:flatblock` held:
`owner-totals.work.test.ts` and unchanged `sidebar-attention.test.ts` ran nine
tests, all green. The same heartbeat over three shown sessions reads unchanged
peers' raw agent fields eight times through the old helpers and zero times
through the shared facts. Growing the archived owner history from 32 to 128
members leaves the complete update counts identical:

| Change | Row calls, 1x / 4x | Derivation bodies, 1x / 4x | Elements, 1x / 4x |
| --- | --- | --- | --- |
| Member heartbeat | 8 / 8 | 24 / 24 | 189 / 189 |
| Session read state | 8 / 8 | 18 / 18 | 163 / 163 |

After the observer closes, both changes at both history sizes run zero owner
timer/fleet total bodies and read zero unchanged-peer agent facts. The test
also asserts that visible timer/fleet bodies actually run, so the hidden
check cannot pass by looking for a nonexistent derivation name.

## Existing behavior and structural baseline

Final focused parity, existing worklist field parity, and existing model tests
ran 1,531 tests, all green, on `b47bfd50ee`. No existing assertion changed.

The unchanged pilot `2c4e3bd21e` structural census ran 30 tests across its three
focused files (seven outside the selected groups skipped), all green. The
per-reader baseline was saved before testing the candidate.

Five replacement worktree sum scans retain the previous REQUIRED REPAIR
classification: a lazy sum still visits the shown roster's cached facts; this
change claims no constant-time sum or universal roster cardinality cap.
Thirteen removed raw-helper call/consumer fingerprints disappear from the
source scan. No unrelated classification changes.

Final heavy gates and structural comparison remain pending on flatblock.
