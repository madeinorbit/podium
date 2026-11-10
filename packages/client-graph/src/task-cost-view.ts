import {
  issueRepoName,
  projectCostGroups,
  type TaskCostRowView,
  taskCostRows,
  topWindowTasks,
} from '@podium/client-core/values'
import { lazy } from '@podium/mobx-helpers'
import type { TaskCostRowWire } from '@podium/model'
import { action } from 'mobx'
import { readPageIssue } from './issue-page'
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
 * Projects are read off the pool's shared issue model (`repoName`), the same
 * field the task screen prints. An issue still loading, or one this principal
 * cannot see, stays unattributed until it resolves.
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

  /** The window's five dearest tasks by their own cost. */
  @lazy get topTasks(): TaskCostRowView[] | null {
    return this.rows ? topWindowTasks(this.rows) : null
  }

  /** Window spend grouped by project; read against a total with `projectCostShares`. */
  @lazy get projectGroups() {
    const answer = this.answer
    return answer ? projectCostGroups(answer, (issueId) => this.projectOf(issueId)) : null
  }

  private projectOf(issueId: string): string | undefined {
    const issue = readPageIssue(this.pool, issueId)
    if (!issue || typeof issue === 'symbol') return undefined
    return issueRepoName(issue) || undefined
  }

  dispose(): void {
    this.close()
  }
}

export function createTaskCostView(pool: MobxPool): TaskCostView {
  return new TaskCostView(pool)
}
