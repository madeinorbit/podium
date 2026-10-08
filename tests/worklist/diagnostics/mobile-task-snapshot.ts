/** Diagnostic materialization only. Production reads MobileTasksBoard IDs and shared models. */
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { IssueRow, TaskProgress } from '@podium/client-core/values'
import type { IssueBoardStage } from '@podium/model/browser'
import { companion, lazy } from '@podium/mobx-helpers'
import type { MobileTasksOptions } from '@podium/client-graph/mobile-screens-schema'
import { MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'

export interface MobileTaskSection {
  stage: IssueBoardStage
  title: string
  rows: IssueRow<IssueViewModel>[]
}
export interface MobileTasksData {
  issues: IssueViewModel[]
  sessions: SessionView[]
  board: MobileTaskSection[]
  workingByIssue: Map<string, number>
  progressByIssue: Map<string, TaskProgress | null>
  proposals: number
}
export const EMPTY_MOBILE_TASKS: MobileTasksData = {
  issues: [],
  sessions: [],
  board: [],
  workingByIssue: new Map(),
  progressByIssue: new Map(),
  proposals: 0,
}
class TaskSnapshot {
  readonly board: MobileTasksBoard
  constructor(
    readonly pool: MobxPool,
    options: MobileTasksOptions,
  ) {
    this.board = new MobileTasksBoard(pool, options)
  }
  @lazy get value(): MobileTasksData | typeof LOADING {
    try {
      const sections = this.board.sections,
        proposals = this.board.proposals
      if (sections === LOADING || proposals === LOADING) return LOADING
      const issues = new Map<string, IssueViewModel>(),
        workingByIssue = new Map<string, number>(),
        progressByIssue = new Map<string, TaskProgress | null>()
      const row = (id: string) => {
        const value = this.pool.row('issueBoardRow', id)
        if (!value || value === LOADING) throw LOADING
        issues.set(id, value)
        return value
      }
      const board = sections.map((section) => ({
        stage: section.stage,
        title: section.title,
        rows: section.rows.map(({ id, ...placement }) => {
          const issue = row(id),
            model = this.pool.issueObject(id)
          if (issue.parentId) row(issue.parentId)
          workingByIssue.set(id, model.confirmedWorkingAgents)
          progressByIssue.set(id, model.taskProgress)
          return { issue, ...placement }
        }),
      }))
      return {
        board,
        proposals,
        issues: [...issues.values()],
        sessions: [],
        workingByIssue,
        progressByIssue,
      }
    } catch (error) {
      if (error === LOADING) return LOADING
      throw error
    }
  }
}
export function readMobileTaskSnapshot(pool: MobxPool, options: MobileTasksOptions) {
  const snapshot = pool.sources.view('diagnostic-mobile-tasks', () =>
    companion((options: MobileTasksOptions) => new TaskSnapshot(pool, options)),
  )
  return snapshot(options).value
}
