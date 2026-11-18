import { issueSearch } from './issue-search'
import { LOADING } from './loading'
import { omitGone } from './lookup'
import type { MobxPool } from './pool'

/** Link targets keep identities, and share the same device/server request as
 * every other issue picker. Only the displayed window reads record fields. */
export function issueTargets(
  pool: MobxPool,
  issue: { id: string; repoPath: string },
  query: string,
  limit: number,
): string[] | null {
  const prefixes: Record<string, string | undefined> = {}
  for (const id of pool.queries.repoIds(issue.repoPath)) {
    const repo = omitGone(pool.row('repo', id))
    if (repo === LOADING) return null
    prefixes[id] = repo?.prefix
  }
  const device = pool.queries.ids({
    kind: 'mobileIssueTargets',
    repoPath: issue.repoPath,
    excludeId: issue.id,
    query,
    limit,
    prefixes,
  })
  const result: string[] = []
  for (const id of issueSearch(pool).read(query, device, issue.repoPath).ids) {
    if (result.length >= limit) break
    if (id === issue.id) continue
    const target = omitGone(pool.row('issue', id, 'summary-fields'))
    if (
      target &&
      target !== LOADING &&
      !target.archived &&
      !target.deletedAt &&
      !target.isDraftVessel
    )
      result.push(id)
  }
  return result
}
