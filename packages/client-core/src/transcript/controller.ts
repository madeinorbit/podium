import type { SessionId, TranscriptItem } from '@podium/model'
import { insertInCursorOrder } from '../viewmodels/cursor-order'

export type TranscriptFreshness = 'checking' | 'rendering' | 'saved' | null

export interface TranscriptPage {
  items: TranscriptItem[]
  head?: string
  tail?: string
  hasMore: boolean
}

export interface TranscriptReadRequest {
  sessionId: SessionId
  anchor?: string
  direction: 'before'
  limit: number
}

export interface TranscriptSource {
  read(request: TranscriptReadRequest): Promise<TranscriptPage>
  subscribe(
    sessionId: SessionId,
    since: string | undefined,
    listener: (items: TranscriptItem[], meta: { reset: boolean }) => void,
  ): () => void
}

export interface TranscriptCacheEntry {
  items: TranscriptItem[]
  savedAt: number
}

export interface TranscriptCache {
  read(sessionId: SessionId): TranscriptCacheEntry | undefined
  write(sessionId: SessionId, items: readonly TranscriptItem[]): void
}

export interface TranscriptConnection {
  connected(): boolean
  subscribe(listener: (connected: boolean) => void): () => void
}

export interface TranscriptControllerOptions {
  sessionId: SessionId
  source: TranscriptSource
  cache?: TranscriptCache
  connection?: TranscriptConnection
  initialLimit?: number
  pageLimit?: number
}

export interface TranscriptState {
  sessionId: SessionId
  items: TranscriptItem[]
  head: string | undefined
  tail: string | undefined
  hasMoreOlder: boolean
  loadingOlder: boolean
  initialLoaded: boolean
  freshness: TranscriptFreshness
  offlineAsOf: number | null
}

export interface TranscriptRefreshOptions {
  disclose?: boolean
}

type Listener = () => void

export function transcriptItemKey(item: TranscriptItem): string {
  return item.cursor ?? item.id
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => key in rightRecord && sameValue(leftRecord[key], rightRecord[key]))
  )
}

export function sameTranscriptItem(left: TranscriptItem, right: TranscriptItem): boolean {
  return sameValue(left, right)
}

export function sameTranscriptItems(
  left: readonly TranscriptItem[],
  right: readonly TranscriptItem[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every(
        (item, index) =>
          transcriptItemKey(item) === transcriptItemKey(right[index] as TranscriptItem) &&
          sameTranscriptItem(item, right[index] as TranscriptItem),
      ))
  )
}

/**
 * Merge a live frame into a held window. A repeated cursor replaces its earlier
 * value in place, because tailers may first emit an unterminated record and then
 * emit its complete value at the same cursor.
 */
export function mergeTranscriptFrame(
  held: readonly TranscriptItem[],
  frame: readonly TranscriptItem[],
): TranscriptItem[] {
  if (frame.length === 0) return held as TranscriptItem[]
  const positions = new Map<string, number>()
  held.forEach((item, index) => positions.set(transcriptItemKey(item), index))
  let next: TranscriptItem[] | null = null
  const additions: TranscriptItem[] = []

  for (const item of frame) {
    const key = transcriptItemKey(item)
    const position = positions.get(key)
    if (position === -1) continue
    if (position !== undefined) {
      const current = (next ?? held)[position]
      if (current && !sameTranscriptItem(current, item)) {
        next ??= [...held]
        next[position] = item
      }
      continue
    }
    positions.set(key, -1)
    additions.push(item)
  }

  if (!next && additions.length === 0) return held as TranscriptItem[]
  const merged = next ?? [...held]
  for (const item of additions) insertInCursorOrder(merged, item)
  return merged
}

/** Reconcile a newest-window read without dropping a live item beyond its tail. */
export function reconcileTranscriptSnapshot(
  held: readonly TranscriptItem[],
  snapshot: readonly TranscriptItem[],
  snapshotTail: string | undefined,
): TranscriptItem[] {
  if (snapshot.length === 0) return held as TranscriptItem[]
  const tailIndex =
    snapshotTail === undefined
      ? -1
      : held.findIndex((item) => transcriptItemKey(item) === snapshotTail)
  if (tailIndex < 0) return snapshot as TranscriptItem[]
  const newerHeld = held.slice(tailIndex + 1)
  return newerHeld.length === 0
    ? (snapshot as TranscriptItem[])
    : mergeTranscriptFrame(snapshot, newerHeld)
}

/** Keep only the genuinely older part of an anchored page. */
export function freshOlderTranscriptPage(
  page: readonly TranscriptItem[],
  held: readonly TranscriptItem[],
): TranscriptItem[] {
  if (page.length === 0) return page as TranscriptItem[]
  const heldKeys = new Set(held.map(transcriptItemKey))
  return page.filter((item) => !heldKeys.has(transcriptItemKey(item)))
}

export class TranscriptController {
  private readonly listeners = new Set<Listener>()
  private readonly initialLimit: number
  private readonly pageLimit: number
  private state: TranscriptState
  private started = false
  private disposed = false
  private generation = 0
  private readSerial = 0
  private windowEpoch = 0
  private unsubscribeTranscript: (() => void) | null = null
  private unsubscribeConnection: (() => void) | null = null
  private lastConnected: boolean | null = null

  constructor(private readonly options: TranscriptControllerOptions) {
    this.initialLimit = options.initialLimit ?? 200
    this.pageLimit = options.pageLimit ?? 400
    this.state = {
      sessionId: options.sessionId,
      items: [],
      head: undefined,
      tail: undefined,
      hasMoreOlder: true,
      loadingOlder: false,
      initialLoaded: false,
      freshness: null,
      offlineAsOf: null,
    }
  }

  getSnapshot = (): TranscriptState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    const cached = this.options.cache?.read(this.options.sessionId)
    if (cached && cached.items.length > 0) {
      this.patch({ items: cached.items, freshness: 'checking' })
    }
    const connection = this.options.connection
    if (connection) {
      this.lastConnected = connection.connected()
      this.unsubscribeConnection = connection.subscribe((connected) => {
        const reconnected = connected && this.lastConnected === false
        this.lastConnected = connected
        if (reconnected) void this.refresh({ disclose: true }).catch(() => {})
      })
    }
    const generation = this.generation
    const initialRefresh = this.refresh()
    const serial = this.readSerial
    try {
      await initialRefresh
    } catch {
      if (!this.accepts(generation, serial)) return
      const fallback = this.options.cache?.read(this.options.sessionId)
      this.patch({
        ...(this.state.items.length === 0 && fallback ? { items: fallback.items } : {}),
        hasMoreOlder: false,
        initialLoaded: true,
        freshness: this.state.items.length > 0 || fallback ? 'saved' : null,
        offlineAsOf: fallback?.savedAt ?? null,
      })
      this.attachSubscription(undefined)
    }
  }

  async refresh(options: TranscriptRefreshOptions = {}): Promise<boolean> {
    if (this.disposed) return false
    const generation = this.generation
    const serial = ++this.readSerial
    if (options.disclose && this.state.items.length > 0) this.patch({ freshness: 'checking' })
    try {
      const page = await this.options.source.read({
        sessionId: this.options.sessionId,
        direction: 'before',
        limit: this.initialLimit,
      })
      if (!this.accepts(generation, serial)) return false
      this.windowEpoch += 1
      const reconciled = reconcileTranscriptSnapshot(this.state.items, page.items, page.tail)
      const items = sameTranscriptItems(this.state.items, reconciled)
        ? this.state.items
        : reconciled
      this.patch({
        items,
        head: page.head,
        tail: page.tail,
        hasMoreOlder: page.hasMore,
        loadingOlder: false,
        initialLoaded: true,
        freshness:
          this.state.freshness === null ? null : page.items.length > 0 ? 'rendering' : 'saved',
        offlineAsOf: null,
      })
      if (items.length > 0) this.options.cache?.write(this.options.sessionId, items)
      this.attachSubscription(page.tail)
      return true
    } catch (error) {
      if (this.accepts(generation, serial) && this.state.items.length > 0) {
        this.patch({ freshness: 'saved' })
      }
      throw error
    }
  }

  async probe(options: TranscriptRefreshOptions = {}): Promise<boolean> {
    if (this.disposed) return false
    const generation = this.generation
    const serial = ++this.readSerial
    if (options.disclose && this.state.items.length > 0) this.patch({ freshness: 'checking' })
    let page: TranscriptPage
    try {
      page = await this.options.source.read({
        sessionId: this.options.sessionId,
        direction: 'before',
        limit: 1,
      })
    } catch (error) {
      if (this.accepts(generation, serial) && this.state.items.length > 0) {
        this.patch({ freshness: 'saved' })
      }
      throw error
    }
    if (!this.accepts(generation, serial)) return false
    const remote = page.items.at(-1)
    if (!remote) {
      if (this.state.items.length > 0) this.patch({ freshness: 'saved' })
      return true
    }
    const held = this.state.items.find(
      (item) => transcriptItemKey(item) === transcriptItemKey(remote),
    )
    if (held && sameTranscriptItem(held, remote)) {
      if (this.state.freshness !== null) this.patch({ freshness: null })
      return true
    }
    return this.refresh({ disclose: true })
  }

  async loadOlder(): Promise<boolean> {
    if (
      this.disposed ||
      this.state.loadingOlder ||
      !this.state.hasMoreOlder ||
      this.state.head === undefined
    ) {
      return false
    }
    const generation = this.generation
    const epoch = this.windowEpoch
    const anchor = this.state.head
    this.patch({ loadingOlder: true })
    try {
      const page = await this.options.source.read({
        sessionId: this.options.sessionId,
        anchor,
        direction: 'before',
        limit: this.pageLimit,
      })
      if (this.disposed || generation !== this.generation || epoch !== this.windowEpoch)
        return false
      const fresh = freshOlderTranscriptPage(page.items, this.state.items)
      const items = fresh.length > 0 ? [...fresh, ...this.state.items] : this.state.items
      const head = fresh[0]?.cursor ?? page.head ?? anchor
      this.patch({
        items,
        head,
        hasMoreOlder: page.items.length > 0 && fresh.length === 0 ? false : page.hasMore,
      })
      return fresh.length > 0
    } finally {
      if (!this.disposed && generation === this.generation) this.patch({ loadingOlder: false })
    }
  }

  markRendered(): void {
    if (this.state.freshness === 'rendering') this.patch({ freshness: null })
  }

  /** Release live resources while keeping the controller restartable by an adapter effect. */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.generation += 1
    this.readSerial += 1
    this.unsubscribeTranscript?.()
    this.unsubscribeConnection?.()
    this.unsubscribeTranscript = null
    this.unsubscribeConnection = null
  }

  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    this.listeners.clear()
  }

  private accepts(generation: number, serial: number): boolean {
    return !this.disposed && generation === this.generation && serial === this.readSerial
  }

  private attachSubscription(since: string | undefined): void {
    if (this.disposed) return
    // A refresh reconciles the held window but does not replace an intact live
    // stream. Keeping one subscription avoids duplicate listeners on warm
    // activation; stop/reset ownership still invalidates reads independently.
    if (this.unsubscribeTranscript) return
    this.unsubscribeTranscript = this.options.source.subscribe(
      this.options.sessionId,
      since,
      (frame, meta) => {
        if (this.disposed) return
        if (meta.reset) {
          this.windowEpoch += 1
          void this.refresh({ disclose: true }).catch(() => {})
          return
        }
        const items = mergeTranscriptFrame(this.state.items, frame)
        if (items === this.state.items) return
        const tail = items.at(-1)?.cursor ?? this.state.tail
        this.patch({
          items,
          ...(tail === undefined ? {} : { tail }),
          freshness: this.state.freshness === null ? null : 'rendering',
        })
        this.options.cache?.write(this.options.sessionId, items)
      },
    )
  }

  private patch(patch: Partial<TranscriptState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}

export function createTranscriptController(
  options: TranscriptControllerOptions,
): TranscriptController {
  return new TranscriptController(options)
}
