import { taskCostView, type TaskCostView } from '@podium/client-core/values'
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
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly read: ReadTaskComparison,
    readonly issueId: string,
    private readonly includeSessions = true,
  ) {}

  @actionBound open(): void {
    this.opened = true
  }

  @actionBound setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    clearInterval(this.timer)
    this.timer = undefined
    if (this.opened && visible) {
      void this.refresh()
      this.timer = setInterval(() => {
        if (!this.loading) void this.refresh()
      }, 90_000)
    }
  }

  @actionBound async refresh(): Promise<void> {
    if (!this.opened || !this.visible) return
    const generation = ++this.generation
    this.loading = true
    this.error = null
    try {
      const answer = await this.read({ issueId: this.issueId, includeSessions: this.includeSessions })
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
    clearInterval(this.timer)
    this.timer = undefined
    this.view = null
    this.loading = false
    this.error = null
  }
}
