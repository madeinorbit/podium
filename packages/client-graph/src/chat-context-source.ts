import type { ClientRuntime } from '@podium/client-core/engine'
import { outboxChatSends } from '@podium/client-core/chat-values'
import { asSessionId } from '@podium/model'
import {
  compareStructural,
  computed,
  type IComputedValue,
  type ObservableSet,
  observable,
  observe,
  runInAction,
} from 'mobx'
import { CHAT_ORDER_KINDS, type ChatContextRows } from './chat-context-schema'
import { createChatContextReader } from './chat-context'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

interface ChatOrder {
  readonly members: ObservableSet<string>
  readonly row: IComputedValue<{ ids: readonly string[] }>
}

/** Read-side projection on the app-owned runtime. Demand returns LOADING and
 * coalesces in one microtask. Only requested draft/held rows become resident. */
export class ChatContextSource {
  private readonly rows = observable.map<string, object>(undefined, { deep: false })
  private readonly loaded = observable.set<string>()
  private readonly demanded = new Set<string>()
  /** Demanded keys a wake moved (POD-5433): one draft, the window, the held sends. */
  private readonly dirty = new Set<string>()
  private scheduled = false
  private outboxDirty = true
  /** The order lists, kept by address (finding 13): membership in replica
   *  insertion order, which a reader's `{ ids }` is derived from. A
   *  batch costs its addresses; the list is built only when it moved. */
  private readonly orders = new Map<string, ChatOrder>()
  private disposed = false
  private readonly stops: (() => void)[]
  private readonly reader: ChatContextRows['chatContextReader']
  readonly counts = { batches: 0, outboxReads: 0, orderLists: 0, addressedOrders: 0, orderIds: 0 }

  constructor(
    private readonly owner: Pick<
      ClientRuntime,
      'readLocal' | 'onLocals' | 'drafts' | 'outbox' | 'replica'
    >,
    pool: MobxPool,
  ) {
    if (!owner.replica.row || !owner.replica.subscribeAddressedBatch)
      throw new Error('Chat context requires the existing addressed replica')
    this.reader = createChatContextReader(pool)
    const wake = (key: string) => {
      if (!this.demanded.has(key)) return
      this.dirty.add(key)
      this.schedule()
    }
    this.stops = [
      observe(owner.drafts.values, (change) => wake(`chatDraft:${change.name}`)),
      owner.onLocals(['attachedSessionId', 'transcriptReveal'], () => wake('chatWindow:window')),
      owner.outbox.subscribe(() => {
        this.outboxDirty = true
        if (this.demanded.size) this.schedule()
      }),
      owner.replica.subscribeAddressedBatch!((batch) => {
        if (batch.type === 'replace') {
          for (const entity of this.orders.keys()) this.fill(entity)
          return
        }
        runInAction(() => {
          for (const [entity, order] of this.orders) {
            const kind = CHAT_ORDER_KINDS[entity as keyof typeof CHAT_ORDER_KINDS]
            for (const address of batch.rows)
              if (address.kind === kind) {
                this.counts.addressedOrders++
                const present = !!owner.replica.row!(kind, address.id)
                if (present === order.members.has(address.id)) continue
                if (present) order.members.add(address.id)
                else order.members.delete(address.id)
              }
          }
        })
      }),
    ]
  }

  read(entity: keyof ChatContextRows, id: string): Loaded<ChatContextRows[keyof ChatContextRows]> {
    if (this.disposed) return LOADING
    if (entity === 'chatContextReader') return this.reader
    const key = `${entity}:${id}`
    this.demanded.add(key)
    if (!this.loaded.has(key)) {
      this.schedule()
      return LOADING
    }
    const order = this.orders.get(entity)
    if (order !== undefined && id === 'order') return order.row.get()
    return this.rows.get(key) as ChatContextRows[keyof ChatContextRows] | undefined
  }

  private set(key: string, row: object): void {
    if (!compareStructural(this.rows.get(key), row)) this.rows.set(key, row)
    this.loaded.add(key)
  }

  /** One whole pass over a kind, on first demand and on a replace only. */
  private fill(entity: string): void {
    const kind = CHAT_ORDER_KINDS[entity as keyof typeof CHAT_ORDER_KINDS]
    const members = new Set(
      this.owner.replica
        .rows(kind)
        .map((row) =>
          kind === 'sessions'
            ? (row as { sessionId: string }).sessionId
            : (row as { id: string }).id,
        ),
    )
    this.counts.orderLists++
    runInAction(() => {
      const order = this.orders.get(entity)
      if (order === undefined) {
        const created: ChatOrder = {
          members: observable.set(members, { deep: false }),
          row: computed(
            () => {
              this.counts.orderIds += created.members.size
              return { ids: [...created.members] }
            },
            { equals: compareStructural },
          ),
        }
        this.orders.set(entity, created)
      } else {
        order.members.replace(members)
      }
      this.loaded.add(`${entity}:order`)
    })
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) return
      const heldKeys = [...this.demanded].filter((key) => key.startsWith('chatHeld:'))
      const refreshHeld = heldKeys.some((key) => !this.loaded.has(key)) || this.outboxDirty
      const pending = refreshHeld && heldKeys.length ? this.owner.outbox.pending() : undefined
      const parked = pending ? this.owner.outbox.deadLetters() : undefined
      if (pending) {
        this.outboxDirty = false
        this.counts.outboxReads++
      }
      runInAction(() => {
        for (const key of this.demanded) {
          const fresh = !this.loaded.has(key) || this.dirty.has(key)
          if (key.startsWith('chatDraft:')) {
            if (fresh) this.set(key, { text: this.owner.drafts.get(asSessionId(key.slice(10))) })
          } else if (key === 'chatWindow:window') {
            if (fresh)
              this.set(key, {
                attachedSessionId: this.owner.readLocal('attachedSessionId') ?? null,
                transcriptReveal: this.owner.readLocal('transcriptReveal') ?? null,
              })
          } else if (key.startsWith('chatHeld:') && pending && parked)
            this.set(key, {
              sends: outboxChatSends(
                { pending: () => pending, deadLetters: () => parked } as ClientRuntime['outbox'],
                asSessionId(key.slice(9)),
              ),
            })
        }
        this.dirty.clear()
        for (const entity of Object.keys(CHAT_ORDER_KINDS)) {
          if (this.demanded.has(`${entity}:order`) && !this.orders.has(entity)) this.fill(entity)
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
    queueMicrotask(() =>
      runInAction(() => {
        this.rows.clear()
        this.loaded.clear()
        this.orders.clear()
      }),
    )
  }
}
