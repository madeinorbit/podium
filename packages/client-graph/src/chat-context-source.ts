import type { ClientRuntime } from '@podium/client-core/engine'
import { outboxChatSends } from '@podium/client-core/engine'
import { asSessionId } from '@podium/model'
import { compareStructural, observable, runInAction } from 'mobx'
import { CHAT_ORDER_KINDS, type ChatContextRows } from './chat-context-schema'
import { createChatContextReader } from './chat-context'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

/** Read-side projection on the app-owned runtime. Demand returns LOADING and
 * coalesces in one microtask. Only requested draft/held rows become resident. */
export class ChatContextSource {
  private readonly rows = observable.map<string, object>(undefined, { deep: false })
  private readonly loaded = observable.set<string>()
  private readonly demanded = new Set<string>()
  private scheduled = false
  private outboxDirty = true
  private readonly dirtyOrders = new Set<string>(Object.keys(CHAT_ORDER_KINDS))
  private disposed = false
  private readonly stops: (() => void)[]
  private readonly reader: ChatContextRows['chatContextReader']
  readonly counts = { batches: 0, outboxReads: 0, orderLists: 0, addressedOrders: 0 }

  constructor(private readonly owner: Pick<ClientRuntime, 'getSnapshot' | 'subscribe' | 'outbox' | 'replica'>, pool: MobxPool) {
    if (!owner.replica.row || !owner.replica.subscribeAddressedBatch) throw new Error('Chat context requires the existing addressed replica')
    this.reader = createChatContextReader(pool)
    this.stops = [owner.subscribe(() => { if (this.demanded.size) this.schedule() }),
      owner.outbox.subscribe(() => { this.outboxDirty = true; if (this.demanded.size) this.schedule() }),
      owner.replica.subscribeAddressedBatch!(batch => {
        if (batch.type === 'replace') {
          for (const entity of Object.keys(CHAT_ORDER_KINDS)) this.dirtyOrders.add(entity)
          if (this.demanded.size) this.schedule()
          return
        }
        runInAction(() => {
          for (const [entity, kind] of Object.entries(CHAT_ORDER_KINDS)) {
            const key = `${entity}:order`
            if (!this.loaded.has(key)) continue
            const previous = this.rows.get(key) as { ids: readonly string[] }
            let ids = [...previous.ids]
            for (const address of batch.rows) if (address.kind === kind) {
              const present = !!owner.replica.row!(kind, address.id)
              if (!present) ids = ids.filter(id => id !== address.id)
              else if (!ids.includes(address.id)) ids.push(address.id)
              this.counts.addressedOrders++
            }
            this.set(key, { ids })
          }
        })
      })]
  }

  read(entity: keyof ChatContextRows, id: string): Loaded<ChatContextRows[keyof ChatContextRows]> {
    if (this.disposed) return LOADING
    if (entity === 'chatContextReader') return this.reader
    const key = `${entity}:${id}`
    this.demanded.add(key)
    if (!this.loaded.has(key)) { this.schedule(); return LOADING }
    return this.rows.get(key) as ChatContextRows[keyof ChatContextRows] | undefined
  }

  private set(key: string, row: object): void {
    if (!compareStructural(this.rows.get(key), row)) this.rows.set(key, row)
    this.loaded.add(key)
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) return
      const state = this.owner.getSnapshot()
      const heldKeys = [...this.demanded].filter(key => key.startsWith('chatHeld:'))
      const refreshHeld = heldKeys.some(key => !this.loaded.has(key)) || this.outboxDirty
      const pending = refreshHeld && heldKeys.length ? this.owner.outbox.pending() : undefined
      const parked = pending ? this.owner.outbox.deadLetters() : undefined
      if (pending) { this.outboxDirty = false; this.counts.outboxReads++ }
      runInAction(() => {
        for (const key of this.demanded) {
          if (key.startsWith('chatDraft:')) this.set(key, { text: state.drafts?.[key.slice(10)] ?? '' })
          else if (key === 'chatWindow:window') this.set(key, { attachedSessionId: state.attachedSessionId ?? null, transcriptReveal: state.transcriptReveal ?? null })
          else if (key.startsWith('chatHeld:') && pending && parked) this.set(key, {
            sends: outboxChatSends({ pending: () => pending, deadLetters: () => parked } as ClientRuntime['outbox'], asSessionId(key.slice(9))),
          })
        }
        for (const [entity, kind] of Object.entries(CHAT_ORDER_KINDS)) {
          const key = `${entity}:order`
          if (!this.demanded.has(key) || !this.dirtyOrders.has(entity)) continue
          this.set(key, { ids: this.owner.replica.rows(kind).map(row => kind === 'sessions' ? (row as { sessionId: string }).sessionId : (row as { id: string }).id) })
          this.dirtyOrders.delete(entity)
          this.counts.orderLists++
        }
        this.counts.batches++
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    this.demanded.clear()
    queueMicrotask(() => runInAction(() => { this.rows.clear(); this.loaded.clear() }))
  }
}
