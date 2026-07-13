import {
  CAP_METADATA_DELTA,
  type ConversationSummaryWire,
  createDispatcher,
  encode,
  type HeadlessActivityEvent,
  type HostMetricsWire,
  type IssueWire,
  isKnownMetadataChange,
  type ApprovalWire,
  type MachineWire,
  type MetadataChange,
  type MetadataChangeLenient,
  type MetadataDeltaMessageLenient,
  parseChangesSinceResult,
  parseServerMessageLenient,
  type ServerMessage,
  type ServerMessageLenient,
  type SessionMeta,
  type SyncChangesSinceResultLenient,
  type TranscriptItem,
} from '@podium/protocol'
import { type EchoLatencyStats, EchoLatencyTracker } from './echo-latency'

export interface WebSocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror?: ((ev: unknown) => void) | null
}

export interface ConnectionViewport {
  cols: number
  rows: number
  dpr: number
}

export interface ConnectionState {
  connected: boolean
  clientId: string
  controllerId: string | null
  sessionId: string
  role: 'controller' | 'spectator'
  cols: number
  rows: number
  epoch: number
  lastSeq: number
}

export interface SessionCallbacks {
  onFrame?: (text: string) => void
  onState?: (state: ConnectionState) => void
  /**
   * The server is about to send a full replay (not a `resumed` catch-up): clear
   * the screen before the buffered frames land. Not called on an incremental
   * resume, where the view keeps its content and appends.
   */
  onReset?: () => void
  /**
   * The server confirmed the attach (the PTY is bound and ready for input). Fires
   * on every `attached` message — independent of whether any output follows, so a
   * session sitting idle at a prompt is still recognised as ready. Use this rather
   * than the first output frame to clear a "Starting…" state, or an idle/blocked
   * child with an empty replay buffer would hang it forever.
   */
  onAttached?: () => void
}

export interface SocketHubOptions {
  url: string
  viewport: ConnectionViewport
  makeSocket?: (url: string) => WebSocketLike
  onError?: (message: string, event?: unknown) => void
  /**
   * Metadata-oplog catch-up (docs/spec/oplog-read-path.md), typically wired to the
   * `sync.changesSince` tRPC query. PROVIDING THIS OPTS THE HUB INTO DELTA MODE:
   * the hello advertises CAP_METADATA_DELTA, the server stops sending this client
   * full-list snapshot rebroadcasts, and the hub applies `metadataDelta` batches —
   * healing every (re)connect and any detected seq gap through this callback.
   * Omitted (tests, embedders): legacy snapshot behavior, byte-for-byte unchanged.
   */
  fetchChangesSince?: (cursor: number | null) => Promise<SyncChangesSinceResultLenient>
  /**
   * Resume-across-reloads (docs/spec/thin-client-replica.md §2.2): the cursor a
   * persisted local replica left off at. When set, the FIRST metadata heal after
   * connect calls `fetchChangesSince(initialCursor)` instead of `null`, so a warm
   * reload downloads a delta instead of the world. The snapshot fallback (server
   * compacted past the cursor) is unchanged — it full-replaces. Only meaningful
   * together with `fetchChangesSince`; pair it with `seedMetadata()` so a delta
   * result applies onto the replica's lists rather than empty ones.
   */
  initialCursor?: number | null
  /**
   * Fired after each APPLIED metadata batch (bootstrap/heal snapshot, heal delta,
   * or live `metadataDelta`) with the hub's current lists + cursor — the web
   * store persists these into the replica (data first, cursor after). The arrays
   * are the hub's own (not copies): treat them as read-only.
   */
  onMetadataApplied?: (state: MetadataAppliedState) => void
}

/** Snapshot of the hub's metadata state handed to `onMetadataApplied`. */
export interface MetadataAppliedState {
  cursor: number
  sessions: SessionMeta[]
  issues: IssueWire[]
  conversations: ConversationSummaryWire[]
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64Utf8(b64: string): string {
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return `${fallback}: ${error.message}`
  return fallback
}

// Liveness + recovery tuning. The heartbeat catches connections that died without a
// close event (laptop sleep leaves a half-open TCP; some proxies drop idle sockets
// silently), doubles as proxy-keepalive traffic, and — at this cadence — works as a
// latency probe: each ping's round-trip feeds the connection-health indicator, so
// the interval is seconds, not tens of seconds. Reconnect backoff is capped low:
// the common cause here is a backend redeploy that is back within seconds.
const HEARTBEAT_INTERVAL_MS = 2_500
const HEARTBEAT_TIMEOUT_MS = 10_000
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000

// Health thresholds. Degraded = the UI shows a yellow dot (typing will feel laggy);
// down = red (input is not reaching the agent). RTT alone never maps to "down" —
// red is reserved for pings that aren't answered at all or a dropped socket.
const DEGRADED_RTT_MS = 400
const PING_DEGRADED_AFTER_MS = 1_500
const PING_DOWN_AFTER_MS = 5_000
// Unanswered pings older than the force-close window can't accumulate meaningfully;
// the cap just bounds the queue if pongs stop while other traffic keeps us alive.
const PING_QUEUE_CAP = 8
// Keystrokes typed while the socket is down are queued and flushed (in order) on
// reconnect, so a blip doesn't silently swallow input. Capped so a long outage
// can't replay an unbounded burst of stale typing into the agent on return.
const INPUT_QUEUE_CAP = 1_000
// Flat retry for a failed changesSince heal while the socket is up (tRPC blips are
// rare when the WS is healthy; a reconnect re-enters the heal path anyway).
const HEAL_RETRY_MS = 3_000

/** Fold one oplog change into an entity list (upsert replaces by id or appends;
 *  an upsert with no value is a producer bug the protocol says to drop). */
function applyChange<T>(
  list: T[],
  op: 'upsert' | 'remove',
  value: T | undefined,
  match: (el: T) => boolean,
): T[] {
  if (op === 'remove') return list.filter((el) => !match(el))
  if (value === undefined) return list
  let replaced = false
  const next = list.map((el) => {
    if (!match(el)) return el
    replaced = true
    return value
  })
  if (!replaced) next.push(value)
  return next
}

export interface AttentionEvent {
  sessionId: string
  title: string
  body: string
}

export type ConnectionHealthStatus = 'ok' | 'degraded' | 'down'

export interface ConnectionHealth {
  status: ConnectionHealthStatus
  /** Latest measured ping round-trip. Null until the first pong (or while disconnected). */
  rttMs: number | null
  /** Epoch ms when the current status began — lets the UI say "down for 12s". */
  since: number
}

/**
 * The hub's typed subscription seam [spec:SP-3fe2]: every event the hub fans
 * out, keyed by a CLOSED kind union. Payloads are tuples so multi-argument
 * legacy callbacks (`onSessionDraft`) ride the same seam without an adapter.
 * `on(kind, handler)` is the one subscription primitive; the deprecated
 * `on*`/`subscribe*` methods below are thin wrappers over it.
 */
export interface HubEvents {
  /** Full session list after any change (snapshot, delta, title/state patch). */
  sessions: [sessions: SessionMeta[]]
  conversations: [conversations: ConversationSummaryWire[]]
  hostMetrics: [hosts: HostMetricsWire[]]
  machines: [machines: MachineWire[]]
  /** Approval broker [spec:SP-edbb]: undecided management-op requests. */
  approvals: [pending: ApprovalWire[]]
  /** Full issue list after any change. */
  issues: [issues: IssueWire[]]
  /** Single-issue broadcast (fires alongside the full-list `issues` event). */
  issueUpdated: [issue: IssueWire]
  connectionHealth: [health: ConnectionHealth]
  attention: [event: AttentionEvent]
  sessionDraft: [sessionId: string, text: string]
  /** One live transcript frame: ONLY that frame's delta items — the caller owns
   *  history (see subscribeTranscript, which also manages the server-side
   *  subscription these frames depend on). */
  transcriptDelta: [sessionId: string, items: TranscriptItem[], meta: { reset: boolean }]
  headlessActivity: [sessionId: string, event: HeadlessActivityEvent]
}

export type HubEventKind = keyof HubEvents

export type HubEventHandler<K extends HubEventKind> = (...payload: HubEvents[K]) => void

/** Storage-side supertype: every HubEventHandler is assignable to it. */
type AnyHubEventHandler = (...payload: never[]) => void

/** One ws, multiplexed across N sessions. Owns the connection + server-assigned clientId. */
export class SocketHub {
  private readonly opts: SocketHubOptions
  private readonly makeSocket: (url: string) => WebSocketLike
  private socket: WebSocketLike | undefined
  private connectedFlag = false
  private clientIdValue = ''
  private sessionList: SessionMeta[] = []
  private conversationList: ConversationSummaryWire[] = []
  private hostMetricsList: HostMetricsWire[] = []
  private machinesList: MachineWire[] = []
  private approvalsList: ApprovalWire[] = []
  private issueList: IssueWire[] = []
  // ---- metadata-oplog cursor state (delta mode only; see SocketHubOptions) ----
  /** Last applied oplog seq; null until the first changesSince completes. */
  private metadataCursor: number | null = null
  /** The options' `initialCursor` is spent on the FIRST heal only — after that
   *  the live `metadataCursor` (or null → snapshot) is always the truth. */
  private initialCursorSpent = false
  /** Deltas that arrived while a heal/bootstrap was in flight — replayed after. */
  private pendingDeltas: MetadataDeltaMessageLenient[] = []
  private healInFlight = false
  private healRetryTimer: ReturnType<typeof setTimeout> | undefined
  private intentionalClose = false
  private everConnected = false
  private reconnectDelay = RECONNECT_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private heartbeatDeadline: ReturnType<typeof setTimeout> | undefined
  /** Send time of each unanswered ping, oldest first. Pongs arrive in ping order. */
  private pingQueue: number[] = []
  /** Input messages typed while offline, flushed in order on reconnect. */
  private readonly inputQueue: Parameters<typeof encode>[0][] = []
  /** Control messages issued while the socket is still CONNECTING (e.g. an eager
   *  requestControl on mount): sending then throws InvalidStateError — a race that
   *  only surfaces over a high-latency link (a tunnel) where onopen hasn't fired
   *  yet. Queued here and flushed, in order, once the socket opens. */
  private readonly preOpenQueue: Parameters<typeof encode>[0][] = []
  private staleTimer: ReturnType<typeof setTimeout> | undefined
  private lastRttMs: number | null = null
  private health: ConnectionHealth = { status: 'ok', rttMs: null, since: Date.now() }
  private readonly connections = new Map<string, SessionConnection>()
  // Per-session structured transcript subscriptions. The hub is a thin
  // delta-forwarder: it holds NO buffered items (ChatView owns history, seeded
  // from a tRPC read). It tracks only `since` — the cursor of the newest item
  // Per-session headless-activity registrations, keyed by the caller's callback
  // so re-registering the same cb dedups to one delivery + one unsubscribe.
  private readonly headlessSubs = new Map<
    string,
    Map<(e: HeadlessActivityEvent) => void, () => void>
  >()

  // forwarded so far — so a reconnect can resume the live stream from that point.
  // An entry exists while at least one observer is subscribed.
  private readonly transcripts = new Map<
    string,
    {
      since: string | undefined
      observers: Set<(items: TranscriptItem[], meta: { reset: boolean }) => void>
      /** The entry's seam registration — released when the last observer leaves. */
      off: () => void
    }
  >()
  /** THE subscription seam: one handler Set per event kind (see HubEvents). */
  private readonly eventObservers = new Map<HubEventKind, Set<AnyHubEventHandler>>()
  private lastVisible = true
  private lastViewState: {
    visible: string[]
    focused: string | null
    modes?: Record<string, 'native' | 'chat'>
  } = {
    visible: [],
    focused: null,
  }

  constructor(opts: SocketHubOptions) {
    this.opts = opts
    this.makeSocket = opts.makeSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
  }

  get connected(): boolean {
    return this.connectedFlag
  }
  get clientId(): string {
    return this.clientIdValue
  }

  connect(): void {
    if (this.socket !== undefined) return
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    let socket: WebSocketLike
    try {
      socket = this.makeSocket(this.opts.url)
    } catch (err) {
      // A constructor throw before first contact is a config problem (bad URL) —
      // surface it; once we have connected successfully, retry like any other drop.
      if (this.everConnected) this.scheduleReconnect()
      else this.opts.onError?.(errorMessage(err, 'WebSocket connection failed'), err)
      return
    }

    let opened = false
    let reportedError = false
    this.intentionalClose = false
    this.socket = socket
    socket.onopen = () => {
      opened = true
      this.connectedFlag = true
      this.everConnected = true
      this.reconnectDelay = RECONNECT_MIN_MS
      this.startHeartbeat()
      this.sendRaw({
        type: 'hello',
        clientId: this.clientIdValue,
        viewport: { ...this.opts.viewport },
        // Delta mode is negotiated per connection — advertise it only when the
        // embedder wired a changesSince fetcher (see SocketHubOptions).
        ...(this.opts.fetchChangesSince ? { caps: [CAP_METADATA_DELTA] } : {}),
      })
      // Catch up on whatever the metadata stream did while we were away (or take
      // the bootstrap snapshot on a first connect). The attach-time snapshots the
      // server sends pre-hello already painted the UI; this establishes the cursor.
      this.healMetadata()
      // Re-attach with a resume cursor: the view survived the drop, so ask the
      // server to catch us up from the last seq we rendered instead of wiping and
      // replaying the whole buffer. A connection that has rendered nothing yet
      // (lastSeq -1) omits the cursor → full replay.
      for (const [sessionId, conn] of this.connections) {
        const sinceSeq = conn.resumeCursor
        this.sendRaw({ type: 'attach', sessionId, ...(sinceSeq >= 0 ? { sinceSeq } : {}) })
      }
      // Transcript subscriptions survive reconnects the same way attaches do —
      // resume from the last cursor we forwarded (`since`) so the stream picks up
      // where it left off instead of replaying. A subscription that hasn't seen a
      // delta yet (since undefined) re-subscribes from the live tail.
      for (const [sessionId, entry] of this.transcripts) {
        this.sendRaw({
          type: 'transcriptSubscribe',
          sessionId,
          ...(entry.since ? { since: entry.since } : {}),
        })
      }
      // Always assert presence on (re)connect: the server defaults a new client
      // to not-visible (fail-safe toward notifying), so a visible tab must say so.
      this.sendRaw({ type: 'presence', visible: this.lastVisible })
      // Re-assert per-session view state the same way: the server starts each new
      // client with empty view state, so a reconnecting client must re-declare which
      // sessions it renders / has focused for output-relay prioritization to resume.
      this.sendRaw({ type: 'viewState', ...this.lastViewState })
      // Flush keystrokes typed during the outage — after the re-attaches above, so
      // the session exists and this (reclaimed) client is the controller again
      // before its input lands.
      for (const msg of this.inputQueue.splice(0)) this.sendRaw(msg)
      // Flush control messages that were issued before the socket opened (e.g. an
      // eager requestControl) — after the re-attaches above so the session exists.
      for (const msg of this.preOpenQueue.splice(0)) this.sendRaw(msg)
      this.notifyConnections()
      this.evaluateHealth()
    }
    socket.onmessage = (ev) => {
      this.markAlive()
      this.route(String(ev.data))
    }
    socket.onerror = (ev) => {
      reportedError = true
      // Errors after a successful first connection are transient (backend redeploy,
      // network blip): the reconnect loop handles them. Only a failure to ever
      // connect is fatal — that's a wrong address or a server that isn't running.
      if (!this.everConnected) this.opts.onError?.('WebSocket connection failed', ev)
    }
    socket.onclose = () => {
      if (!this.intentionalClose && !opened && !reportedError && !this.everConnected) {
        this.opts.onError?.('WebSocket connection closed before connecting')
      }
      this.onSocketClosed()
    }
  }

  /** Common teardown for any socket end: from onclose or a heartbeat force-close. */
  private onSocketClosed(): void {
    this.stopHeartbeat()
    this.connectedFlag = false
    this.socket = undefined
    // A heal retry is pointless with the socket down (and deltas queued during an
    // outage are superseded by the reconnect heal) — the onopen path re-enters.
    if (this.healRetryTimer !== undefined) {
      clearTimeout(this.healRetryTimer)
      this.healRetryTimer = undefined
    }
    this.pendingDeltas = []
    this.notifyConnections()
    if (!this.intentionalClose) this.evaluateHealth()
    if (!this.intentionalClose && this.everConnected) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    // First ping right away: it seeds the latency measurement on connect and, after
    // a reconnect, confirms the server is actually answering — an open socket alone
    // already cleared the indicator, and this verifies that optimism within ~1.5s.
    this.sendPing()
    this.heartbeatTimer = setInterval(() => this.sendPing(), HEARTBEAT_INTERVAL_MS)
  }

  private sendPing(): void {
    this.sendRaw({ type: 'ping' })
    if (this.pingQueue.length < PING_QUEUE_CAP) this.pingQueue.push(Date.now())
    if (this.pingQueue.length === 1) this.armStaleTimer()
    if (this.heartbeatDeadline !== undefined) return
    this.heartbeatDeadline = setTimeout(() => {
      this.heartbeatDeadline = undefined
      this.forceClose()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  /** Two-stage alarm on the oldest unanswered ping: degraded, then down. Without
   *  this the health would only be re-checked when a message arrives — exactly what
   *  isn't happening on a stalling connection. */
  private armStaleTimer(): void {
    this.clearStaleTimer()
    this.staleTimer = setTimeout(() => {
      this.staleTimer = setTimeout(() => {
        this.staleTimer = undefined
        this.evaluateHealth()
      }, PING_DOWN_AFTER_MS - PING_DEGRADED_AFTER_MS)
      this.evaluateHealth()
    }, PING_DEGRADED_AFTER_MS)
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== undefined) clearTimeout(this.staleTimer)
    this.staleTimer = undefined
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    if (this.heartbeatDeadline !== undefined) clearTimeout(this.heartbeatDeadline)
    this.heartbeatTimer = undefined
    this.heartbeatDeadline = undefined
    this.clearStaleTimer()
    this.pingQueue = []
    this.lastRttMs = null
  }

  /** Any inbound traffic proves the connection is alive; clear the ping deadline. */
  private markAlive(): void {
    if (this.heartbeatDeadline === undefined) return
    clearTimeout(this.heartbeatDeadline)
    this.heartbeatDeadline = undefined
  }

  /** The heartbeat went unanswered. A half-open TCP connection may not deliver a
   *  close event for minutes, so detach the handlers and run the close path now. */
  private forceClose(): void {
    const socket = this.socket
    if (socket === undefined) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    if (socket.onerror !== undefined) socket.onerror = null
    try {
      socket.close()
    } catch {
      // already dead — exactly the case we're cleaning up
    }
    this.onSocketClosed()
  }

  attach(sessionId: string, cb: SessionCallbacks = {}): SessionConnection {
    let conn = this.connections.get(sessionId)
    if (conn === undefined) {
      conn = new SessionConnection(this, sessionId, cb, this.opts.viewport)
      this.connections.set(sessionId, conn)
      if (this.connectedFlag) this.sendRaw({ type: 'attach', sessionId })
    } else {
      conn.setCallbacks(cb)
    }
    return conn
  }

  detach(sessionId: string): void {
    if (this.connections.delete(sessionId) && this.connectedFlag) {
      this.sendRaw({ type: 'detach', sessionId })
    }
  }

  /**
   * Subscribe to a hub event (see {@link HubEvents} for the kinds + payloads).
   * The one subscription primitive — every legacy `on*`/`subscribe*` method is
   * a thin wrapper over it. Does NOT replay current state on subscribe: read
   * that from the matching getter (`sessions()`, `issues()`, `connectionHealth()`, …).
   * Returns an unsubscribe.
   */
  on<K extends HubEventKind>(kind: K, handler: HubEventHandler<K>): () => void {
    let set = this.eventObservers.get(kind)
    if (set === undefined) {
      set = new Set()
      this.eventObservers.set(kind, set)
    }
    // Erase the per-kind payload tuple for storage; emit() restores it. Safe
    // because handlers only ever receive the payload emitted under their kind.
    const stored = handler as unknown as AnyHubEventHandler
    set.add(stored)
    return () => {
      set.delete(stored)
    }
  }

  /** Fan one event out to its subscribers. Iterates the live Set — the same
   *  mid-iteration add/remove semantics as the per-kind Sets this replaced. */
  private emit<K extends HubEventKind>(kind: K, ...payload: HubEvents[K]): void {
    const set = this.eventObservers.get(kind)
    if (set === undefined) return
    // Snapshot + membership check reproduces the pre-seam per-Set semantics:
    // a handler REGISTERED during this emit starts with the NEXT event (the
    // old per-session transcript entries were captured before routing, so a
    // handoff re-subscription never saw the in-flight frame), while a handler
    // UNSUBSCRIBED during this emit is skipped (old live-Set iteration).
    for (const handler of [...set]) {
      if (!set.has(handler)) continue
      ;(handler as unknown as HubEventHandler<K>)(...payload)
    }
  }

  sessions(): SessionMeta[] {
    return this.sessionList
  }

  /** @deprecated Use `on('sessions', cb)` (which does not replay — read `sessions()`). */
  onSessions(cb: (s: SessionMeta[]) => void): () => void {
    const off = this.on('sessions', cb)
    cb(this.sessionList)
    return off
  }

  conversations(): ConversationSummaryWire[] {
    return this.conversationList
  }

  /** @deprecated Use `on('conversations', cb)` (no replay — read `conversations()`). */
  onConversations(cb: (c: ConversationSummaryWire[]) => void): () => void {
    const off = this.on('conversations', cb)
    cb(this.conversationList)
    return off
  }

  hostMetrics(): HostMetricsWire[] {
    return this.hostMetricsList
  }

  /** @deprecated Use `on('hostMetrics', cb)` (no replay — read `hostMetrics()`). */
  onHostMetrics(cb: (h: HostMetricsWire[]) => void): () => void {
    const off = this.on('hostMetrics', cb)
    cb(this.hostMetricsList)
    return off
  }

  machines(): MachineWire[] {
    return this.machinesList
  }

  /** @deprecated Use `on('machines', cb)` (no replay — read `machines()`). */
  onMachines(cb: (m: MachineWire[]) => void): () => void {
    const off = this.on('machines', cb)
    cb(this.machinesList)
    return off
  }

  issues(): IssueWire[] {
    return this.issueList
  }

  /**
   * Observe the full issue list. Replays the current list immediately, like `onSessions`.
   * @deprecated Use `on('issues', cb)` (no replay — read `issues()`).
   */
  onIssues(cb: (i: IssueWire[]) => void): () => void {
    const off = this.on('issues', cb)
    cb(this.issueList)
    return off
  }

  /**
   * Observe single-issue updates (no immediate replay; mirrors `onAttention`).
   * @deprecated Use `on('issueUpdated', cb)`.
   */
  onIssueUpdated(cb: (i: IssueWire) => void): () => void {
    return this.on('issueUpdated', cb)
  }

  /**
   * Seed the entity lists from a persisted local replica (hydrate-first paint,
   * docs/spec/thin-client-replica.md §2.2) and notify observers, so an offline
   * reload shows last-known data before — or without — the network answering.
   * A no-op once server truth has landed (any completed changesSince): the
   * replica is a cache and never argues with the server (spec invariant 1).
   */
  seedMetadata(seed: {
    sessions: SessionMeta[]
    issues: IssueWire[]
    conversations: ConversationSummaryWire[]
  }): void {
    if (this.metadataCursor !== null) return
    this.sessionList = seed.sessions
    this.issueList = seed.issues
    this.conversationList = seed.conversations
    this.emit('sessions', this.sessionList)
    this.emit('issues', this.issueList)
    this.emit('conversations', this.conversationList)
  }

  /**
   * Observe a session's live structured-transcript deltas, resuming from `since`
   * (the cursor of the newest item the caller already holds — typically the
   * `tail` of an initial tRPC read). The first observer triggers a server-side
   * subscription; the last one leaving unsubscribes.
   *
   * The hub is a thin forwarder: each `transcriptDelta` frame calls the callback
   * with ONLY that frame's delta items (not an accumulated list) — the caller
   * owns history. `meta.reset` is true when the tailer re-seeded (resume rolled
   * into a fresh file / reattach) and the caller should re-read its window.
   *
   * The callback is NOT invoked synchronously: the caller seeds its initial state
   * from the read, and a sync empty cb would clobber it.
   */
  subscribeTranscript(
    sessionId: string,
    since: string | undefined,
    cb: (items: TranscriptItem[], meta: { reset: boolean }) => void,
  ): () => void {
    let entry = this.transcripts.get(sessionId)
    if (!entry) {
      // One seam registration per session entry, fanning out to the entry's
      // observer Set — preserving the old per-session semantics exactly (dedup
      // by callback identity, live-Set iteration) on top of `on()`.
      const observers = new Set<(items: TranscriptItem[], meta: { reset: boolean }) => void>()
      const off = this.on('transcriptDelta', (sid, items, meta) => {
        if (sid !== sessionId) return
        for (const o of observers) o(items, meta)
      })
      entry = { since, observers, off }
      this.transcripts.set(sessionId, entry)
      if (this.connectedFlag) {
        this.sendRaw({ type: 'transcriptSubscribe', sessionId, ...(since ? { since } : {}) })
      }
    }
    entry.observers.add(cb)
    return () => {
      const current = this.transcripts.get(sessionId)
      if (!current) return
      current.observers.delete(cb)
      if (current.observers.size === 0) {
        current.off()
        this.transcripts.delete(sessionId)
        if (this.connectedFlag) this.sendRaw({ type: 'transcriptUnsubscribe', sessionId })
      }
    }
  }

  /**
   * Observe live turn activity for a HEADLESS session (partial assistant text,
   * status, turn boundaries). Frames are server-broadcast to all clients, so this
   * is a local fan-out only — mirrors subscribeTranscript's shape without the
   * server subscription. Returns an unsubscribe.
   * @deprecated Use `on('headlessActivity', cb)` and filter by sessionId.
   */
  subscribeHeadless(sessionId: string, cb: (e: HeadlessActivityEvent) => void): () => void {
    // Dedup by the CALLER's callback per session (the old per-session Set
    // semantics): re-registering the same cb must not double-deliver, and the
    // one registration has one unsubscribe. A fresh wrapper closure per call
    // would defeat the seam Set's identity dedup.
    let subs = this.headlessSubs.get(sessionId)
    if (!subs) {
      subs = new Map()
      this.headlessSubs.set(sessionId, subs)
    }
    const existing = subs.get(cb)
    if (existing) return existing
    const off = this.on('headlessActivity', (sid, event) => {
      if (sid === sessionId) cb(event)
    })
    const unsubscribe = () => {
      const current = this.headlessSubs.get(sessionId)
      if (current?.get(cb) === unsubscribe) {
        current.delete(cb)
        if (current.size === 0) this.headlessSubs.delete(sessionId)
        off()
      }
    }
    subs.set(cb, unsubscribe)
    return unsubscribe
  }

  /**
   * Attention events (agent needs the human) — the app turns these into notifications.
   * @deprecated Use `on('attention', cb)`.
   */
  onAttention(cb: (e: AttentionEvent) => void): () => void {
    return this.on('attention', cb)
  }

  /**
   * Subscribe to draft changes broadcast by other clients/devices. Returns an unsubscribe.
   * @deprecated Use `on('sessionDraft', cb)`.
   */
  onSessionDraft(cb: (sessionId: string, text: string) => void): () => void {
    return this.on('sessionDraft', cb)
  }

  /** Publish this client's in-progress draft for a session to the server. */
  sendSessionDraft(sessionId: string, text: string): void {
    if (this.connectedFlag) this.sendRaw({ type: 'setSessionDraft', sessionId, text })
  }

  /** Report page visibility; the server's smart router skips mobile push while visible. */
  setVisible(visible: boolean): void {
    this.lastVisible = visible
    if (this.connectedFlag) this.sendRaw({ type: 'presence', visible })
  }

  /**
   * Report which sessions this client renders (`visible`) and which one has input
   * focus (`focused`). The server unions this across clients to prioritize PTY output
   * relay (focused/visible live; the rest coalesced). Stored and re-asserted on reconnect.
   *
   * `modes` (optional) maps each visible session to its rendered mode (native terminal
   * vs chat). It's wired through so the server has the signal; it does NOT change
   * relay/coalescing behavior.
   */
  setViewState(
    visible: string[],
    focused: string | null,
    modes?: Record<string, 'native' | 'chat'>,
  ): void {
    // Omit `modes` entirely when undefined so the wire payload (and the
    // re-assert below) stays byte-identical to the pre-modes message for clients
    // that don't report a mode — keeps old expectations exact.
    this.lastViewState = modes ? { visible, focused, modes } : { visible, focused }
    if (this.connectedFlag)
      this.sendRaw(
        modes
          ? { type: 'viewState', visible, focused, modes }
          : { type: 'viewState', visible, focused },
      )
  }

  connectionHealth(): ConnectionHealth {
    return this.health
  }

  /** @deprecated Use `on('connectionHealth', cb)` (no replay — read `connectionHealth()`). */
  onConnectionHealth(cb: (h: ConnectionHealth) => void): () => void {
    const off = this.on('connectionHealth', cb)
    cb(this.health)
    return off
  }

  private evaluateHealth(): void {
    const next = this.computeHealth()
    if (next.status === this.health.status && next.rttMs === this.health.rttMs) return
    // A status that merely re-confirms keeps its start time — `since` marks the
    // transition, not the latest re-evaluation.
    this.health = next.status === this.health.status ? { ...next, since: this.health.since } : next
    this.emit('connectionHealth', this.health)
  }

  private computeHealth(): ConnectionHealth {
    const since = Date.now()
    if (!this.connectedFlag) {
      // Before the first connection the fatal-error page owns the messaging; a red
      // dot on top of it (or during the initial load) would be noise.
      return { status: this.everConnected ? 'down' : 'ok', rttMs: null, since }
    }
    const oldest = this.pingQueue[0]
    if (oldest !== undefined) {
      const waitedMs = Date.now() - oldest
      if (waitedMs >= PING_DOWN_AFTER_MS) return { status: 'down', rttMs: this.lastRttMs, since }
      if (waitedMs >= PING_DEGRADED_AFTER_MS)
        return { status: 'degraded', rttMs: this.lastRttMs, since }
    }
    if (this.lastRttMs !== null && this.lastRttMs >= DEGRADED_RTT_MS) {
      return { status: 'degraded', rttMs: this.lastRttMs, since }
    }
    return { status: 'ok', rttMs: this.lastRttMs, since }
  }

  /** @internal Used by SessionConnection to send its sessionId-tagged messages. */
  _send(msg: Parameters<typeof encode>[0]): void {
    this.sendRaw(msg)
  }

  /** @internal Input path: send now if connected, else queue for flush on
   *  reconnect so a blip doesn't silently drop keystrokes. */
  _sendInput(msg: Parameters<typeof encode>[0]): void {
    if (this.connectedFlag && this.socket !== undefined) {
      this.sendRaw(msg)
      return
    }
    if (this.inputQueue.length < INPUT_QUEUE_CAP) this.inputQueue.push(msg)
  }

  dispose(): void {
    this.intentionalClose = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.stopHeartbeat()
    this.socket?.close()
    this.socket = undefined
    this.connectedFlag = false
    this.inputQueue.length = 0
    this.notifyConnections()
  }

  private route(raw: string): void {
    let msg: ServerMessageLenient | null
    try {
      // Lenient parse: for the collection-bearing messages, one poisoned element
      // (e.g. a session with an out-of-enum agentKind) is quarantined instead of
      // failing the whole batch — otherwise a single bad row blanks an entire list.
      const result = parseServerMessageLenient(raw)
      msg = result.message
      if (result.dropped > 0) {
        // Never silent: a swallowed drop here was what turned a one-row data bug into
        // an invisible, blank-UI outage. Make every quarantine observable.
        console.warn(
          `[podium] quarantined ${result.dropped} invalid item(s) in a ${msg?.type ?? '?'} message`,
        )
        // A quarantined element in a DELTA batch is an invisible cursor gap (list
        // messages self-heal on the next snapshot; a delta stream does not) — treat
        // it like any other gap and resync through changesSince.
        if (msg?.type === 'metadataDelta') {
          this.healMetadata()
          return
        }
      }
    } catch (err) {
      console.warn('[podium] dropped an unparseable server message', err)
      return
    }
    if (!msg) return
    this.dispatchServerMessage(msg, undefined)
  }

  /**
   * Total dispatch over the parsed ServerMessage union [spec:SP-3fe2]: the
   * handler table is a mapped type over `ServerMessage['type']`, so adding a
   * message type to the protocol breaks compilation HERE until it is handled —
   * the hand-written if-ladder this replaces could silently ignore one.
   */
  private readonly dispatchServerMessage = createDispatcher<ServerMessageLenient>({
    pong: () => {
      // Liveness was already recorded in onmessage; here the pong closes out the
      // oldest in-flight ping to yield a round-trip sample.
      const sentAt = this.pingQueue.shift()
      if (sentAt !== undefined) {
        this.lastRttMs = Date.now() - sentAt
        if (this.pingQueue.length === 0) this.clearStaleTimer()
        this.evaluateHealth()
      }
    },
    welcome: (msg) => {
      this.clientIdValue = msg.clientId
      this.notifyConnections()
    },
    metadataDelta: (msg) => {
      this.ingestDelta(msg)
    },
    sessionsChanged: (msg) => {
      this.sessionList = msg.sessions
      this.emit('sessions', this.sessionList)
    },
    conversationsChanged: (msg) => {
      this.conversationList = msg.conversations
      this.emit('conversations', this.conversationList)
    },
    hostMetricsChanged: (msg) => {
      this.hostMetricsList = msg.hosts
      this.emit('hostMetrics', this.hostMetricsList)
    },
    issuesChanged: (msg) => {
      this.issueList = msg.issues
      this.emit('issues', this.issueList)
    },
    issueUpdated: (msg) => {
      // Upsert, not just replace: single-issue broadcasts are the server's primary
      // issue delta (#22), so an id we haven't seen yet must join the list rather
      // than be dropped on the floor.
      this.issueList = this.issueList.some((i) => i.id === msg.issue.id)
        ? this.issueList.map((i) => (i.id === msg.issue.id ? msg.issue : i))
        : [...this.issueList, msg.issue]
      this.emit('issues', this.issueList)
      this.emit('issueUpdated', msg.issue)
    },
    attentionEvent: (msg) => {
      this.emit('attention', { sessionId: msg.sessionId, title: msg.title, body: msg.body })
    },
    headlessActivity: (msg) => {
      this.emit('headlessActivity', msg.sessionId, msg.event)
    },
    transcriptDelta: (msg) => {
      // Track the newest cursor so a reconnect resumes from here. A reset frame
      // re-seeds: keep the new tail too (the caller re-reads its window).
      const entry = this.transcripts.get(msg.sessionId)
      if (entry && msg.tail) entry.since = msg.tail
      this.emit('transcriptDelta', msg.sessionId, msg.items, { reset: msg.reset ?? false })
    },
    sessionTitleChanged: (msg) => {
      let changed = false
      this.sessionList = this.sessionList.map((s) => {
        if (s.sessionId !== msg.sessionId || s.title === msg.title) return s
        changed = true
        return { ...s, title: msg.title }
      })
      if (changed) this.emit('sessions', this.sessionList)
    },
    sessionDraftChanged: (msg) => {
      this.emit('sessionDraft', msg.sessionId, msg.text)
    },
    sessionAgentStateChanged: (msg) => {
      let changed = false
      this.sessionList = this.sessionList.map((s) => {
        if (s.sessionId !== msg.sessionId) return s
        changed = true
        return { ...s, agentState: msg.state }
      })
      if (changed) this.emit('sessions', this.sessionList)
    },
    machinesChanged: (msg) => {
      this.machinesList = msg.machines
      this.emit('machines', this.machinesList)
    },
    approvalsChanged: (msg) => {
      this.approvalsList = msg.pending
      this.emit('approvals', this.approvalsList)
    },
    // Session-scoped terminal stream: forwarded to the matching SessionConnection
    // (or dropped when no view is attached — same as the old fall-through arm).
    attached: (msg) => this.forwardToSession(msg),
    outputFrame: (msg) => this.forwardToSession(msg),
    controllerChanged: (msg) => this.forwardToSession(msg),
    geometry: (msg) => this.forwardToSession(msg),
    agentExit: (msg) => this.forwardToSession(msg),
  })

  private forwardToSession(msg: SessionScopedServerMessage): void {
    this.connections.get(msg.sessionId)?._ingest(msg)
  }

  // ---- metadata oplog: delta application + cursor healing (spec §2.4) ----

  /** Live `metadataDelta` intake. Queued while a heal is in flight (the heal's
   *  cursor decides what still applies); a seq gap aborts into a heal. */
  private ingestDelta(msg: MetadataDeltaMessageLenient): void {
    if (this.healInFlight || this.metadataCursor == null) {
      this.pendingDeltas.push(msg)
      // No cursor yet and no heal running (changesSince rejected and is waiting on
      // its retry timer): the queue alone would grow unboundedly — nudge the heal.
      if (!this.healInFlight && this.healRetryTimer === undefined) this.healMetadata()
      return
    }
    if (this.applyDelta(msg)) this.emitMetadataApplied()
    else this.healMetadata()
  }

  /** Persist hook: hand the current lists + cursor to the embedder after an
   *  applied batch. Allocation-light — passes the live arrays, not copies. */
  private emitMetadataApplied(): void {
    const cb = this.opts.onMetadataApplied
    if (cb === undefined || this.metadataCursor === null) return
    cb({
      cursor: this.metadataCursor,
      sessions: this.sessionList,
      issues: this.issueList,
      conversations: this.conversationList,
    })
  }

  /**
   * Apply one batch against the cursor. Returns false on a gap (batch starts past
   * cursor + 1) — the caller must heal. Changes at or below the cursor are skipped
   * (a heal may have already covered them); upserts are idempotent by id.
   */
  private applyDelta(msg: MetadataDeltaMessageLenient): boolean {
    const cursor = this.metadataCursor as number
    if (msg.seq <= cursor) return true // entirely stale — already healed past it
    const fresh = msg.changes.filter((c) => c.seq > cursor)
    if (fresh.length === 0) return true
    if ((fresh[0] as MetadataChangeLenient).seq !== cursor + 1) return false
    this.applyChanges(fresh)
    this.metadataCursor = msg.seq
    return true
  }

  /** Fold wire changes into the entity lists and notify only touched observers.
   *  Exhaustive over the KNOWN entity kinds; an unknown kind (a NEWER server,
   *  [spec:SP-3fe2] #258) is ignored with a debug log — the old else-branch
   *  folded anything unrecognised into the conversation list, silently
   *  corrupting it. The cursor still advances past ignored rows (the caller
   *  advances by msg.seq/result.cursor), so this is NOT a gap and must not heal. */
  private applyChanges(changes: MetadataChangeLenient[]): void {
    const touched = new Set<MetadataChange['entity']>()
    for (const c of changes) {
      if (!isKnownMetadataChange(c)) {
        console.debug(`[podium] ignoring metadata change with unknown entity kind '${c.entity}'`)
        continue
      }
      touched.add(c.entity)
      switch (c.entity) {
        case 'session':
          this.sessionList = applyChange(
            this.sessionList,
            c.op,
            c.value,
            (s) => s.sessionId === c.id,
          )
          break
        case 'issue':
          this.issueList = applyChange(this.issueList, c.op, c.value, (i) => i.id === c.id)
          break
        case 'conversation':
          this.conversationList = applyChange(
            this.conversationList,
            c.op,
            c.value,
            (x) => x.id === c.id,
          )
          break
        default:
          c satisfies never
      }
    }
    if (touched.has('session')) this.emit('sessions', this.sessionList)
    if (touched.has('issue')) this.emit('issues', this.issueList)
    if (touched.has('conversation')) this.emit('conversations', this.conversationList)
  }

  /**
   * Establish or repair the cursor via changesSince: bootstrap (null cursor) and
   * compaction both come back as a snapshot (full replace — same source of truth
   * as any delta in flight, so a replace is always safe); otherwise the missed
   * changes are applied as a delta. Single-flight; deltas arriving meanwhile queue
   * and are drained after, re-healing if they still don't line up. Fetch failures
   * retry on a flat 3s timer while the socket is up — a reconnect also re-enters.
   */
  private healMetadata(): void {
    const fetch = this.opts.fetchChangesSince
    if (!fetch || this.healInFlight) return
    if (this.healRetryTimer !== undefined) {
      clearTimeout(this.healRetryTimer)
      this.healRetryTimer = undefined
    }
    this.healInFlight = true
    // A persisted replica's cursor stands in for null on the very first fetch
    // only (warm reload → delta, not the world). Once spent — whatever the
    // outcome — the live cursor owns every subsequent heal.
    const since =
      this.metadataCursor ?? (this.initialCursorSpent ? null : (this.opts.initialCursor ?? null))
    this.initialCursorSpent = true
    // Runtime validation of the heal result ([spec:SP-3fe2] #247): the WS
    // frames parse leniently, but this HTTP result used to be consumed on
    // trust — a known-kind row with a malformed value installed into the UI
    // lists and the cursor skipped it permanently. A malformed delta escalates
    // to a SNAPSHOT heal (null-cursor refetch, the server's own corrupt-row
    // fallback); a malformed snapshot rejects into the normal retry path.
    // Never install, never advance past a row we could not validate.
    const fetchValidated = async (): Promise<SyncChangesSinceResultLenient> => {
      const first = parseChangesSinceResult(await fetch(since), { fromCursor: since })
      if (first !== null) return first
      if (since !== null) {
        const snap = parseChangesSinceResult(await fetch(null))
        // Only a full snapshot may satisfy the escalation — a shape-valid
        // delta (e.g. empty with a later cursor) would skip the malformed
        // rows permanently instead of replacing the untrusted state.
        if (snap !== null && snap.kind === 'snapshot') return snap
      }
      throw new Error('malformed changesSince result')
    }
    fetchValidated().then(
      (result) => {
        this.healInFlight = false
        if (result.kind === 'snapshot') {
          this.sessionList = result.sessions
          this.issueList = result.issues
          this.conversationList = result.conversations
          this.emit('sessions', this.sessionList)
          this.emit('issues', this.issueList)
          this.emit('conversations', this.conversationList)
        } else if (result.changes.length > 0) {
          this.applyChanges(result.changes.filter((c) => c.seq > (this.metadataCursor ?? 0)))
        }
        this.metadataCursor = result.cursor
        const queued = this.pendingDeltas.splice(0)
        for (let i = 0; i < queued.length; i++) {
          if (!this.applyDelta(queued[i] as MetadataDeltaMessageLenient)) {
            // Still gapped (changes raced past between the fetch and now): requeue
            // the rest and go around again. The re-entered heal emits the persist
            // hook once it settles — no intermediate emit for the torn state.
            this.pendingDeltas = queued.slice(i)
            this.healMetadata()
            return
          }
        }
        this.emitMetadataApplied()
      },
      () => {
        this.healInFlight = false
        // Bound the offline queue: after a failed heal these are all stale-or-future;
        // the eventual successful heal supersedes them.
        this.pendingDeltas = []
        if (this.connectedFlag && this.healRetryTimer === undefined) {
          this.healRetryTimer = setTimeout(() => {
            this.healRetryTimer = undefined
            this.healMetadata()
          }, HEAL_RETRY_MS)
        }
      },
    )
  }

  private notifyConnections(): void {
    for (const c of this.connections.values()) c._notifyHubChange()
  }

  private sendRaw(msg: Parameters<typeof encode>[0]): void {
    // Only send on an OPEN socket. connectedFlag is true exactly between onopen and
    // close, so a send issued while the socket is still CONNECTING (or already
    // closing) is queued instead of throwing InvalidStateError — the crash that
    // otherwise tears down the whole connection over a slow link. onopen flushes it.
    if (this.connectedFlag) {
      this.socket?.send(encode(msg))
    } else if (this.socket && this.preOpenQueue.length < INPUT_QUEUE_CAP) {
      this.preOpenQueue.push(msg)
    }
  }
}

/** The ServerMessage members addressed to a single session's terminal stream —
 *  the subset the hub forwards into SessionConnection._ingest. */
export type SessionScopedServerMessage = Extract<
  ServerMessage,
  { type: 'attached' | 'outputFrame' | 'controllerChanged' | 'geometry' | 'agentExit' }
>

/** A per-session view of the hub: tagged sends + the session's authoritative state. */
export class SessionConnection {
  readonly sessionId: string
  private readonly hub: SocketHub
  private cb: SessionCallbacks
  private controllerId: string | null = null
  private cols: number
  private rows: number
  private epoch = 0
  private lastSeq = -1
  private readonly echo = new EchoLatencyTracker()

  constructor(
    hub: SocketHub,
    sessionId: string,
    cb: SessionCallbacks,
    viewport: ConnectionViewport,
  ) {
    this.hub = hub
    this.sessionId = sessionId
    this.cb = cb
    this.cols = viewport.cols
    this.rows = viewport.rows
  }

  setCallbacks(cb: SessionCallbacks): void {
    this.cb = cb
  }

  /** Last outputFrame seq rendered — the resume cursor the hub sends on reconnect. */
  get resumeCursor(): number {
    return this.lastSeq
  }

  sendInput(bytes: string): void {
    this.echo.onInput(Date.now())
    this.hub._sendInput({ type: 'input', sessionId: this.sessionId, data: utf8ToBase64(bytes) })
  }

  /** Keystroke→echo latency over the last 30s — see {@link EchoLatencyTracker}. */
  echoLatency(): EchoLatencyStats {
    return this.echo.stats(Date.now())
  }

  sendResize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.hub._send({ type: 'resize', sessionId: this.sessionId, cols, rows })
  }

  requestControl(): void {
    this.hub._send({ type: 'requestControl', sessionId: this.sessionId })
  }

  redraw(): void {
    this.hub._send({ type: 'redrawRequest', sessionId: this.sessionId })
  }

  state(): ConnectionState {
    const clientId = this.hub.clientId
    return {
      connected: this.hub.connected,
      clientId,
      controllerId: this.controllerId,
      sessionId: this.sessionId,
      role: clientId !== '' && clientId === this.controllerId ? 'controller' : 'spectator',
      cols: this.cols,
      rows: this.rows,
      epoch: this.epoch,
      lastSeq: this.lastSeq,
    }
  }

  /** @internal Hub-internal: apply a session-scoped server message. */
  _ingest(msg: SessionScopedServerMessage): void {
    this.dispatchSessionMessage(msg, undefined)
  }

  /** Total dispatch over the session-scoped subunion [spec:SP-3fe2] — the same
   *  compile-checked exhaustiveness as the hub's table, replacing the switch. */
  private readonly dispatchSessionMessage = createDispatcher<SessionScopedServerMessage>({
    attached: (msg) => {
      this.controllerId = msg.controllerId
      this.cols = msg.geometry.cols
      this.rows = msg.geometry.rows
      this.epoch = msg.epoch
      // A full replay (not a `resumed` catch-up) is about to re-send the whole
      // buffer: clear the screen first so it rebuilds cleanly. A resume keeps the
      // screen and appends the missed frames.
      if (msg.resumed !== true) this.cb.onReset?.()
      this.emit()
      this.cb.onAttached?.()
    },
    outputFrame: (msg) => {
      this.lastSeq = msg.seq
      this.epoch = msg.epoch
      this.echo.onOutput(Date.now())
      this.emit()
      this.cb.onFrame?.(fromBase64Utf8(msg.data))
    },
    controllerChanged: (msg) => {
      this.controllerId = msg.controllerId
      this.cols = msg.geometry.cols
      this.rows = msg.geometry.rows
      this.emit()
    },
    geometry: (msg) => {
      this.cols = msg.cols
      this.rows = msg.rows
      this.emit()
    },
    agentExit: () => {
      this.emit()
    },
  })

  /** @internal Hub-internal: connection/clientId changed → recompute role. */
  _notifyHubChange(): void {
    this.emit()
  }

  private emit(): void {
    this.cb.onState?.(this.state())
  }
}
