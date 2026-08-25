import { type IssueWire, isSystemOwnedIssueStage } from '@podium/model'

/**
 * Board/list scope filter (issue-as-workspace): drafts and internal
 * (audience: 'agent') issues stay off the board unless explicitly enabled —
 * EXCEPT recoverable tombstones, which must remain reachable through Show deleted
 * even when the original issue was a draft or agent-internal. Children whose
 * parent survives the filter also ride under it (epic drill-down).
 *
 * A DRAFT issue is the vessel a bare session lives in until it is given a real
 * title — a session container, not work. It has always been off the desktop
 * board; the phone board and the right dock's issue explorer derive from this
 * same function so all three agree (POD-338, POD-1581). The explorer listed the
 * vessels for a while, and a row reading `Draft` with no description was the one
 * place in the product where a bare agent posed as a task.
 *
 * Keys on `audience` (who the issue is FOR, #198 [spec:SP-a859]), NOT `origin`:
 * an agent acting for the human can cut a human-audience issue that belongs on the
 * board, and the human's own quick note to an agent can be internal.
 */
export function filterBoardScope<T extends IssueWire>(
  issues: readonly T[],
  showAgentTasks: boolean,
): T[] {
  const noDrafts = issues.filter((i) => !i.draft || !!i.deletedAt)
  if (showAgentTasks) return noDrafts
  const byId = new Map(noDrafts.map((i) => [i.id, i]))
  const topLevelVisible = (i: T): boolean => !!i.deletedAt || i.audience !== 'agent'
  return noDrafts.filter((i) => {
    if (topLevelVisible(i)) return true
    // Internal (audience: agent): keep only when some ancestor chain reaches a
    // visible issue — it then shows as a child under that parent, not at top level.
    let cur = i
    const seen = new Set<string>([i.id])
    while (cur.parentId) {
      const parent = byId.get(cur.parentId)
      if (!parent || seen.has(parent.id)) return false
      if (topLevelVisible(parent)) return true
      seen.add(parent.id)
      cur = parent
    }
    return false
  })
}

/** Live board population: nothing archived, nothing tombstoned, no draft
 *  vessels, no internal decomposition at top level. The one predicate a
 *  task board (desktop or phone) starts from. */
export function boardIssues(issues: IssueWire[], showAgentTasks = false): IssueWire[] {
  return filterBoardScope(
    issues.filter((i) => !i.archived && !i.deletedAt && !isSystemOwnedIssueStage(i.stage)),
    showAgentTasks,
  )
}
