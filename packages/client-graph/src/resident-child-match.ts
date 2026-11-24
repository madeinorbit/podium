import { omitGone } from './lookup'
import type { IssueModel } from './models'
import type { MobxPool } from './pool'

/** First matching resident descendant, breadth first. Search never loads cold children. */
export function firstResidentChildMatch(
  pool: MobxPool,
  parentId: string,
  matches: (issue: IssueModel) => boolean,
): string | null {
  const seen = new Set<string>([parentId])
  const queue = [...pool.graph.many('issue', parentId, 'treeChildren')]
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]
    if (!id || seen.has(id)) continue
    seen.add(id)
    // untracked-read: work-search-child-peek
    if (!omitGone(pool.row('issue', id, 'peek'))) continue
    const issue = omitGone(pool.model('issue', id))
    if (!issue || typeof issue === 'symbol') continue
    if (matches(issue)) return id
    queue.push(...pool.graph.many('issue', id, 'treeChildren'))
  }
  return null
}
