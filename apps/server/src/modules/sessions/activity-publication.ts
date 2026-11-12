import type { SessionStore } from '../../store'
import type { SessionWriter } from './session-lifecycle-types'

/**
 * Finish throttled activity publications on the existing activity tick. The
 * pending set and deadline live in the database, so a final stamp survives a
 * restart and a parked session needs no live object or timer of its own.
 */
export class SessionActivityPublication {
  private inFlight: Promise<void> | undefined

  constructor(
    private readonly ports: {
      store: Pick<SessionStore, 'sessions' | 'transferFenceActive'>
      writer: SessionWriter
      now(): number
    },
  ) {}

  flush(): Promise<void> {
    this.inFlight ??= this.flushOnce().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async flushOnce(): Promise<void> {
    if (this.ports.store.transferFenceActive) return
    const now = this.ports.now()
    const ids = await this.ports.store.sessions.activityPublicationsDue(now)
    if (ids.length === 0) return
    await this.ports.writer.commit({
      write: async (scope) =>
        await this.ports.store.sessions.publishActivity(scope, ids, this.ports.now()),
    })
  }
}
