import type { IssueWire } from '@podium/protocol'
import type { FileTab } from './store'

/** The file tabs that belong in a workspace's tab strip.
 *
 *  Issue workspaces scope STRICTLY by ownership (POD-149): a tab shows only
 *  under the issue whose id it carries — `issueId` is stamped at open time by
 *  every open action (openFile / openFileInWorktree / openArtifact), so files
 *  opened under one issue no longer leak into every issue sharing the same
 *  checkout (the old worktree-path fallback showed POD-131's artifacts under
 *  any issue worked from the main checkout). Ownership also covers the
 *  worktree-LESS artifact case ([spec:SP-0fc9] #441 / POD-502): an owned tab
 *  renders for its issue even with no worktreePath at all. Tabs with no owner
 *  (opened outside any issue) appear only in the worktree-selected workspace,
 *  which still matches by containment root. Closed-over tabs stay reachable
 *  via the "+" menu's Recent-files list. */
export function fileTabsForWorkspace(
  fileTabs: FileTab[],
  target: { issue: IssueWire | null | undefined; worktreePath: string | undefined },
): FileTab[] {
  const { issue, worktreePath } = target
  if (issue) return fileTabs.filter((f) => f.issueId === issue.id)
  if (worktreePath) return fileTabs.filter((f) => f.worktreePath === worktreePath)
  return []
}
