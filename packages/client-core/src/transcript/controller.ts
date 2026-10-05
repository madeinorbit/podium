import type { SessionId, TranscriptItem } from '@podium/model'
import { isAskUserQuestion } from '../values/ask-question'
import { cursorInsertionIndex } from '../values/cursor-order'

export type TranscriptFreshness = 'checking' | 'rendering' | 'saved' | null

export interface TranscriptPage {
  reset?: boolean
  items: TranscriptItem[]
  head?: string
  tail?: string
  hasMore: boolean
  /** The session's machine is offline; this page is the best the server could
   *  do without it (POD-4808). Present even when items are present (mirrored
   *  history) so a live-looking session still names its machine, and present
   *  on an empty page so it does not read as "done". */
  offline?: { machineName: string }
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
  /** Keep the loaded prefix during newest reads while a host is reading history.
   * An explicit source reset always replaces the transcript. */
  retainHistory?: () => boolean
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
  latestOperatorPrompt: string | null
  pendingQuestion: TranscriptItem | null
  latestRecordedAt: number | null
  head: string | undefined
  tail: string | undefined
  hasMoreOlder: boolean
  loadingOlder: boolean
  initialLoaded: boolean
  /** A non-empty authority read established the current stream, and no reset has broken it. */
  subscriptionHealthy: boolean
  freshness: TranscriptFreshness
  offlineAsOf: number | null
  /** The session's machine is offline as of the last authority read (POD-4808).
   *  Null when the machine is online. Distinct from offlineAsOf, which is the
   *  CLIENT's own replica fallback when the server is unreachable. */
  offlineMachineName: string | null
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
  const positions = new Map<string, number>()
  held.forEach((item, index) => {
    positions.set(item.id, index)
  })
  return mergeIndexedTranscriptFrame(held, frame, positions)
}

/** The controller keeps this index across deltas; authority reads rebuild it. */
function mergeIndexedTranscriptFrame(
  held: readonly TranscriptItem[],
  frame: readonly TranscriptItem[],
  positions: Map<string, number>,
): TranscriptItem[] {
  if (frame.length === 0) return held as TranscriptItem[]
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
  for (const item of additions.values()) {
    const insertion = cursorInsertionIndex(merged, item)
    if (insertion < 0) {
      positions.set(item.id, merged.length)
      merged.push(item)
    } else {
      merged.splice(insertion, 0, item)
      for (let index = insertion; index < merged.length; index++) {
        const entry = merged[index]
        if (entry) positions.set(entry.id, index)
      }
    }
  }
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

/** IDs only, ordered by a maintained source fact. */
class LatestTranscriptId {
  private readonly ids: string[] = []
  private readonly locations = new Map<string, number>()
  constructor(private readonly position: (id: string) => number) {}
  clear(): void {
    this.ids.length = 0
    this.locations.clear()
  }
  latest(): string | undefined {
    return this.ids[0]
  }
  private newer(a: number, b: number): boolean {
    return this.position(this.ids[a]!) > this.position(this.ids[b]!)
  }
  private swap(a: number, b: number): void {
    const first = this.ids[a]!,
      second = this.ids[b]!
    this.ids[a] = second
    this.ids[b] = first
    this.locations.set(first, b)
    this.locations.set(second, a)
  }
  private repair(at: number): void {
    while (at > 0) {
      const parent = (at - 1) >>> 1
      if (!this.newer(at, parent)) break
      this.swap(at, parent)
      at = parent
    }
    for (;;) {
      const left = at * 2 + 1,
        right = left + 1
      let next = at
      if (left < this.ids.length && this.newer(left, next)) next = left
      if (right < this.ids.length && this.newer(right, next)) next = right
      if (next === at) return
      this.swap(at, next)
      at = next
    }
  }
  set(id: string, present: boolean): void {
    const location = this.locations.get(id)
    if (present) {
      if (location !== undefined) {
        this.repair(location)
        return
      }
      this.locations.set(id, this.ids.length)
      this.ids.push(id)
      this.repair(this.ids.length - 1)
      return
    }
    if (location === undefined) return
    const last = this.ids.pop()!
    this.locations.delete(id)
    if (location < this.ids.length) {
      this.ids[location] = last
      this.locations.set(last, location)
      this.repair(location)
    }
  }
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
  private indexedItems: readonly TranscriptItem[] = []
  private readonly itemPositions = new Map<string, number>()
  private readonly userPrompts = new LatestTranscriptId((id) => this.itemPositions.get(id) ?? -1)
  private readonly questions = new LatestTranscriptId((id) => this.itemPositions.get(id) ?? -1)
  private readonly recordedAt = new Map<string, number>()
  private readonly recordedItems = new LatestTranscriptId((id) => this.recordedAt.get(id) ?? -Infinity)
  private readonly userEchoes = new Map<string, { text: string; paths: string }>()
  private readonly userTexts = new Map<string, number>()
  private readonly userPaths = new Map<string, number>()

  constructor(private readonly options: TranscriptControllerOptions) {
    this.initialLimit = options.initialLimit ?? 200
    this.pageLimit = options.pageLimit ?? 400
    this.state = {
      sessionId: options.sessionId,
      items: [],
      latestOperatorPrompt: null,
      pendingQuestion: null,
      latestRecordedAt: null,
      head: undefined,
      tail: undefined,
      hasMoreOlder: true,
      loadingOlder: false,
      initialLoaded: false,
      subscriptionHealthy: false,
      freshness: null,
      offlineAsOf: null,
      offlineMachineName: null,
    }
  }

  getSnapshot = (): TranscriptState => this.state

  getItem(id: string | undefined): TranscriptItem | undefined {
    if (id === undefined) return undefined
    const position = this.itemPositions.get(id)
    return position === undefined ? undefined : this.state.items[position]
  }

  latestOperatorPrompt(): string | null {
    return this.getItem(this.userPrompts.latest())?.text ?? null
  }

  latestPendingQuestion(): TranscriptItem | null {
    const item = this.getItem(this.questions.latest())
    return item && !item.toolResult ? item : null
  }

  /** Match the existing optimistic-turn rule by text, or by ordered file paths. */
  hasUserEcho(text: string, paths: readonly string[] = []): boolean {
    return paths.length > 0
      ? this.userPaths.has(JSON.stringify(paths))
      : this.userTexts.has(text.trim())
  }

  private moveEchoCount(counts: Map<string, number>, before: string | undefined, after: string | undefined): void {
    if (before === after) return
    if (before !== undefined) {
      const count = counts.get(before) ?? 0
      if (count <= 1) counts.delete(before)
      else counts.set(before, count - 1)
    }
    if (after !== undefined) counts.set(after, (counts.get(after) ?? 0) + 1)
  }

  private fileFacts(item: TranscriptItem): void {
    this.userPrompts.set(item.id, item.role === 'user' && item.text.trim().length > 0)
    this.questions.set(item.id, isAskUserQuestion(item))
    const at = item.ts === undefined ? NaN : Date.parse(item.ts)
    if (Number.isFinite(at)) this.recordedAt.set(item.id, at)
    else this.recordedAt.delete(item.id)
    this.recordedItems.set(item.id, Number.isFinite(at))
    const previous = this.userEchoes.get(item.id)
    const next = item.role === 'user'
      ? { text: item.text.trim(), paths: JSON.stringify(item.toolPaths ?? []) }
      : undefined
    this.moveEchoCount(this.userTexts, previous?.text, next?.text)
    this.moveEchoCount(this.userPaths, previous?.paths, next?.paths)
    if (next) this.userEchoes.set(item.id, next)
    else this.userEchoes.delete(item.id)
  }

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
      const retainHistory =
        !page.reset &&
        this.state.initialLoaded &&
        this.state.items.length > 0 &&
        this.options.retainHistory?.() === true
      if (!retainHistory) this.windowEpoch += 1
      this.reconciledSignal = signal ?? this.activity?.signal ?? null
      if (!retainHistory) this.pagedBack = false
      const reconciled = page.reset
        ? mergeTranscriptFrame([], page.items)
        : retainHistory
          ? mergeTranscriptFrame(this.state.items, page.items)
          : reconcileTranscriptSnapshot(this.state.items, page.items, page.items.at(-1)?.cursor)
      const bounded = this.boundFollowingWindow(reconciled)
      const items = sameTranscriptItems(this.state.items, bounded.items)
        ? this.state.items
        : bounded.items
      this.patch({
        items,
        head: retainHistory ? (this.state.head ?? page.head) : page.head,
        tail: page.tail,
        hasMoreOlder: retainHistory ? this.state.hasMoreOlder : page.hasMore,
        loadingOlder: retainHistory ? this.state.loadingOlder : false,
        initialLoaded: true,
        subscriptionHealthy: page.items.length > 0,
        freshness:
          this.state.freshness === null ? null : page.items.length > 0 ? 'rendering' : 'saved',
        offlineAsOf: null,
        offlineMachineName: page.offline?.machineName ?? null,
        ...bounded.paging,
      })
      if (items.length > 0) this.options.cache?.write(this.options.sessionId, items)
      // Stream catch-up anchors on the newest NATIVE item cursor (POD-4300:
      // page head/tail live in history-cursor space and never match the
      // server's replay buffer). An empty page has no native cursor, so fall
      // back to the read's tail — the live edge the authority reported — or
      // the subscription joins silently and misses the read→subscribe gap.
      this.attachSubscription(page.items.at(-1)?.cursor ?? page.tail)
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
    const offlineMachineName = page.offline?.machineName ?? null
    if (offlineMachineName !== this.state.offlineMachineName) {
      this.patch({ offlineMachineName })
    }
    const remote = page.items.at(-1)
    if (!remote) {
      if (this.state.items.length > 0) this.patch({ freshness: 'saved' })
      return true
    }
    const position = this.itemPositions.get(remote.id)
    const held = position === undefined ? undefined : this.state.items[position]
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
   * one query and no render. Hosts with an explicit retention policy can keep
   * reconciling after paging: reading preserves history, following permits
   * trimming. Legacy hosts stand down while paged back. An unchanged signal
   * costs nothing.
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
      (this.pagedBack && !this.options.retainHistory) ||
      signal === this.reconciledSignal
    ) {
      this.clearSettle()
      return
    }
    this.clearSettle()
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      if (
        (this.pagedBack && !this.options.retainHistory) ||
        this.activity?.signal === this.reconciledSignal
      )
        return
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
    if (
      !this.state.initialLoaded ||
      (this.pagedBack && !this.options.retainHistory) ||
      this.probing
    )
      return
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
          const bounded = this.boundFollowingWindow(mergeTranscriptFrame([], frame))
          const items = bounded.items
          this.patch({
            items,
            head: undefined,
            tail: items.at(-1)?.cursor,
            hasMoreOlder: false,
            loadingOlder: false,
            subscriptionHealthy: false,
            ...bounded.paging,
          })
          this.options.cache?.write(this.options.sessionId, items)
          void this.refresh({ disclose: true }).catch(() => {})
          return
        }
        const merged = mergeIndexedTranscriptFrame(this.state.items, frame, this.itemPositions)
        this.indexedItems = merged
        if (merged === this.state.items) return
        for (const item of frame) this.fileFacts(item)
        const bounded = this.boundFollowingWindow(merged)
        const items = bounded.items
        const tail = items.at(-1)?.cursor ?? this.state.tail
        this.patch({
          items,
          ...(tail === undefined ? {} : { tail }),
          freshness: this.state.freshness === null ? null : 'rendering',
          ...bounded.paging,
        })
        this.options.cache?.write(this.options.sessionId, items)
      },
    )
  }

  private boundFollowingWindow(items: TranscriptItem[]): {
    items: TranscriptItem[]
    paging?: Pick<TranscriptState, 'head' | 'hasMoreOlder'>
  } {
    const retainHistory = this.options.retainHistory ? this.options.retainHistory() : this.pagedBack
    const limit = this.initialLimit * 2
    if (retainHistory || this.state.loadingOlder || items.length <= limit) return { items }
    const tail = items.slice(-limit)
    // Store readers accept the native item cursor as their opaque anchor. Keep
    // the authority's original page head until an actual trim, then page from
    // the first retained item so the omitted prefix remains recoverable.
    if (!tail[0]?.cursor) return { items }
    return { items: tail, paging: { head: tail[0].cursor, hasMoreOlder: true } }
  }

  private patch(patch: Partial<TranscriptState>): void {
    if (patch.items && patch.items !== this.indexedItems) {
      this.itemPositions.clear()
      this.userPrompts.clear()
      this.questions.clear()
      this.recordedAt.clear()
      this.recordedItems.clear()
      this.userEchoes.clear()
      this.userTexts.clear()
      this.userPaths.clear()
      patch.items.forEach((item, index) => {
        this.itemPositions.set(item.id, index)
        this.fileFacts(item)
      })
      this.indexedItems = patch.items
    }
    let facts: Pick<TranscriptState, 'latestOperatorPrompt' | 'pendingQuestion' | 'latestRecordedAt'> | undefined
    if (patch.items && patch.items !== this.state.items) {
      const userId = this.userPrompts.latest(),
        questionId = this.questions.latest()
      const userPosition = userId === undefined ? undefined : this.itemPositions.get(userId)
      const questionPosition =
        questionId === undefined ? undefined : this.itemPositions.get(questionId)
      const question = questionPosition === undefined ? undefined : patch.items[questionPosition]
      const recordedId = this.recordedItems.latest()
      facts = {
        latestOperatorPrompt:
          userPosition === undefined ? null : (patch.items[userPosition]?.text ?? null),
        pendingQuestion: question && !question.toolResult ? question : null,
        latestRecordedAt: recordedId === undefined ? null : this.recordedAt.get(recordedId) ?? null,
      }
    }
    this.state = { ...this.state, ...patch, ...facts }
    for (const listener of this.listeners) listener()
  }
}

export function createTranscriptController(
  options: TranscriptControllerOptions,
): TranscriptController {
  return new TranscriptController(options)
}
