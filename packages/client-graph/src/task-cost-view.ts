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

  /** Skip all-time-only rows before observing any pool summaries.
   * Loading candidates keep their place until the pool resolves visibility.
   * Gone candidates cannot displace a visible task or contribute project spend. */
  @lazy({ equals: compareShallow }) get visibleCandidates() {
    return (
      this.answer?.filter(
        (row) => row.windowModels.length > 0 && !isGone(this.pool.stub(row.issueId)),
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
    // A held issue names its repository itself; otherwise its stub carries the
    // repo id and the repository row the name (POD-7087). Neither loads the issue.
    // untracked-read: task-cost-project-peek
    const held = here(this.pool.row('issue', issueId, 'peek')) as
      | { repoId?: string | null; repoPath?: string; repoName?: string }
      | undefined
    const stub = held ?? here(this.pool.stub(issueId))
    if (!stub) return undefined
    const repoId = stub.repoId ?? null
    const repo =
      repoId && !held?.repoName
        ? (here(this.pool.row('repo', repoId)) as
            | { name?: string | null; path?: string }
            | undefined)
        : undefined
    const repoPath = held?.repoPath ?? repo?.path ?? ''
    const key = repoId ?? machinePathKey(repoPath)
    const name = issueRepoName({ repoName: held?.repoName ?? repo?.name ?? undefined, repoPath })
    return key && name ? { key, name } : undefined
  }

  dispose(): void {
    this.close()
  }
}

export function createTaskCostView(pool: MobxPool): TaskCostView {
  return new TaskCostView(pool)
}
