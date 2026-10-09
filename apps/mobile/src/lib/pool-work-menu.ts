import { here, omitGone } from '@podium/client-graph/lookup'
import { allowImperativeRead, lazy } from '@podium/mobx-helpers'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { LOADING } from '@podium/client-graph/loading'
import type { MobxPool } from '@podium/client-graph/pool'
import type { WorkIssueMenuTarget } from './work-menu'

export interface PoolWorkMenuData {
  target: WorkIssueMenuTarget
  issues: IssueViewModel[]
  sessions: SessionView[]
}

class SharedMenuTarget implements WorkIssueMenuTarget {
  constructor(
    readonly pool: MobxPool,
    readonly issue: WorkIssueMenuTarget['issue'],
    readonly lane: WorkIssueMenuTarget['lane'],
  ) {}
  @lazy get canBringBack() {
    return this.lane === 'closed'
      ? this.pool.worklistRow(this.issue.id)?.canBringBack
      : undefined
  }
  @lazy get sessionCount() {
    return this.pool.issueObject(this.issue.id).memberCount
  }
}

/** Opening state is the pressed identity and the operator's lane choice. */
export function resolvePoolWorkMenu(
  pool: MobxPool,
  id: string,
  lane: WorkIssueMenuTarget['lane'] = 'live',
): PoolWorkMenuData | null {
  return allowImperativeRead(() => {
    const raw = omitGone(pool.row('issue', id))
    if (!raw || raw === LOADING) return null
    const issue = here(pool.model('issue', id))
    if (!issue) return null
    return {
      target: new SharedMenuTarget(pool, issue as unknown as WorkIssueMenuTarget['issue'], lane),
      issues: [issue as unknown as IssueViewModel],
      sessions: [],
    }
  })
}
