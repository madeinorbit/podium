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

The implementation starts alongside the old worktree getters so parity can be
run before removing the production roster helper calls. Measurement and gate
results will be added after running them on the isolated flatblock checkout.
