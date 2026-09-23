import type { SessionId, TranscriptItem } from '@podium/model'
import { insertInCursorOrder } from '../viewmodels/cursor-order'

export type TranscriptFreshness = 'checking' | 'rendering' | 'saved' | null

export interface TranscriptPage {
  reset?: boolean
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
  /** Whether the reader can see the transcript now. The live heartbeat skips
   *  a tick nobody would see; absent means always visible. */
  visible?: () => boolean
}

/**
 * What the session row says about activity the transcript should be recording
 * — see {@link TranscriptController.observeActivity}.
 */
export interface TranscriptActivity {
  /** A fingerprint of the row fields that move when the agent does anything;
   *  {@link transcriptActivitySignal} is the one every host uses. */
  signal: string
  /** The session has a process that can append to the transcript. */
  live: boolean
}

/** Trailing settle before a moved row re-reads: a working agent moves the row
 *  several times a second, and the point is to be current, not to re-read on
 *  every tick. */
export const TRANSCRIPT_ACTIVITY_SETTLE_MS = 400
/** The floor under a live transcript: one newest-item probe, escalating to a
 *  full reconcile only when the tail differs [POD-701]. */
export const TRANSCRIPT_LIVE_HEARTBEAT_MS = 6_000

/** The row fields that advance on exactly the activity a transcript records. */
export function transcriptActivitySignal(session: {
  lastActiveAt?: string | null
  busy?: boolean | null
  agentState?: { phase?: string; since?: string } | null
}): string {
  return `${session.lastActiveAt ?? ''}|${session.agentState?.phase ?? ''}|${session.agentState?.since ?? ''}|${session.busy ?? ''}`
}

export interface TranscriptState {
  sessionId: SessionId
  items: TranscriptItem[]
  head: string | undefined
  tail: string | undefined
  hasMoreOlder: boolean
  loadingOlder: boolean
  initialLoaded: boolean
  /** A non-empty authority read established the current stream, and no reset has broken it. */
  subscriptionHealthy: boolean
  freshness: TranscriptFreshness
  offlineAsOf: number | null
}

export interface TranscriptRefreshOptions {
  disclose?: boolean
}

type Listener = () => void

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
          item.id === right[index]?.id && sameTranscriptItem(item, right[index] as TranscriptItem),
      ))
  )
}

/**
 * Merge by stable item id, replacing growing content in place. Cursors are
 * position anchors only: they order unseen items and never identify a row.
 * An identical frame preserves the held array to avoid re-rendering.
 */
export function mergeTranscriptFrame(
  held: readonly TranscriptItem[],
  frame: readonly TranscriptItem[],
): TranscriptItem[] {
  if (frame.length === 0) return held as TranscriptItem[]
  const positions = new Map<string, number>()
  held.forEach((item, index) => {
    positions.set(item.id, index)
  })
  let next: TranscriptItem[] | null = null
  const additions = new Map<string, TranscriptItem>()

  for (const item of frame) {
    const key = item.id
    const position = positions.get(key)
    if (position !== undefined) {
      const current = (next ?? held)[position]
      if (current && !sameTranscriptItem(current, item)) {
        next ??= [...held]
        next[position] = item
      }
      continue
    }
    additions.set(key, item)
  }

  if (!next && additions.size === 0) return held as TranscriptItem[]
  const merged = next ?? [...held]
  for (const item of additions.values()) insertInCursorOrder(merged, item)
  return merged
}

/**
 * Reconcile a newest-window read without dropping live items beyond its tail.
 * Resolve the paging cursor inside the snapshot, then match that item's id in
 * the held window. A changed cursor must not make the same row a replacement
 * conversation. An empty read preserves the window; an unknown tail replaces it.
 */
export function reconcileTranscriptSnapshot(
  held: readonly TranscriptItem[],
  snapshot: readonly TranscriptItem[],
  snapshotTail: string | undefined,
): TranscriptItem[] {
  if (snapshot.length === 0) return held as TranscriptItem[]
  const tail =
    snapshotTail === undefined
      ? snapshot.at(-1)
      : snapshot.find((item) => item.cursor === snapshotTail)
  const tailIndex = tail === undefined ? -1 : held.findIndex((item) => item.id === tail.id)
  const unique = dedupeTranscriptItems(snapshot)
  if (tailIndex < 0) return unique
  const newerHeld = held.slice(tailIndex + 1)
  return newerHeld.length === 0 ? unique : mergeTranscriptFrame(unique, newerHeld)
}

/** First occurrence wins, preserving page order. Identity is always item.id. */
export function dedupeTranscriptItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  const seen = new Set<string>()
  const unique = items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  return unique.length === items.length ? (items as TranscriptItem[]) : unique
}

/** Exclude held ids and repeats within the older page; held live content wins. */
export function freshOlderTranscriptPage(
  page: readonly TranscriptItem[],
  held: readonly TranscriptItem[],
): TranscriptItem[] {
  if (page.length === 0) return page as TranscriptItem[]
  const seen = new Set(held.map((item) => item.id))
  return page.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

/** Prepend an older page without replacing more recent held content. */
export function prependTranscriptItems(
  prev: TranscriptItem[],
  older: TranscriptItem[],
): TranscriptItem[] {
  const fresh = freshOlderTranscriptPage(older, prev)
  return fresh.length === 0 ? prev : [...fresh, ...prev]
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
  private activity: TranscriptActivity | null = null
  /** The row signal as of the last read that made this window current. */
  private reconciledSignal: string | null = null
  /** Older pages are loaded; a newest-window read would drop them. */
  private pagedBack = false
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private probing: Promise<boolean> | null = null

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
      subscriptionHealthy: false,
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
    this.syncHeartbeat()
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
        subscriptionHealthy: false,
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
    // Stamped as of the read's START: activity that lands while it is in
    // flight may not be in it, and must still earn its own reconcile. A read
    // that began before any row was observed (a host that starts the
    // controller first) takes the row as of its completion instead, rather
    // than paying a second read on every mount.
    const signal = this.activity?.signal
    if (options.disclose && this.state.items.length > 0) this.patch({ freshness: 'checking' })
    try {
      const page = await this.options.source.read({
        sessionId: this.options.sessionId,
        direction: 'before',
        limit: this.initialLimit,
      })
      if (!this.accepts(generation, serial)) return false
      this.windowEpoch += 1
      this.reconciledSignal = signal ?? this.activity?.signal ?? null
      this.pagedBack = false
      const reconciled = page.reset
        ? mergeTranscriptFrame([], page.items)
        : reconcileTranscriptSnapshot(this.state.items, page.items, page.items.at(-1)?.cursor)
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
        subscriptionHealthy: page.items.length > 0,
        freshness:
          this.state.freshness === null ? null : page.items.length > 0 ? 'rendering' : 'saved',
        offlineAsOf: null,
      })
      if (items.length > 0) this.options.cache?.write(this.options.sessionId, items)
      this.attachSubscription(page.items.at(-1)?.cursor)
      this.scheduleSettle()
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
    const held = this.state.items.find((item) => item.id === remote.id)
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
      if (page.reset) {
        this.windowEpoch += 1
        this.pagedBack = true
        const items = mergeTranscriptFrame([], page.items)
        this.patch({ items, head: page.head, tail: page.tail, hasMoreOlder: page.hasMore })
        this.options.cache?.write(this.options.sessionId, items)
        return true
      }
      const fresh = freshOlderTranscriptPage(page.items, this.state.items)
      if (fresh.length > 0) this.pagedBack = true
      const items = fresh.length > 0 ? [...fresh, ...this.state.items] : this.state.items
      const head = page.head ?? fresh[0]?.cursor ?? anchor
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
    this.clearSettle()
    this.syncHeartbeat()
  }

  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    this.listeners.clear()
  }

  /**
   * THE FEED MUST NOT GO QUIET [POD-701, POD-4643].
   *
   * The live stream is lossy by contract: a frame dropped on a reconnect, a
   * tailer that re-seeded without announcing it, or a server that never
   * forwarded an item (the acceptance run's gate rejected grok's final answer
   * after a daemon restart) leaves the window showing nothing new while the
   * session row visibly moves. The desktop chat has always reconciled against
   * the row and a heartbeat; the phone relied on the stream alone and sat on
   * "waiting its turn" until a reload. Both read through here now.
   *
   *   the ROW       when `signal` moves and settles, re-read the newest window.
   *   a HEARTBEAT   while `live`, probe the newest item every few seconds, for
   *                 activity that moves nothing on the row (a row stuck on
   *                 Working is exactly that).
   *
   * Both reconcile rather than replace, so a read that finds nothing new costs
   * one query and no render. Both stand down while older pages are loaded: a
   * newest-window read drops them, and someone reading history is not watching
   * the tail. Call on every row change; an unchanged signal costs nothing.
   */
  observeActivity(activity: TranscriptActivity): void {
    this.activity = activity
    this.syncHeartbeat()
    this.scheduleSettle()
  }

  private scheduleSettle(): void {
    const signal = this.activity?.signal
    if (
      signal === undefined ||
      !this.started ||
      this.disposed ||
      !this.state.initialLoaded ||
      this.pagedBack ||
      signal === this.reconciledSignal
    ) {
      this.clearSettle()
      return
    }
    this.clearSettle()
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      if (this.pagedBack || this.activity?.signal === this.reconciledSignal) return
      void this.refresh().catch(() => {})
    }, TRANSCRIPT_ACTIVITY_SETTLE_MS)
  }

  private clearSettle(): void {
    if (this.settleTimer === null) return
    clearTimeout(this.settleTimer)
    this.settleTimer = null
  }

  private syncHeartbeat(): void {
    const wanted = this.started && !this.disposed && this.activity?.live === true
    if (wanted && this.heartbeat === null) {
      this.heartbeat = setInterval(() => this.beat(), TRANSCRIPT_LIVE_HEARTBEAT_MS)
    } else if (!wanted && this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  private beat(): void {
    if (!this.state.initialLoaded || this.pagedBack || this.probing) return
    if (this.options.visible && !this.options.visible()) return
    const probing = this.probe().catch(() => false)
    this.probing = probing
    void probing.finally(() => {
      if (this.probing === probing) this.probing = null
    })
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
          // A reset is authoritative even when the replacement is empty and
          // the follow-up paging read fails. It must remove held/cache rows now.
          const items = mergeTranscriptFrame([], frame)
          this.patch({
            items, head: undefined, tail: items.at(-1)?.cursor,
            hasMoreOlder: false, loadingOlder: false, subscriptionHealthy: false,
          })
          this.options.cache?.write(this.options.sessionId, items)
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
