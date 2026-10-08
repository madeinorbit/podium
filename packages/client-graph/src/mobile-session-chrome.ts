import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'
import type { IssueModel } from './models'

export function mobileSessionChromeIssue(
  pool: MobxPool,
  id: string | undefined,
): Loaded<IssueModel> {
  if (id === undefined) return undefined
  const row = pool.row('issue', id, 'summary-fields') as Loaded<{ deletedAt?: string | null }>
  if (!row || row === LOADING || row.deletedAt) return row === LOADING ? LOADING : undefined
  return pool.model('issue', id)
}
