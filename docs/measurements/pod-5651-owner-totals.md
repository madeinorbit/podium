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

Owner work measurements and final gate results remain pending on flatblock.
