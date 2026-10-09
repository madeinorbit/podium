import type { IssueViewModel } from '@podium/client-core/replica'
import { asIssueId, asSessionId } from '@podium/model/browser'
import { issuePages } from './issue-page'
import type { MobxPool } from './pool'
import { isFinished } from './shared/predicates'
import { LOADING, type Loaded } from './worklist/rollup'

/** The issue menu's old catalog answer (POD-5831): every entry enriched with
 * its child and member lists. Kept only as the comparison oracle; an entry now
 * reads those facts from its IssueModel when it is shown. */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
export function menuIssues(pool: MobxPool): Loaded<IssueViewModel[]> {
  const world = issuePages(pool).issues()
  if (!world || world === LOADING) return world
  return world.map((value) => {
    const childIds = [...pool.graph.many('issue', value.id, 'treeChildren')].sort(byId)
    const memberSessionIds = [...pool.graph.many('issue', value.id, 'pageSessions')]
      .sort(byId)
      .map(asSessionId)
    return {
      ...value,
      memberSessionIds,
      childIds: childIds.map(asIssueId),
      childCount: childIds.length,
      childDoneCount: childIds.filter((id) => {
        const child = pool.row('issue', id, 'summary') as Loaded<{
          stage?: string
          closedReason?: string | null
        }>
        return child && child !== LOADING && isFinished(child)
      }).length,
    }
  })
}
