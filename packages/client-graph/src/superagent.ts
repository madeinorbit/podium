import type { ReadPositionValue } from '@podium/client-core'
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import type { SuperagentSliceValue, SuperThreadView } from '@podium/client-core/values'
import type { GitRepositoryWire, IssueEventWire, SessionId } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import { observable as observableValue } from 'mobx'
import { headerEntities } from './header-entities'
import { omitGone } from './lookup'
import type { MobxPool, PoolRows } from './pool'
import { loadedPaneSession } from './session-pane'
import type { PoolSource } from './source-registry'
import type { Loaded } from './worklist/rollup'

/** The cursor port is already principal-scoped by the one runtime. This
 * attachment borrows it; it has no RPC, cache or write owner. My threads are
 * not here: they are synced `superagentThread` records in the pool (POD-6675),
 * read by {@link superagentThread} and {@link superagentState}. */
export interface SuperagentRows {
  superagentLocal: Pick<Store, 'superThreadId' | 'paneA' | 'selectedWorktree'> & {
    booting: boolean
  }
  superagentEvent: IssueEventWire
  superagentEventTail: { ids: readonly string[] }
  superagentReadPosition: ReadPositionValue
}
declare module './source-registry' {
  interface PoolSourceRows extends SuperagentRows {}
}
export const SUPERAGENT_ENTITIES = [
  'superagentLocal',
  'superagentEvent',
  'superagentEventTail',
  'superagentReadPosition',
] as const
export const SUPERAGENT_SOURCE_KEY = 'superagent'
export const SUPERAGENT_EVENT_TAIL = 40
export const SUPERAGENT_SCHEMA = {
  superagentLocal: {
    key: 'local',
    source: 'engine:locals',
    fields: ['superThreadId', 'paneA', 'selectedWorktree', 'booting'],
  },
  superagentEvent: { key: 'id', source: 'replica:issueEvents', residency: 'tail members only' },
  superagentEventTail: {
    key: 'tail',
    source: 'replica:issueEvents ids (newest window)',
    order: 'eventId ascending',
    limit: SUPERAGENT_EVENT_TAIL,
  },
  superagentReadPosition: {
    key: 'issueEvents',
    source: 'runtime:readPosition (principal-scoped)',
    visibilityContext:
      'existing readPosition port: one get at the visibility edge to freeze presentation before pool attachment',
  },
  session: {
    source: 'pool:session',
    reader: 'sessionPanes.session',
    summary: ['sessionId', 'cwd', 'machineId'],
  },
  repository: { source: 'header:repository', reader: 'pool.row' },
} as const
export const SUPERAGENT_SUMMARIES = { session: SUPERAGENT_SCHEMA.session.summary }

type SuperagentOwner = {
  readonly ui: ClientRuntime['ui']
  readonly replica: ClientRuntime['root']['replica']
  readonly readPosition: ClientRuntime['readPosition']
}

/** MobX and the loading sentinel arrive only after the app-load switch has
 * latched ON. Initial demands coalesce; incremental events use addressed rows. */
export async function createSuperagentSource(owner: SuperagentOwner): Promise<
  PoolSource<keyof SuperagentRows> & {
    counts: {
      batches: number
      eventCollections: number
      addressedEvents: number
      questionCollections: number
    }
  }
> {
  const [{ observable, runInAction, compareStructural }, rollup] = await Promise.all([
    import('mobx'),
    import('./worklist/rollup'),
  ])
  const { defineSource } = await import('./source-registry')
  const LOADING: typeof import('./worklist/rollup').LOADING = rollup.LOADING
  const replica = owner.replica
  if (!replica.rowCount) throw new Error('Superagent requires keyed replica counts')
  if (!replica.row || !replica.subscribeAddressedBatch)
    throw new Error('Superagent requires the existing addressed replica')
  class Source {
    private readonly rows = observable.map<string, object>(undefined, { deep: false })
    private readonly loaded = observable.set<string>()
    private readonly demanded = new Set<string>()
    /** Keyed (POD-5433): what each wake moved. */
    private localDirty = true
    private bootingDirty = true
    @observableValue private accessor booting = true
    private eventsDirty = true
    /** The newest events, ascending. Only these rows are read and held; older
     * retained history is never read or sorted. */
    private window: TailEntry[] = []
    private readonly source = defineSource({
      readById: this.readById.bind(this),
      refresh: this.refresh.bind(this),
      release: this.release.bind(this),
    })
    private get disposed(): boolean {
      return this.source.disposed
    }
    private readonly stops: (() => void)[]
    readonly counts = {
      batches: 0,
      eventCollections: 0,
      addressedEvents: 0,
      questionCollections: 0,
    }

    constructor() {
      const local = () => {
        this.localDirty = true
        if (this.demanded.has('threads')) this.schedule()
      }
      const boot = () => {
        this.bootingDirty = true
        if (this.demanded.has('threads')) this.schedule()
      }
      // A cold cursor with rows present: only a removal can make it boot again.
      const removed = (rows: readonly { kind: string; id: string }[]) =>
        rows.some(
          (address) =>
            (address.kind === 'sessions' || address.kind === 'issueProjections') &&
            !replica.row?.(address.kind, address.id),
        )
      this.stops = [
        owner.readPosition.subscribe(() => {
          if (this.demanded.has('position')) this.schedule()
        }),
        // `booting` can move only while it holds, or when the cursor is cold.
        ...(replica.subscribeCursor
          ? [
              replica.subscribeCursor(() => {
                if (this.booting || replica.getCursor() === null) boot()
              }),
            ]
          : []),
        replica.subscribeAddressedBatch!((batch) => {
          if (this.disposed) return
          if (batch.type === 'replace') {
            this.eventsDirty = true
            this.localDirty = true
            this.bootingDirty = true
            if (this.demanded.size) this.schedule()
            return
          }
          if (this.booting || (replica.getCursor() === null && removed(batch.rows))) boot()
          runInAction(() => {
            let events = false,
              refill = false
            for (const address of batch.rows) {
              if (address.kind === 'issueEvents' && this.loaded.has('events')) {
                refill = this.event(address.id, replica.row!('issueEvents', address.id)) || refill
                this.counts.addressedEvents++
                events = true
              }
            }
            if (refill) this.collect(false)
            else if (events) this.tail()
          })
        }),
      ]
    }

    read(entity: keyof SuperagentRows, id: string): Loaded<SuperagentRows[keyof SuperagentRows]> {
      return this.source.read(entity, id) as Loaded<SuperagentRows[keyof SuperagentRows]>
    }

    private readById(
      entity: keyof SuperagentRows,
      id: string,
    ): Loaded<SuperagentRows[keyof SuperagentRows]> {
      if (entity === 'superagentLocal') {
        const source = this
        this.demanded.add('threads')
        if (!this.loaded.has('threads')) this.schedule()
        return {
          get superThreadId() {
            return owner.ui.superThreadId
          },
          get paneA() {
            return owner.ui.paneA
          },
          get selectedWorktree() {
            return owner.ui.selectedWorktree
          },
          get booting() {
            return source.booting
          },
        }
      }
      const group = entity.startsWith('superagentEvent')
        ? 'events'
        : entity === 'superagentReadPosition'
          ? 'position'
          : 'threads'
      this.demanded.add(group)
      if (!this.loaded.has(group)) {
        this.schedule()
        return LOADING
      }
      return this.rows.get(`${entity}:${id}`) as SuperagentRows[keyof SuperagentRows] | undefined
    }

    private set(key: string, value: object) {
      if (!compareStructural(this.rows.get(key), value)) this.rows.set(key, value)
    }

    private tail() {
      this.set('superagentEventTail:tail', { ids: this.window.map((entry) => entry.id) })
    }

    /** Choose the window from keyed membership, then read only its new rows. */
    private collect(reread: boolean) {
      const next = newestEvents(
        replica.ids?.('issueEvents') ?? replica.rows('issueEvents').map((row) => row.id),
        (id) => replica.row!('issueEvents', id)?.eventId,
      )
      const keep = new Set(next.map((entry) => entry.id))
      for (const key of [...this.rows.keys()]) {
        if (key.startsWith('superagentEvent:') && (reread || !keep.has(key.slice(16))))
          this.rows.delete(key)
      }
      this.window = []
      for (const entry of next) {
        if (this.rows.has(`superagentEvent:${entry.id}`)) {
          this.window.push(entry)
          continue
        }
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
      const index = this.window.findIndex((entry) => entry.id === id)
      if (index >= 0) {
        const full = this.window.length === SUPERAGENT_EVENT_TAIL
        this.window.splice(index, 1)
        if (!row) {
          this.rows.delete(`superagentEvent:${id}`)
          return full
        }
      }
      if (!row) return false
      const entry = { id, eventId: row.eventId }
      if (this.window.length === SUPERAGENT_EVENT_TAIL && compareTail(entry, this.window[0]!) < 0) {
        this.rows.delete(`superagentEvent:${id}`)
        return false
      }
      insertTail(this.window, entry)
      this.set(`superagentEvent:${id}`, row)
      if (this.window.length > SUPERAGENT_EVENT_TAIL)
        this.rows.delete(`superagentEvent:${this.window.shift()!.id}`)
      return false
    }

    private schedule(): void {
      this.source.schedule()
    }

    private refresh(): void {
      runInAction(() => {
        if (this.demanded.has('threads')) {
          const before = this.booting
          if (this.bootingDirty) {
            this.bootingDirty = false
            this.booting =
              replica.getCursor() === null &&
              replica.rowCount!('sessions') === 0 &&
              replica.rowCount!('issueProjections') === 0
          }
          if (this.localDirty || this.booting !== before) {
            this.localDirty = false
          }
          this.loaded.add('threads')
        }
        if (this.demanded.has('events') && this.eventsDirty) {
          this.collect(true)
          this.eventsDirty = false
          this.loaded.add('events')
          this.counts.eventCollections++
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
      this.demanded.clear()
      queueMicrotask(() =>
        runInAction(() => {
          this.rows.clear()
          this.loaded.clear()
          this.window = []
        }),
      )
    }
  }
  return new Source()
}

interface TailEntry {
  readonly id: string
  readonly eventId: number
}
const compareTail = (a: TailEntry, b: TailEntry): number =>
  a.eventId - b.eventId || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
function insertTail(window: TailEntry[], entry: TailEntry): void {
  let low = 0,
    high = window.length
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
  const end = id.indexOf('\n'),
    head = end < 0 ? '' : id.slice(0, end)
  return /^[1-9]\d*$/.test(head) ? Number(head) : read(id)
}
/** Bounded selection: at most SUPERAGENT_EVENT_TAIL entries are ever ordered. */
export function newestEvents(
  ids: Iterable<string>,
  read: (id: string) => number | undefined,
): TailEntry[] {
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

/** One of my threads as the superagent screens render it (POD-6675): the pool's
 * `superagentThread` record, named by its thread id. */
function threadView(row: PoolRows['superagentThread']): SuperThreadView {
  return {
    id: row.threadId,
    kind: row.kind,
    archived: row.archived,
    resumable: row.resumable,
    turnRunning: row.turnRunning,
    lastTurnFailure: row.lastTurnFailure,
    ...(row.originSessionId ? { originSessionId: row.originSessionId } : {}),
    ...(row.title !== undefined ? { title: row.title } : {}),
    ...(row.repoPath !== undefined ? { repoPath: row.repoPath } : {}),
    ...(row.podiumSessionId ? { podiumSessionId: row.podiumSessionId } : {}),
    ...(row.agentKind !== undefined ? { agentKind: row.agentKind } : {}),
    ...(row.model !== undefined ? { model: row.model } : {}),
    ...(row.effort !== undefined ? { effort: row.effort } : {}),
  }
}
/** My open threads, most recently written first (the order `listThreads` had).
 * Every row in the table is mine: the feed delivers a thread to its owner only.
 * Reading it in a reaction tracks the table, so a thread made or renamed on my
 * other device moves it. */
function myRows(pool: Pick<MobxPool, 'tables'>): PoolRows['superagentThread'][] {
  const rows: PoolRows['superagentThread'][] = []
  // A pool without the table (a screen's stand-in in a test) holds no threads.
  for (const value of pool.tables.superagentThread?.values() ?? []) {
    const row = value as PoolRows['superagentThread']
    if (!row.archived) rows.push(row)
  }
  return rows.sort((a, b) =>
    a.updatedAt === b.updatedAt
      ? a.threadId < b.threadId
        ? -1
        : 1
      : a.updatedAt < b.updatedAt
        ? 1
        : -1,
  )
}
function myThreads(pool: Pick<MobxPool, 'tables'>): SuperThreadView[] {
  return myRows(pool).map(threadView)
}
/** The thread a superagent command addresses as `id`. `global` is my global
 * thread under the server's own rule (`personalThreadId`): the bare `global`
 * row when it is mine, else `global:<me>`; never another `global`-kind row an
 * old install left behind. */
function named(
  rows: readonly PoolRows['superagentThread'][],
  id: string,
): SuperThreadView | undefined {
  if (id !== 'global') {
    const row = rows.find((row) => row.threadId === id)
    return row && threadView(row)
  }
  const bare = rows.find((row) => row.kind === 'global' && row.threadId === 'global')
  const own =
    bare ??
    rows.find((row) => row.kind === 'global' && row.threadId === `global:${row.ownerUserId}`)
  return own && threadView(own)
}
/** The replica has not bootstrapped yet: no thread can be known missing. */
function threadsBooting(pool: MobxPool): boolean {
  const local = omitGone(pool.row('superagentLocal', 'local'))
  return !local || typeof local === 'symbol' || local.booting
}

// Dependency-free readers: importing the OFF screen builds no graph or MobX.
const pending = (row: unknown): boolean => typeof row === 'symbol'
export function superagentThread(pool: MobxPool, id: string) {
  const thread = named(myRows(pool), id)
  return { thread, loading: thread === undefined && threadsBooting(pool) }
}
export function superagentState(
  pool: MobxPool,
): SuperagentSliceValue & { loading: boolean; booting: boolean } {
  const local = omitGone(pool.row('superagentLocal', 'local'))
  const rows = myRows(pool)
  const threads = rows.map(threadView)
  const loading = pending(local)
  const active =
    local && typeof local !== 'symbol' ? named(rows, local.superThreadId ?? 'global') : undefined
  return {
    threads,
    active,
    activeSessionId: active?.podiumSessionId,
    loading,
    booting: !local || typeof local === 'symbol' || local.booting,
  }
}
export function superagentFeed(pool: MobxPool) {
  const tail = omitGone(pool.row('superagentEventTail', 'tail'))
  const events: {
    id: number
    ts: string
    kind: string
    subject: string
    repoPath: string | null
    payload: unknown
  }[] = []
  let loading = pending(tail)
  if (tail && typeof tail !== 'symbol')
    for (const id of tail.ids) {
      const row = omitGone(pool.row('superagentEvent', id))
      if (typeof row === 'symbol') loading = true
      else if (row)
        events.push({
          id: row.eventId,
          ts: row.ts,
          kind: row.kind,
          subject: row.subject,
          repoPath: row.repoPath,
          payload: row.payload,
        })
    }
  return { events, loading }
}
export function superagentCursor(pool: MobxPool) {
  const row = omitGone(pool.row('superagentReadPosition', 'issueEvents'))
  return {
    cursor: !row || typeof row === 'symbol' ? { lastEventId: 0, seenAt: null } : row,
    loading: pending(row),
  }
}
export function superagentQuestion(pool: MobxPool, sessionId: SessionId | undefined) {
  if (!sessionId) return { question: undefined, loading: false }
  const membership = omitGone(pool.row('noticeSession', sessionId))
  let loading = pending(membership)
  if (membership && typeof membership !== 'symbol')
    for (const id of membership.interactions) {
      const row = omitGone(pool.row('pendingInteraction', id))
      if (typeof row === 'symbol') {
        loading = true
        continue
      }
      if (row?.sessionId === sessionId && row.kind === 'question' && row.status === 'asked')
        return { question: row, loading }
    }
  return {
    question: undefined as Extract<PendingInteractionWire, { kind: 'question' }> | undefined,
    loading,
  }
}
export function superagentFocus(pool: MobxPool) {
  const local = omitGone(pool.row('superagentLocal', 'local'))
  const repos: GitRepositoryWire[] = []
  for (const id of headerEntities(pool).orders.get('repository') ?? []) {
    const row = omitGone(pool.row('repository', id))
    if (row && typeof row !== 'symbol') repos.push(row as GitRepositoryWire)
  }
  if (!local || typeof local === 'symbol')
    return { repos, selectedWorktree: null, paneA: null, sessions: [], loading: true }
  const session = loadedPaneSession(pool, (local.paneA ?? undefined) as SessionId | undefined)
  return {
    repos,
    selectedWorktree: local.selectedWorktree,
    paneA: local.paneA,
    sessions: session ? [session] : [],
    loading: false,
  }
}
