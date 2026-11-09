/**
 * THE LIVESTORE'S FRAME QUEUE (ADR 7 Amendment 2 D20).
 *
 * Every service that writes the LiveStore writes through one of these: the
 * topics (the live feed), the connection service and the outbox service share
 * the runtime root's queue. Writes are queued by key, the newest replacing an
 * older one still waiting, and the whole queue goes into the store once per
 * animation frame (one macrotask when the page is hidden), in the order the keys
 * were first queued since the last frame.
 *
 * Moved out of the live feed (POD-6681) unchanged, so that the connection and
 * outbox services keep applying their readings with the same frame as before.
 */

import { ConversationFrameScheduler } from '../conversation/frame-scheduler'

/** How queued readings reach the store: once per paint by default. */
export interface LiveFrameScheduler {
  enqueue(work: () => void): void
  dispose(): void
}

export class LiveFrameQueue {
  private readonly scheduler: LiveFrameScheduler
  /** The newest write per key, waiting for the next frame. */
  private readonly queued = new Map<string, () => void>()
  private flushQueued = false
  private disposed = false

  constructor(scheduler: LiveFrameScheduler = new ConversationFrameScheduler()) {
    this.scheduler = scheduler
  }

  /** Queue `write` under `key` for the next frame; a later write under the same key replaces it. */
  queue(key: string, write: () => void): void {
    if (this.disposed) return
    this.queued.delete(key)
    this.queued.set(key, write)
    if (this.flushQueued) return
    this.flushQueued = true
    this.scheduler.enqueue(() => this.flush())
  }

  /** Sign-out: nothing queued reaches the store any more. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queued.clear()
    this.scheduler.dispose()
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** One frame: every queued reading, in one action (the scheduler's). */
  private flush(): void {
    this.flushQueued = false
    if (this.disposed) return
    const writes = [...this.queued.values()]
    this.queued.clear()
    for (const write of writes) write()
  }
}
