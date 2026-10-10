import type { MessageLedgerWire, MessageRecordWire } from '@podium/model'
import { action, observable, observableRef, runInAction } from 'mobx'
import { ingestLedgerMessages, ingestMessageRecords } from './message-models'
import type { MobxPool } from './pool'

export interface LedgerRequest {
  ledger(): Promise<readonly MessageLedgerWire[]>
  records?(ids: readonly string[]): Promise<readonly MessageRecordWire[]>
}
/** A fresh model per opening. The request selects IDs; record facts join the
 * existing tables. Polling has visible demand only, pending server push. */
export class MessageLedger {
  @observableRef accessor ids: readonly string[] | null = null
  @observable accessor error: string | null = null
  @observable accessor loading = false
  private visible = false
  private disposed = false
  private sequence = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(readonly pool: MobxPool, private readonly request: LedgerRequest) {}

  @action setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return
    this.visible = visible
    this.cancelTimer()
    if (visible) void this.refresh()
  }
  @action async refresh(): Promise<void> {
    if (this.disposed || this.loading) return
    this.loading = true
    const sequence = ++this.sequence
    try {
      const rows = await this.request.ledger()
      if (this.disposed || sequence !== this.sequence) return
      const ids = rows.map(row => row.id)
      const records = this.request.records && ids.length ? await this.request.records(ids) : []
      if (this.disposed || sequence !== this.sequence) return
      runInAction(() => {
        ingestLedgerMessages(this.pool, rows)
        ingestMessageRecords(this.pool, records)
        this.ids = ids
        this.error = null
      })
    } catch (cause) {
      if (!this.disposed && sequence === this.sequence) runInAction(() => {
        this.error = cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      if (!this.disposed && sequence === this.sequence) {
        runInAction(() => { this.loading = false })
        this.cancelTimer()
        if (this.visible) this.timer = setTimeout(() => { this.timer = undefined; void this.refresh() }, 15_000)
      }
    }
  }
  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
  dispose(): void {
    this.disposed = true
    this.sequence++
    this.cancelTimer()
  }
}
