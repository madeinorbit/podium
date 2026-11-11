import {
  issueRepoName,
  projectCostGroups,
  type TaskCostRowView,
  taskCostRows,
  topWindowTasks,
  windowTaskCosts,
} from '@podium/client-core/values'
import { lazy } from '@podium/mobx-helpers'
import type { TaskCostRowWire } from '@podium/model'
import { machinePathKey } from '@podium/model/browser'
import { action, compareShallow } from 'mobx'
import { here, isGone } from './lookup'
import type { MobxPool } from './pool'
import { RequestAnswer } from './request-answer'

/**
 * THE `cost.tasks` ANSWER, OWNED BY THE VIEW THAT OPENED IT [POD-2385].
 *
 * Per-task cost is host telemetry the usage harvest writes, not a synced
 * record, so it is a request answer: one question, fenced so an older poll can
 * never overwrite a newer one, closed with the view. The pricing and ranking
 * are client-core's (`taskCostRows`, `topWindowTasks`, `projectCostGroups`);
 * this class only holds the answer and caches each derivation as its own
 * field, so a streamed host-metric or usage update never reprices the tasks.
 *
 * Projects use the pool's declared issue/repo summaries. Stable repo identity
 * separates equal display names without loading full cold task records.
 */
export class TaskCostView extends RequestAnswer<readonly TaskCostRowWire[]> {
  constructor(private readonly pool: MobxPool) {
    super()
  }

  @action read(read: () => Promise<readonly TaskCostRowWire[]>): Promise<void> {
    return this.load(read)
  }

  /** Priced and ranked dearest-first, with the cohort from the same rows. */
  @lazy get priced() {
    return this.answer ? taskCostRows(this.answer) : null
  }

  @lazy get rows(): TaskCostRowView[] | null {
    return this.priced?.rows ?? null
  }

  @lazy get cohort() {
    return this.priced?.cohort ?? null
  }

  /** Loading candidates keep their place until the pool resolves visibility.
   * Gone candidates cannot displace a visible task or contribute project spend. */
  @lazy({ equals: compareShallow }) get visibleCandidates() {
    return (
      this.answer?.filter(
        (row) => !isGone(this.pool.row('issue', row.issueId, 'summary-fields')),
      ) ?? null
    )
  }

  /** Price only the window folds; the all-time sheet cohort remains on demand. */
  @lazy({ equals: compareShallow }) get windowRows() {
    return this.visibleCandidates ? windowTaskCosts(this.visibleCandidates) : null
  }

  @lazy({ equals: compareShallow }) get topTasks() {
    return this.windowRows ? topWindowTasks(this.windowRows) : null
  }

  /** Window spend grouped by project; read against a total with `projectCostShares`. */
  @lazy get projectGroups() {
    const answer = this.visibleCandidates
    return answer ? projectCostGroups(answer, (issueId) => this.projectOf(issueId)) : null
  }

  private projectOf(issueId: string): { key: string; name: string } | undefined {
    // These repo fields are declared by ISSUE_PAGE_SUMMARIES. Cold tasks use
    // that summary and the joined repo row without fetching a full issue.
    const issue = here(this.pool.row('issue', issueId, 'summary-fields')) as
      | { repoId?: string | null; repoPath?: string; repoName?: string }
      | undefined
    if (!issue) return undefined
    const key = issue.repoId ?? machinePathKey(issue.repoPath ?? '')
    const name = issueRepoName({ repoName: issue.repoName, repoPath: issue.repoPath ?? '' })
    return key && name ? { key, name } : undefined
  }

  dispose(): void {
    this.close()
  }
}

export function createTaskCostView(pool: MobxPool): TaskCostView {
  return new TaskCostView(pool)
}
