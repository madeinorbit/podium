import { lazy } from '@podium/mobx-helpers'
import { compareShallow } from 'mobx'
import type { MobxPool, PoolRows } from './pool'
import { RecordRequest } from './requested-records'

/** One inventory question for an opening of Settings, shared by all routes.
 * Navigation retains the answer and joins the running read. Disposal fences
 * responses before they can enter the device pool. */
export class SettingsDevices extends RecordRequest<'device'> {
  private pendingRead: Promise<void> | undefined
  private answeredAt: number | undefined
  constructor(pool: MobxPool) {
    super(pool, 'device', (row) => row.sessionId)
  }
  ensure(read: () => Promise<readonly PoolRows['device'][]>, maxAgeMs = Infinity): Promise<void> {
    return (
      this.pendingRead ??
      (this.answer === undefined ||
      this.error !== null ||
      this.answeredAt === undefined ||
      Date.now() - this.answeredAt >= maxAgeMs
        ? this.refresh(read)
        : Promise.resolve())
    )
  }
  refresh(read: () => Promise<readonly PoolRows['device'][]>): Promise<void> {
    if (this.pendingRead) return this.pendingRead
    const pending = this.read(read).finally(() => {
      if (this.answer !== undefined && this.error === null) this.answeredAt = Date.now()
      if (this.pendingRead === pending) this.pendingRead = undefined
    })
    this.pendingRead = pending
    return pending
  }
  @lazy({ equals: compareShallow }) get orderedModels() {
    return [...this.models].sort((a, b) =>
      a.current !== b.current
        ? a.current
          ? -1
          : 1
        : (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt),
    )
  }
}
