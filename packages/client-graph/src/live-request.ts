import { action, observableRef, runInAction } from 'mobx'
import { AnswerRefresh, type AnswerSignal, focusRefresh } from './answer-refresh'

/** One opening owns the answer, its currency and its declared refresh signal. */
export class LiveRequest<T> {
  @observableRef accessor snapshot: {
    data: T | null
    error: string | null
    pending: boolean
    fetchedAt: number | null
  } = { data: null, error: null, pending: true, fetchedAt: null }
  private generation = 0
  private opened = false
  private readonly refreshes: AnswerRefresh
  constructor(
    readonly key: string,
    read: () => Promise<T>,
    readonly signal: AnswerSignal = focusRefresh,
  ) {
    this.refreshes = new AnswerRefresh(async () => {
      const generation = this.generation
      if (!this.opened) return
      runInAction(() => {
        this.snapshot = { ...this.snapshot, pending: true }
      })
      try {
        const data = await read()
        runInAction(() => {
          if (generation === this.generation && this.opened)
            this.snapshot = { data, error: null, pending: false, fetchedAt: Date.now() }
        })
      } catch (cause) {
        runInAction(() => {
          if (generation === this.generation && this.opened)
            this.snapshot = {
              ...this.snapshot,
              pending: false,
              error: cause instanceof Error ? cause.message : String(cause),
            }
        })
      }
    }, signal)
  }
  open(): void {
    this.opened = true
    this.refreshes.open()
  }
  readonly refresh = (): void => this.refreshes.refresh()
  @action close(): void {
    this.opened = false
    ++this.generation
    this.refreshes.close()
    this.snapshot = { data: null, error: null, pending: true, fetchedAt: null }
  }
}
