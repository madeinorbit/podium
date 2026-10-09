import { omitGone } from './lookup'
import { headerEntities } from './header-entities'
import { loadedPaneSession } from './session-pane'
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import type { ReadPositionValue } from '@podium/client-core'
import type { SuperagentSliceValue, SuperThreadView } from '@podium/client-core/values'
import type { GitRepositoryWire, IssueEventWire, SessionId } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import type { MobxPool } from './pool'
import type { PoolSource } from './source-registry'
import type { Loaded } from './worklist/rollup'

/** The RPC list and the cursor port are already principal-scoped by the one
 * runtime. This attachment borrows them; it has no RPC, cache or write owner. */
export interface SuperagentRows {
  superThread: SuperThreadView
  superThreadCatalog: { ids: readonly string[] }
  superagentLocal: Pick<Store, 'superThreadId' | 'paneA' | 'selectedWorktree'> & { booting: boolean }
  superagentEvent: IssueEventWire
  superagentEventTail: { ids: readonly string[] }
  superagentReadPosition: ReadPositionValue
}
declare module './source-registry' { interface PoolSourceRows extends SuperagentRows {} }
export const SUPERAGENT_ENTITIES = ['superThread', 'superThreadCatalog', 'superagentLocal',
  'superagentEvent', 'superagentEventTail', 'superagentReadPosition'] as const
export const SUPERAGENT_SOURCE_KEY = 'superagent'
export const SUPERAGENT_EVENT_TAIL = 40
export const SUPERAGENT_SCHEMA = {
  superThread: { key: 'id', source: 'engine:superThreads (principal-scoped listThreads)', residency: 'resident-on-demand' },
  superThreadCatalog: { key: 'catalog', source: 'resident:superThread membership in RPC order' },
  superagentLocal: { key: 'local', source: 'engine:locals', fields: ['superThreadId', 'paneA', 'selectedWorktree', 'booting'] },
  superagentEvent: { key: 'id', source: 'replica:issueEvents', residency: 'tail members only' },
  superagentEventTail: { key: 'tail', source: 'replica:issueEvents ids (newest window)', order: 'eventId ascending', limit: SUPERAGENT_EVENT_TAIL },
  superagentReadPosition: { key: 'issueEvents', source: 'runtime:readPosition (principal-scoped)',
    visibilityContext: 'existing readPosition port: one get at the visibility edge to freeze presentation before pool attachment' },
  session: { source: 'pool:session', reader: 'sessionPanes.session', summary: ['sessionId', 'cwd', 'machineId'] },
  repository: { source: 'header:repository', reader: 'pool.row' },
} as const
export const SUPERAGENT_RELATIONS = [
  { from: 'superThread', name: 'session', key: 'podiumSessionId', to: 'session', inverse: 'superThreads' },
  { from: 'superThread', name: 'originSession', key: 'originSessionId', to: 'session', inverse: 'originSuperThreads' },
] as const
export const SUPERAGENT_SUMMARIES = { session: SUPERAGENT_SCHEMA.session.summary }

type SuperagentOwner = Pick<ClientRuntime, 'replica' | 'readPosition' | 'readLocal' | 'onLocals' | 'onList' | 'listIds' | 'listRow'>

/** MobX and the loading sentinel arrive only after the app-load switch has
 * latched ON. Initial demands coalesce; incremental events use addressed rows. */
export async function createSuperagentSource(owner: SuperagentOwner): Promise<PoolSource<keyof SuperagentRows> & {
  counts: { batches: number; threadLists: number; eventCollections: number; addressedEvents: number; questionCollections: number }
}> {
  const [{ observable, runInAction, compareStructural }, rollup] = await Promise.all([
    import('mobx'), import('./worklist/rollup'),
  ])
  const { defineSource } = await import('./source-registry')
  const LOADING: typeof import('./worklist/rollup').LOADING = rollup.LOADING
  const replica = owner.replica
  if (!replica.rowCount) throw new Error('Superagent requires keyed replica counts')
  if (!replica.row || !replica.subscribeAddressedBatch) throw new Error('Superagent requires the existing addressed replica')
  class Source {
    private readonly rows = observable.map<string, object>(undefined, { deep: false })
    private readonly edges = observable.map<string, readonly string[]>(undefined, { deep: false })
    private readonly loaded = observable.set<string>()
    private readonly demanded = new Set<string>()
    private readonly addressedThreads = new Set<string>()
    /** Keyed (POD-5433): what each wake moved. */
    private threadsDirty = true
    private localDirty = true
    private bootingDirty = true
    private booting = true
    private eventsDirty = true
    /** The newest events, ascending. Only these rows are read and held; older
     * retained history is never read or sorted. */
    private window: TailEntry[] = []
    private readonly source = defineSource({
      readById: this.readById.bind(this),
      refresh: this.refresh.bind(this),
      release: this.release.bind(this),
    })
    private get disposed(): boolean { return this.source.disposed }
    private readonly stops: (() => void)[]
    readonly counts = { batches: 0, threadLists: 0, eventCollections: 0, addressedEvents: 0, questionCollections: 0 }

    constructor() {
      const local = () => { this.localDirty = true; if (this.demanded.has('threads')) this.schedule() }
      const boot = () => { this.bootingDirty = true; if (this.demanded.has('threads')) this.schedule() }
      // A cold cursor with rows present: only a removal can make it boot again.
      const removed = (rows: readonly { kind: string; id: string }[]) => rows.some(address =>
        (address.kind === 'sessions' || address.kind === 'issueProjections') && !replica.row?.(address.kind, address.id))
      this.stops = [owner.onList('superThreads', () => { this.threadsDirty = true; if (this.demanded.has('threads') || this.addressedThreads.size) this.schedule() }),
        owner.onLocals(['superThreadId', 'paneA', 'selectedWorktree'], local),
        owner.readPosition.subscribe(() => { if (this.demanded.has('position')) this.schedule() }),
        // `booting` can move only while it holds, or when the cursor is cold.
        ...(replica.subscribeCursor ? [replica.subscribeCursor(() => { if (this.booting || replica.getCursor() === null) boot() })] : []),
        replica.subscribeAddressedBatch!(batch => {
          if (this.disposed) return
          if (batch.type === 'replace') {
            this.eventsDirty = true; this.localDirty = true; this.bootingDirty = true
            if (this.demanded.size) this.schedule()
            return
          }
          if (this.booting || (replica.getCursor() === null && removed(batch.rows))) boot()
          runInAction(() => {
            let events = false, refill = false
            for (const address of batch.rows) {
              if (address.kind === 'issueEvents' && this.loaded.has('events')) {
                refill = this.event(address.id, replica.row!('issueEvents', address.id)) || refill
                this.counts.addressedEvents++; events = true
              }
            }
            if (refill) this.collect(false)
            else if (events) this.tail()
          })
        })]
    }

    read(entity: keyof SuperagentRows, id: string): Loaded<SuperagentRows[keyof SuperagentRows]> {
      return this.source.read(entity, id) as Loaded<SuperagentRows[keyof SuperagentRows]>
    }

    private readById(entity: keyof SuperagentRows, id: string): Loaded<SuperagentRows[keyof SuperagentRows]> {
      if (entity === 'superThread' && !this.demanded.has('threads')) {
        this.addressedThreads.add(id)
        if (!this.loaded.has(`thread:${id}`)) { this.schedule(); return LOADING }
        return this.rows.get(`superThread:${id}`) as SuperagentRows['superThread'] | undefined
      }
      const group = entity.startsWith('superagentEvent') ? 'events' : entity === 'superagentReadPosition' ? 'position' : 'threads'
      this.demanded.add(group)
      if (!this.loaded.has(group)) {
        if (group === 'threads') this.threadsDirty = true
        this.schedule(); return LOADING
      }
      return this.rows.get(`${entity}:${id}`) as SuperagentRows[keyof SuperagentRows] | undefined
    }

    related(entity: string, id: string, name: string): readonly string[] {
      return this.disposed ? [] : this.edges.get(`${entity}:${id}:${name}`) ?? []
    }

    private set(key: string, value: object) {
      if (!compareStructural(this.rows.get(key), value)) this.rows.set(key, value)
    }

    private thread(id: string, row: Store['superThreads'][number] | undefined) {
      const before = this.rows.get(`superThread:${id}`) as Store['superThreads'][number] | undefined
      for (const relation of SUPERAGENT_RELATIONS) {
        const oldTarget = before?.[relation.key], target = row?.[relation.key]
        if (oldTarget === target) continue
        if (oldTarget) {
          const inverse = `${relation.to}:${oldTarget}:${relation.inverse}`
          const ids = (this.edges.get(inverse) ?? []).filter(member => member !== id)
          if (ids.length) this.edges.set(inverse, ids)
          else this.edges.delete(inverse)
        }
        const forward = `${relation.from}:${id}:${relation.name}`
        if (target) {
          this.edges.set(forward, [target])
          const inverse = `${relation.to}:${target}:${relation.inverse}`
          this.edges.set(inverse, [...(this.edges.get(inverse) ?? []), id])
        } else this.edges.delete(forward)
      }
      if (row) this.set(`superThread:${id}`, row)
      else this.rows.delete(`superThread:${id}`)
    }

    private threads(next: Store['superThreads']) {
      this.counts.threadLists++
      const keep = new Set(next.map(row => row.id))
      for (const key of this.rows.keys()) if (key.startsWith('superThread:') && !keep.has(key.slice(12))) this.rows.delete(key)
      for (const row of next) this.set(`superThread:${row.id}`, row)
      this.set('superThreadCatalog:catalog', { ids: next.map(row => row.id) })
      // Both directions follow the declared relation metadata. Only resident
      // private threads participate; sessions are never loaded to build edges.
      const edges = new Map<string, string[]>()
      for (const row of next) for (const relation of SUPERAGENT_RELATIONS) {
        const target = row[relation.key]
        if (!target) continue
        edges.set(`${relation.from}:${row.id}:${relation.name}`, [target])
        const inverse = `${relation.to}:${target}:${relation.inverse}`
        edges.set(inverse, [...(edges.get(inverse) ?? []), row.id])
      }
      for (const key of this.edges.keys()) if (!edges.has(key)) this.edges.delete(key)
      for (const [key, ids] of edges) if (!compareStructural(this.edges.get(key), ids)) this.edges.set(key, ids)
    }

    private tail() {
      this.set('superagentEventTail:tail', { ids: this.window.map(entry => entry.id) })
    }

    /** Choose the window from keyed membership, then read only its new rows. */
    private collect(reread: boolean) {
      const next = newestEvents(replica.ids?.('issueEvents') ?? replica.rows('issueEvents').map(row => row.id),
        id => replica.row!('issueEvents', id)?.eventId)
      const keep = new Set(next.map(entry => entry.id))
      for (const key of [...this.rows.keys()]) {
        if (key.startsWith('superagentEvent:') && (reread || !keep.has(key.slice(16)))) this.rows.delete(key)
      }
      this.window = []
      for (const entry of next) {
        if (this.rows.has(`superagentEvent:${entry.id}`)) { this.window.push(entry); continue }
        const row = replica.row!('issueEvents', entry.id)
        if (!row) continue
        this.window.push({ id: row.id, eventId: row.eventId })
        this.rows.set(`superagentEvent:${row.id}`, row)
      }
      this.tail()
    }

    /** One addressed event. True when a member left a full window, so an
     * older retained event may now belong to it. */
    private event(id: string, row: IssueEventWire | undefined): boolean {
      const index = this.window.findIndex(entry => entry.id === id)
      if (index >= 0) {
        const full = this.window.length === SUPERAGENT_EVENT_TAIL
        this.window.splice(index, 1)
        if (!row) { this.rows.delete(`superagentEvent:${id}`); return full }
      }
      if (!row) return false
      const entry = { id, eventId: row.eventId }
      if (this.window.length === SUPERAGENT_EVENT_TAIL && compareTail(entry, this.window[0]!) < 0) {
        this.rows.delete(`superagentEvent:${id}`)
        return false
      }
      insertTail(this.window, entry)
      this.set(`superagentEvent:${id}`, row)
      if (this.window.length > SUPERAGENT_EVENT_TAIL) this.rows.delete(`superagentEvent:${this.window.shift()!.id}`)
      return false
    }

    private schedule(): void {
      this.source.schedule()
    }

    private refresh(): void {
      runInAction(() => {
        if (this.threadsDirty || [...this.addressedThreads].some(id => !this.loaded.has(`thread:${id}`))) {
          for (const id of this.addressedThreads) {
            const row = owner.listRow('superThreads', id)
            this.thread(id, row)
            this.loaded.add(`thread:${id}`)
          }
          if (!this.demanded.has('threads')) this.threadsDirty = false
        }
        if (this.demanded.has('threads')) {
          if (this.threadsDirty) {
            this.threadsDirty = false
            this.threads(owner.listIds('superThreads').flatMap(id => owner.listRow('superThreads', id) ?? []))
          }
          const before = this.booting
          if (this.bootingDirty) {
            this.bootingDirty = false
            this.booting = replica.getCursor() === null &&
              replica.rowCount!('sessions') === 0 && replica.rowCount!('issueProjections') === 0
          }
          if (this.localDirty || this.booting !== before) {
            this.localDirty = false
            this.set('superagentLocal:local', { superThreadId: owner.readLocal('superThreadId'), paneA: owner.readLocal('paneA'),
              selectedWorktree: owner.readLocal('selectedWorktree'), booting: this.booting })
          }
          this.loaded.add('threads')
        }
        if (this.demanded.has('events') && this.eventsDirty) {
          this.collect(true); this.eventsDirty = false; this.loaded.add('events'); this.counts.eventCollections++
        }
        if (this.demanded.has('position')) {
          this.set('superagentReadPosition:issueEvents', owner.readPosition.get('issueEvents'))
          this.loaded.add('position')
        }
        this.counts.batches++
      })
    }

    dispose(): void {
      this.source.dispose()
    }

    private release() {
      for (const stop of this.stops) stop()
      this.addressedThreads.clear()
      this.demanded.clear()
      queueMicrotask(() => runInAction(() => { this.rows.clear(); this.edges.clear(); this.loaded.clear(); this.window = [] }))
    }
  }
  return new Source()
}

interface TailEntry { readonly id: string; readonly eventId: number }
const compareTail = (a: TailEntry, b: TailEntry): number =>
  a.eventId - b.eventId || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
function insertTail(window: TailEntry[], entry: TailEntry): void {
  let low = 0, high = window.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (compareTail(window[middle]!, entry) < 0) low = middle + 1
    else high = middle
  }
  window.splice(low, 0, entry)
}
/** A row ID starts with its durable event id (`issueEventRowId`), so the
 * window is chosen from membership alone; only a malformed ID reads its row. */
function eventIdOf(id: string, read: (id: string) => number | undefined): number | undefined {
  const end = id.indexOf('\n'), head = end < 0 ? '' : id.slice(0, end)
  return /^[1-9]\d*$/.test(head) ? Number(head) : read(id)
}
/** Bounded selection: at most SUPERAGENT_EVENT_TAIL entries are ever ordered. */
export function newestEvents(ids: Iterable<string>, read: (id: string) => number | undefined): TailEntry[] {
  const window: TailEntry[] = []
  for (const id of ids) {
    const eventId = eventIdOf(id, read)
    if (eventId === undefined) continue
    const entry = { id, eventId }
    if (window.length === SUPERAGENT_EVENT_TAIL) {
      if (compareTail(entry, window[0]!) < 0) continue
      window.shift()
    }
    insertTail(window, entry)
  }
  return window
}

// Dependency-free readers: importing the OFF screen builds no graph or MobX.
const pending = (row: unknown): boolean => typeof row === 'symbol'
export function superagentThread(pool: MobxPool, id: string) {
  const catalog = omitGone(pool.row('superThreadCatalog', 'catalog'))
  if (!catalog || typeof catalog === 'symbol') return { thread: undefined, loading: pending(catalog) }
  // A bare, guessed private id never becomes an addressed load or an RPC.
  if (!catalog.ids.includes(id)) return { thread: undefined, loading: false }
  const thread = omitGone(pool.row('superThread', id))
  return { thread: typeof thread === 'symbol' ? undefined : thread, loading: pending(thread) }
}
export function superagentState(pool: MobxPool): SuperagentSliceValue & { loading: boolean; booting: boolean } {
  const local = omitGone(pool.row('superagentLocal', 'local')), catalog = omitGone(pool.row('superThreadCatalog', 'catalog'))
  const threads: SuperThreadView[] = []
  let loading = pending(local) || pending(catalog)
  if (catalog && typeof catalog !== 'symbol') for (const id of catalog.ids) {
    const row = omitGone(pool.row('superThread', id))
    if (typeof row === 'symbol') loading = true
    else if (row) threads.push(row)
  }
  const active = local && typeof local !== 'symbol' ? threads.find(row => row.id === local.superThreadId) : undefined
  return { threads, active, activeSessionId: active?.podiumSessionId, loading,
    booting: !local || typeof local === 'symbol' || local.booting }
}
export function superagentFeed(pool: MobxPool) {
  const tail = omitGone(pool.row('superagentEventTail', 'tail'))
  const events: { id: number; ts: string; kind: string; subject: string; repoPath: string | null; payload: unknown }[] = []
  let loading = pending(tail)
  if (tail && typeof tail !== 'symbol') for (const id of tail.ids) {
    const row = omitGone(pool.row('superagentEvent', id))
    if (typeof row === 'symbol') loading = true
    else if (row) events.push({ id: row.eventId, ts: row.ts, kind: row.kind, subject: row.subject, repoPath: row.repoPath, payload: row.payload })
  }
  return { events, loading }
}
export function superagentCursor(pool: MobxPool) {
  const row = omitGone(pool.row('superagentReadPosition', 'issueEvents'))
  return { cursor: !row || typeof row === 'symbol' ? { lastEventId: 0, seenAt: null } : row, loading: pending(row) }
}
export function superagentQuestion(pool: MobxPool, sessionId: SessionId | undefined) {
  if (!sessionId) return { question: undefined, loading: false }
  const membership = omitGone(pool.row('noticeSession', sessionId))
  let loading = pending(membership)
  if (membership && typeof membership !== 'symbol') for (const id of membership.interactions) {
    const row = omitGone(pool.row('pendingInteraction', id))
    if (typeof row === 'symbol') { loading = true; continue }
    if (row?.sessionId === sessionId && row.kind === 'question' && row.status === 'asked') return { question: row, loading }
  }
  return { question: undefined as Extract<PendingInteractionWire, { kind: 'question' }> | undefined, loading }
}
export function superagentFocus(pool: MobxPool) {
  const local = omitGone(pool.row('superagentLocal', 'local'))
  const repos: GitRepositoryWire[] = []
  for (const id of headerEntities(pool).orders.get('repository') ?? []) {
    const row = omitGone(pool.row('repository', id))
    if (row && typeof row !== 'symbol') repos.push(row as GitRepositoryWire)
  }
  if (!local || typeof local === 'symbol') return { repos, selectedWorktree: null, paneA: null, sessions: [], loading: true }
  const session = loadedPaneSession(pool, (local.paneA ?? undefined) as SessionId | undefined)
  return { repos, selectedWorktree: local.selectedWorktree, paneA: local.paneA, sessions: session ? [session] : [], loading: false }
}
