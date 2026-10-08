import { action, observable, observableRef, runInAction } from 'mobx'

/** One question owned by an open view. Undefined means no answer yet; null
 * can be a successful answer. Every replacement/close invalidates older reads. */
export class RequestAnswer<T> {
  @observableRef accessor answer: T | undefined = undefined
  @observable accessor loading = false
  @observable accessor error: string | null = null
  private sequence = 0

  constructor(private readonly messageFor: (cause: unknown) => string = answerError) {}

  @action async load<R = T>(read: () => Promise<R>, clear = false, accept: (answer: R) => T = (answer) => answer as unknown as T): Promise<void> {
    const sequence = ++this.sequence
    this.loading = true
    this.error = null
    if (clear) this.answer = undefined
    try {
      const answer = await read()
      runInAction(() => {
        if (sequence === this.sequence) this.answer = accept(answer)
      })
    } catch (cause) {
      runInAction(() => {
        if (sequence === this.sequence) this.error = this.messageFor(cause)
      })
    } finally {
      runInAction(() => {
        if (sequence === this.sequence) this.loading = false
      })
    }
  }

  /** Invalidate a pending/debounced read without discarding the last reading. */
  @action cancel(): void {
    ++this.sequence
    this.loading = false
  }

  @action close(): void {
    this.cancel()
    this.answer = undefined
    this.error = null
  }
}

export function answerError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
