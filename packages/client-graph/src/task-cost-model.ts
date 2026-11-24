import { type TaskCostView, taskCostView } from '@podium/client-core/values'
import { type AnswerSignal, focusRefresh } from '@podium/client-graph/answer-refresh'
import { lazy } from '@podium/mobx-helpers'
import type { TaskCostComparisonWire } from '@podium/model/browser'
import { actionBound, observable, observableRef, runInAction } from 'mobx'

export type ReadTaskComparison = (input: {
  issueId: string
  includeSessions: boolean
}) => Promise<TaskCostComparisonWire>

/** One opening owns this request answer. No answer survives close or is shared
 * by unrelated views. Refresh only while the owning view and tab are visible. */
export class TaskCostModel {
  @observableRef accessor view: TaskCostView | null = null
  @observable accessor loading = false
  @observable accessor error: string | null = null
  private opened = false
  private visible = false
  private generation = 0
  private stop: (() => void) | undefined

  constructor(
    private readonly read: ReadTaskComparison,
    readonly issueId: string | null,
    private readonly includeSessions = true,
    readonly refreshSignal: AnswerSignal = focusRefresh,
  ) {}

  @lazy get failed(): boolean {
    return this.error !== null
  }

  @actionBound open(): void {
    this.opened = true
  }

  @actionBound setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.stop?.()
    this.stop = undefined
    if (this.opened && visible) {
      void this.refresh()
      this.stop = this.refreshSignal(() => {
        void this.refresh()
      })
    }
  }

  @actionBound async refresh(): Promise<void> {
    if (!this.opened || !this.visible || this.issueId === null) return
    const generation = ++this.generation
    this.loading = true
    this.error = null
    try {
      const answer = await this.read({
        issueId: this.issueId,
        includeSessions: this.includeSessions,
      })
      runInAction(() => {
        if (generation !== this.generation || !this.opened) return
        this.view = taskCostView(answer.task, answer.cohort)
        this.loading = false
      })
    } catch (error) {
      runInAction(() => {
        if (generation !== this.generation || !this.opened) return
        this.error = error instanceof Error ? error.message : String(error)
        this.loading = false
      })
    }
  }

  @actionBound close(): void {
    this.opened = false
    this.visible = false
    this.generation += 1
    this.stop?.()
    this.stop = undefined
    this.view = null
    this.loading = false
    this.error = null
  }
}
