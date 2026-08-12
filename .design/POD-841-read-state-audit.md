# Issue read / unread — audit

Read and unread are still tracked. The sidebar had stopped seeing the derived flag; Flight Deck still has it.

## Persistence

`readAt` is per-user state in `issue_user_state` (`user_id`, `issue_id`). `issues.markRead` stamps it; `issues.markUnread` clears it. A row whose markers are all null is deleted.

- `apps/server/src/store/issues.ts` — `setIssueUserState`
- `apps/server/src/modules/issues/service/crud.ts` — `markIssueRead` / `markIssueUnread`

`unread` is not stored. `IssueWire` dropped it (POD-797). The server still has `computeUnread` for janitor/auto-archive.

## Client derivation

`deriveIssueRollups` (`packages/client-core/src/replica/issue-views.ts`) sets unread when:

- `readAt` is null or invalid, or
- `issue.updatedAt` is after `readAt`, or
- a member session's `lastActiveAt` is after `readAt`

Deleted issues are never unread.

`useReplicaIssues` merges that rollup onto the normalized view model. `buildIssueViewModels` is the same merge without React.

## Flight Deck

Consumes `useReplicaIssues`, so `issue.unread` is real.

Marks the issue read on task select, session select, and departure open (`FlightDeck.tsx`). The shared `IssueContextMenu` can mark read or unread because it receives the replica model.

Task strips do not paint unread. That is a display gap, not a broken data path.

## Sidebar (fixed on this branch)

`UnifiedIssueRow` and `IssueContextMenu` still read `issue.unread` (`rowUnreadEmphasized`, `canMarkRead` / `canMarkUnread`).

The published worklist used to build rows from `store.issues` after `unread` left `IssueWire`. Every row looked read; the menu offered the wrong toggle. That is POD-843.

This branch rewires `worklistSlice` to `issueViewModelsFromReplica` (same builder as Flight Deck). The slice test starts from projection + session inputs and does not inject `unread` on the legacy fixture.

## Out of scope

Flight Deck strip chrome for unread. Persistence, derivation, and the sidebar consumer are the load-bearing path.
