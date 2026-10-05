import type { SessionId, TranscriptItem } from '@podium/model'
import { action, makeObservable, observable, observableRef, observableShallow } from 'mobx'
import { isAskUserQuestion } from '../values/ask-question'
import type {
  TranscriptControllerOptions,
  TranscriptFreshness,
  TranscriptPage,
  TranscriptRefreshOptions,
  TranscriptState,
  TranscriptActivity,
} from '../transcript/controller'
import {
  TRANSCRIPT_ACTIVITY_SETTLE_MS,
  TRANSCRIPT_LIVE_HEARTBEAT_MS,
} from '../transcript/controller'
import {
  LatestTranscriptId,
  mergeIndexedTranscriptFrame,
  mergeTranscriptFrame,
  reconcileTranscriptSnapshot,
  freshOlderTranscriptPage,
  sameTranscriptItem,
  sameTranscriptItems,
} from '../transcript/merge'
import { freezePlain } from './frozen'

export interface TranscriptChange {
  readonly changed: readonly TranscriptItem[]
  readonly added: readonly TranscriptItem[]
  readonly rebuild: boolean
}

export interface TranscriptLogOptions extends TranscriptControllerOptions {
  /** The conversation owns real-time scheduling; a standalone log merges immediately. */
  enqueueFrame?: (items: TranscriptItem[], meta: { reset: boolean }) => void
  onChange?: (change: TranscriptChange) => void
}

export class TranscriptLog {
  readonly ids = observable.array<string>([], { deep: false })
  readonly byId = observable.map<string, TranscriptItem>(undefined, { deep: false })
  private orderedItems: TranscriptItem[] = []
  latestOperatorPrompt: string | null = null
  pendingQuestion: TranscriptItem | null = null
  latestRecordedAt: number | null = null
  latestUserId: string | null = null
  head: string | undefined = undefined
  tail: string | undefined = undefined
  hasMoreOlder = true
  loadingOlder = false
  initialLoaded = false
  subscriptionHealthy = false
  freshness: TranscriptFreshness = null
  offlineAsOf: number | null = null
  offlineMachineName: string | null = null
  private readonly initialLimit: number
  private readonly pageLimit: number
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
  private readonly userItems = new LatestTranscriptId((id) => this.itemPositions.get(id) ?? -1)
  private readonly userPrompts = new LatestTranscriptId((id) => this.itemPositions.get(id) ?? -1)
  private readonly questions = new LatestTranscriptId((id) => this.itemPositions.get(id) ?? -1)
  private readonly recordedAt = new Map<string, number>()
  private readonly recordedItems = new LatestTranscriptId(
    (id) => this.recordedAt.get(id) ?? -Infinity,
  )
  private readonly userEchoes = new Map<string, { text: string; paths: string }>()
  private readonly userTexts = observable.map<string, number>(undefined, { deep: false })
  private readonly userPaths = observable.map<string, number>(undefined, { deep: false })
  private readonly trackEchoes: boolean
  private readonly trackRecordedTime: boolean

  constructor(private readonly options: TranscriptLogOptions) {
    this.initialLimit = options.initialLimit ?? 200
    this.pageLimit = options.pageLimit ?? 400
    this.trackEchoes = options.questions?.includes('userEcho') ?? true
    this.trackRecordedTime = options.questions?.includes('latestRecordedAt') ?? true
    makeObservable<this, 'patch'>(this, {
      ids: observableShallow,
      byId: observableShallow,
      latestOperatorPrompt: observable,
      pendingQuestion: observableRef,
      latestRecordedAt: observable,
      head: observable,
      tail: observable,
      hasMoreOlder: observable,
      loadingOlder: observable,
      initialLoaded: observable,
      subscriptionHealthy: observable,
      freshness: observable,
      offlineAsOf: observable,
      offlineMachineName: observable,
      merge: action,
      patch: action,
      markRendered: action,
    })
    // Seed before start() and before any network read or first render.
    const cached = options.cache?.read(options.sessionId)
    if (cached?.items.length) this.patch({ items: cached.items, freshness: 'checking' })
  }

  get sessionId(): SessionId {
    return this.options.sessionId
  }

  /** Materialization seam for the existing transcript worker. Rows observe byId. */
  get items(): TranscriptItem[] {
    return this.orderedItems
  }

  getItem(id: string | undefined): TranscriptItem | undefined {
    return id === undefined ? undefined : this.byId.get(id)
  }

  position(id: string): number | undefined {
    return this.itemPositions.get(id)
  }

  hasUserEcho(text: string, paths: readonly string[] = []): boolean {
    if (!this.trackEchoes) throw new Error('The host must declare the userEcho transcript question')
    return paths.length > 0
      ? this.userPaths.has(JSON.stringify(paths))
      : this.userTexts.has(text.trim())
  }

  private moveEchoCount(
    counts: Pick<Map<string, number>, 'get' | 'set' | 'delete'>,
    before: string | undefined,
    after: string | undefined,
  ): void {
    if (before === after) return
    if (before !== undefined) {
      const count = counts.get(before) ?? 0
      if (count <= 1) counts.delete(before)
      else counts.set(before, count - 1)
    }
    if (after !== undefined) counts.set(after, (counts.get(after) ?? 0) + 1)
  }

  private fileFacts(item: TranscriptItem): void {
    this.userItems.set(item.id, item.role === 'user')
    this.userPrompts.set(item.id, item.role === 'user' && item.text.trim().length > 0)
    this.questions.set(item.id, isAskUserQuestion(item))
    if (this.trackRecordedTime) {
      const at = item.ts === undefined ? NaN : Date.parse(item.ts)
      if (Number.isFinite(at)) this.recordedAt.set(item.id, at)
      else this.recordedAt.delete(item.id)
      this.recordedItems.set(item.id, Number.isFinite(at))
    }
    if (this.trackEchoes) {
      const previous = this.userEchoes.get(item.id)
      const next =
        item.role === 'user'
          ? { text: item.text.trim(), paths: JSON.stringify(item.toolPaths ?? []) }
          : undefined
      this.moveEchoCount(this.userTexts, previous?.text, next?.text)
      this.moveEchoCount(this.userPaths, previous?.paths, next?.paths)
      if (next) this.userEchoes.set(item.id, next)
      else this.userEchoes.delete(item.id)
    }
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
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
        ...(this.items.length === 0 && fallback ? { items: fallback.items } : {}),
        hasMoreOlder: false,
        initialLoaded: true,
        subscriptionHealthy: false,
        freshness: this.items.length > 0 || fallback ? 'saved' : null,
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
    if (options.disclose && this.items.length > 0) this.patch({ freshness: 'checking' })
    try {
      const page = await this.options.source.read({
        sessionId: this.options.sessionId,
        direction: 'before',
        limit: this.initialLimit,
      })
      if (!this.accepts(generation, serial)) return false
      const retainHistory =
        !page.reset &&
        this.initialLoaded &&
        this.items.length > 0 &&
        this.options.retainHistory?.() === true
      if (!retainHistory) this.windowEpoch += 1
      this.reconciledSignal = signal ?? this.activity?.signal ?? null
      if (!retainHistory) this.pagedBack = false
      const reconciled = page.reset
        ? mergeTranscriptFrame([], page.items)
        : retainHistory
          ? mergeTranscriptFrame(this.items, page.items)
          : reconcileTranscriptSnapshot(this.items, page.items, page.items.at(-1)?.cursor)
      const bounded = this.boundFollowingWindow(reconciled)
      const items = sameTranscriptItems(this.items, bounded.items) ? this.items : bounded.items
      this.patch({
        items,
        head: retainHistory ? (this.head ?? page.head) : page.head,
        tail: page.tail,
        hasMoreOlder: retainHistory ? this.hasMoreOlder : page.hasMore,
        loadingOlder: retainHistory ? this.loadingOlder : false,
        initialLoaded: true,
        subscriptionHealthy: page.items.length > 0,
        freshness: this.freshness === null ? null : page.items.length > 0 ? 'rendering' : 'saved',
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
      if (this.accepts(generation, serial) && this.items.length > 0) {
        this.patch({ freshness: 'saved' })
      }
      throw error
    }
  }

  async probe(options: TranscriptRefreshOptions = {}): Promise<boolean> {
    if (this.disposed) return false
    const generation = this.generation
    const serial = ++this.readSerial
    if (options.disclose && this.items.length > 0) this.patch({ freshness: 'checking' })
    let page: TranscriptPage
    try {
      page = await this.options.source.read({
        sessionId: this.options.sessionId,
        direction: 'before',
        limit: 1,
      })
    } catch (error) {
      if (this.accepts(generation, serial) && this.items.length > 0) {
        this.patch({ freshness: 'saved' })
      }
      throw error
    }
    if (!this.accepts(generation, serial)) return false
    const offlineMachineName = page.offline?.machineName ?? null
    if (offlineMachineName !== this.offlineMachineName) {
      this.patch({ offlineMachineName })
    }
    const remote = page.items.at(-1)
    if (!remote) {
      if (this.items.length > 0) this.patch({ freshness: 'saved' })
      return true
    }
    const position = this.itemPositions.get(remote.id)
    const held = position === undefined ? undefined : this.items[position]
    if (held && sameTranscriptItem(held, remote)) {
      if (this.freshness !== null) this.patch({ freshness: null })
      return true
    }
    return this.refresh({ disclose: true })
  }

  async loadOlder(): Promise<boolean> {
    if (this.disposed || this.loadingOlder || !this.hasMoreOlder || this.head === undefined) {
      return false
    }
    const generation = this.generation
    const epoch = this.windowEpoch
    const anchor = this.head
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
      const fresh = freshOlderTranscriptPage(page.items, this.items)
      if (fresh.length > 0) this.pagedBack = true
      const items = fresh.length > 0 ? [...fresh, ...this.items] : this.items
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
    if (this.freshness === 'rendering') this.patch({ freshness: null })
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
      !this.initialLoaded ||
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
    if (!this.initialLoaded || (this.pagedBack && !this.options.retainHistory) || this.probing)
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
        if (this.options.enqueueFrame) this.options.enqueueFrame(frame, meta)
        else this.merge(frame, meta)
      },
    )
  }

  merge(frame: TranscriptItem[], meta: { reset: boolean } = { reset: false }): void {
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
    const merged = mergeIndexedTranscriptFrame(this.items, frame, this.itemPositions)
    this.indexedItems = merged
    if (merged === this.items) return
    for (const item of frame) this.fileFacts(item)
    const bounded = this.boundFollowingWindow(merged)
    const items = bounded.items
    const tail = items.at(-1)?.cursor ?? this.tail
    this.patch(
      {
        items,
        ...(tail === undefined ? {} : { tail }),
        freshness: this.freshness === null ? null : 'rendering',
        ...bounded.paging,
      },
      frame,
    )
    this.options.cache?.write(this.options.sessionId, items)
  }

  private boundFollowingWindow(items: TranscriptItem[]): {
    items: TranscriptItem[]
    paging?: Pick<TranscriptState, 'head' | 'hasMoreOlder'>
  } {
    const retainHistory = this.options.retainHistory ? this.options.retainHistory() : this.pagedBack
    const limit = this.initialLimit * 2
    if (retainHistory || this.loadingOlder || items.length <= limit) return { items }
    const tail = items.slice(-limit)
    // Store readers accept the native item cursor as their opaque anchor. Keep
    // the authority's original page head until an actual trim, then page from
    // the first retained item so the omitted prefix remains recoverable.
    if (!tail[0]?.cursor) return { items }
    return { items: tail, paging: { head: tail[0].cursor, hasMoreOlder: true } }
  }

  private patch(patch: Partial<TranscriptState>, frame?: readonly TranscriptItem[]): void {
    const next = patch.items
    if (next && next !== this.orderedItems) {
      const rebuild = next !== this.indexedItems
      const changed = rebuild
        ? next
        : [...new Map((frame ?? next).map((item) => [item.id, item])).values()]
      const added = changed.filter((item) => !this.byId.has(item.id))
      if (rebuild) {
        this.itemPositions.clear()
        this.userPrompts.clear()
        this.userItems.clear()
        this.questions.clear()
        this.recordedAt.clear()
        this.recordedItems.clear()
        this.userEchoes.clear()
        this.userTexts.clear()
        this.userPaths.clear()
        const retained = new Set(next.map((item) => item.id))
        for (const id of this.byId.keys()) if (!retained.has(id)) this.byId.delete(id)
        next.forEach((item, index) => {
          this.itemPositions.set(item.id, index)
          this.fileFacts(item)
        })
        this.indexedItems = next
      }
      for (const item of changed) {
        freezePlain(item)
        const held = this.byId.get(item.id)
        if (!held || !sameTranscriptItem(held, item)) this.byId.set(item.id, freezePlain(item))
      }
      if (rebuild || next.length !== this.orderedItems.length) {
        const ids = next.map((item) => item.id)
        if (ids.length !== this.ids.length || ids.some((id, index) => this.ids[index] !== id))
          this.ids.replace(ids)
      }
      this.orderedItems = next
      this.latestOperatorPrompt = this.getItem(this.userPrompts.latest())?.text ?? null
      const question = this.getItem(this.questions.latest())
      this.pendingQuestion = question && !question.toolResult ? question : null
      const recorded = this.recordedItems.latest()
      this.latestRecordedAt =
        recorded === undefined ? null : (this.recordedAt.get(recorded) ?? null)
      this.latestUserId = this.userItems.latest() ?? null
      // The owning conversation retires sends inside this same action.
      this.options.onChange?.({ changed, added, rebuild })
    }
    const { items: _items, sessionId: _sessionId, ...status } = patch
    Object.assign(this, status)
  }
}
