import type { IssueWire } from '@podium/protocol'
import type { FileTab } from './store'

/** The file tabs that belong in a workspace's tab strip.
 *
 *  Artifact tabs ([spec:SP-0fc9] #441) are owned by an issue via `issueId`, so
 *  they render for that issue even when it has no worktree (`worktreePath`
 *  undefined) — the bug where a snapshotted artifact opened a tab the strip then
 *  dropped, bouncing the pane back. Ordinary worktree file tabs match by path
 *  against the issue's worktree AND the workspace's effective root (POD-130:
 *  `worktreePath` is panelTarget's path — the repo's main checkout for a
 *  worktree-less issue, whose dock-opened files would otherwise be dropped the
 *  same way POD-502's artifacts were). */
export function fileTabsForWorkspace(
  fileTabs: FileTab[],
  target: { issue: IssueWire | null | undefined; worktreePath: string | undefined },
): FileTab[] {
  const { issue, worktreePath } = target
  if (issue)
    return fileTabs.filter(
      (f) =>
        f.issueId === issue.id ||
        (!!issue.worktreePath && f.worktreePath === issue.worktreePath) ||
        (!!worktreePath && f.worktreePath === worktreePath),
    )
  if (worktreePath) return fileTabs.filter((f) => f.worktreePath === worktreePath)
  return []
}
