import { action } from 'mobx'
import { hasDomWindow } from '../platform-globals'
import { createFeedTaskScheduler, type FeedTaskScheduler } from '../socket-transport/feed-scheduler'

export interface ConversationFrameSchedulerOptions {
  visible?: () => boolean
  requestFrame?: (callback: () => void) => unknown
  cancelFrame?: (token: unknown) => void
  tasks?: FeedTaskScheduler
  /** Native hosts can supply AppState visibility changes here. */
  onVisibilityChange?: (listener: () => void) => () => void
}

/** Immediate intake; one atomic publication per paint, or hidden macrotask. */
export class ConversationFrameScheduler {
  private pending: (() => void)[] = []
  private scheduled = false
  private frame: unknown = undefined
  private epoch = 0
  private disposed = false
  private readonly tasks: FeedTaskScheduler
  private readonly stopVisibility: (() => void) | undefined
  private readonly visible: () => boolean
  private readonly requestFrame: ((callback: () => void) => unknown) | undefined
  private readonly cancelFrame: ((token: unknown) => void) | undefined

  constructor(options: ConversationFrameSchedulerOptions = {}) {
    this.tasks = options.tasks ?? createFeedTaskScheduler()
    this.visible =
      options.visible ??
      (() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
    this.requestFrame =
      options.requestFrame ??
      (typeof requestAnimationFrame === 'function'
        ? (callback) => requestAnimationFrame(callback)
        : undefined)
    this.cancelFrame =
      options.cancelFrame ??
      (typeof cancelAnimationFrame === 'function'
        ? (token) => cancelAnimationFrame(token as number)
        : undefined)
    const changed = () => {
      if (!this.scheduled || this.visible() || this.frame === undefined) return
      this.cancelFrame?.(this.frame)
      this.frame = undefined
      this.scheduled = false
      this.epoch++
      this.schedule()
    }
    if (options.onVisibilityChange) this.stopVisibility = options.onVisibilityChange(changed)
    else if (hasDomWindow() && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', changed)
      this.stopVisibility = () => document.removeEventListener('visibilitychange', changed)
    }
  }

  enqueue(work: () => void): void {
    if (this.disposed) return
    this.pending.push(work)
    this.schedule()
  }

  /** A disconnect also discards queued previews from the abandoned stream. */
  clear(): void {
    this.pending.length = 0
    this.epoch++
    this.scheduled = false
    if (this.frame !== undefined) this.cancelFrame?.(this.frame)
    this.frame = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.clear()
    this.disposed = true
    this.tasks.dispose()
    this.stopVisibility?.()
  }

  private schedule(): void {
    if (this.scheduled || this.disposed || this.pending.length === 0) return
    this.scheduled = true
    const epoch = ++this.epoch
    const apply = action('Conversation.applyFrame', () => {
      if (this.disposed || epoch !== this.epoch) return
      this.scheduled = false
      this.frame = undefined
      const batch = this.pending
      this.pending = []
      for (const work of batch) work()
    })
    if (this.visible() && this.requestFrame) this.frame = this.requestFrame(apply)
    else this.tasks.schedule(apply)
  }
}
