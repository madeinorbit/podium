// Test-only chrome oracle frozen before the shared-model replacement.
import type { IssueViewModel } from '@podium/client-core/replica'
import { asIssueId } from '@podium/model/browser'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

export function createMobileSessionReader(pool: MobxPool) {
  return {
    chromeIssue(id: string | undefined): Loaded<IssueViewModel> {
      if (id === undefined) return undefined
      const row = pool.row('issue', id, 'summary-fields') as Loaded<IssueViewModel>
      if (!row || row === LOADING || row.deletedAt) return row === LOADING ? LOADING : undefined
      const repoId = pool.graph.one('issue', id, 'repo')
      const repo = repoId ? (pool.row('repo', repoId) as Loaded<{ prefix?: string }>) : undefined
      const prefix = repo && repo !== LOADING ? repo.prefix : undefined
      return {
        ...row,
        id: asIssueId(id),
        prefix,
        displayRef: prefix ? `${prefix}-${row.seq}` : `#${row.seq}`,
      }
    },
  }
}
