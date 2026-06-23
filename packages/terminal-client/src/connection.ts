import {
  type ConversationSummaryWire,
  encode,
  type HostMetricsWire,
  type IssueWire,
  type MachineWire,
  parseServerMessageLenient,
  type ServerMessage,
  type SessionMeta,
  type TranscriptItem,
} from '@podium/protocol'

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
  private issueList: IssueWire[] = []
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
  private staleTimer: ReturnType<typeof setTimeout> | undefined
  private lastRttMs: number | null = null
  private health: ConnectionHealth = { status: 'ok', rttMs: null, since: Date.now() }
  private readonly connections = new Map<string, SessionConnection>()
  // Per-session structured transcript subscriptions. The hub is a thin
  // delta-forwarder: it holds NO buffered items (ChatView owns history, seeded
  // from a tRPC read). It tracks only `since` — the cursor of the newest item
  // forwarded so far — so a reconnect can resume the live stream from that point.
  // An entry exists while at least one observer is subscribed.
  private readonly transcripts = new Map<
    string,
    {
      since: string | undefined
      observers: Set<(items: TranscriptItem[], meta: { reset: boolean }) => void>
    }
  >()
  private readonly sessionObservers = new Set<(s: SessionMeta[]) => void>()
  private readonly conversationObservers = new Set<(c: ConversationSummaryWire[]) => void>()
  private readonly hostMetricsObservers = new Set<(h: HostMetricsWire[]) => void>()
  private readonly machinesObservers = new Set<(m: MachineWire[]) => void>()
  private readonly issueObservers = new Set<(i: IssueWire[]) => void>()
  private readonly issueUpdatedObservers = new Set<(i: IssueWire) => void>()
  private readonly healthObservers = new Set<(h: ConnectionHealth) => void>()
  private readonly attentionObservers = new Set<(e: AttentionEvent) => void>()
  private draftObservers = new Set<(sessionId: string, text: string) => void>()
  private lastVisible = true

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
      })
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
      // Flush keystrokes typed during the outage — after the re-attaches above, so
      // the session exists and this (reclaimed) client is the controller again
      // before its input lands.
      for (const msg of this.inputQueue.splice(0)) this.sendRaw(msg)
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

  sessions(): SessionMeta[] {
    return this.sessionList
  }

  onSessions(cb: (s: SessionMeta[]) => void): () => void {
    this.sessionObservers.add(cb)
    cb(this.sessionList)
    return () => this.sessionObservers.delete(cb)
  }

  conversations(): ConversationSummaryWire[] {
    return this.conversationList
  }

  onConversations(cb: (c: ConversationSummaryWire[]) => void): () => void {
    this.conversationObservers.add(cb)
    cb(this.conversationList)
    return () => this.conversationObservers.delete(cb)
  }

  hostMetrics(): HostMetricsWire[] {
    return this.hostMetricsList
  }

  onHostMetrics(cb: (h: HostMetricsWire[]) => void): () => void {
    this.hostMetricsObservers.add(cb)
    cb(this.hostMetricsList)
    return () => this.hostMetricsObservers.delete(cb)
  }

  machines(): MachineWire[] {
    return this.machinesList
  }

  onMachines(cb: (m: MachineWire[]) => void): () => void {
    this.machinesObservers.add(cb)
    cb(this.machinesList)
    return () => this.machinesObservers.delete(cb)
  }

  issues(): IssueWire[] {
    return this.issueList
  }

  /** Observe the full issue list. Replays the current list immediately, like `onSessions`. */
  onIssues(cb: (i: IssueWire[]) => void): () => void {
    this.issueObservers.add(cb)
    cb(this.issueList)
    return () => this.issueObservers.delete(cb)
  }

  /** Observe single-issue updates (no immediate replay; mirrors `onAttention`). */
  onIssueUpdated(cb: (i: IssueWire) => void): () => void {
    this.issueUpdatedObservers.add(cb)
    return () => this.issueUpdatedObservers.delete(cb)
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
      entry = { since, observers: new Set() }
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
        this.transcripts.delete(sessionId)
        if (this.connectedFlag) this.sendRaw({ type: 'transcriptUnsubscribe', sessionId })
      }
    }
  }

  /** Attention events (agent needs the human) — the app turns these into notifications. */
  onAttention(cb: (e: AttentionEvent) => void): () => void {
    this.attentionObservers.add(cb)
    return () => this.attentionObservers.delete(cb)
  }

  /** Subscribe to draft changes broadcast by other clients/devices. Returns an unsubscribe. */
  onSessionDraft(cb: (sessionId: string, text: string) => void): () => void {
    this.draftObservers.add(cb)
    return () => this.draftObservers.delete(cb)
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

  connectionHealth(): ConnectionHealth {
    return this.health
  }

  onConnectionHealth(cb: (h: ConnectionHealth) => void): () => void {
    this.healthObservers.add(cb)
    cb(this.health)
    return () => this.healthObservers.delete(cb)
  }

  private evaluateHealth(): void {
    const next = this.computeHealth()
    if (next.status === this.health.status && next.rttMs === this.health.rttMs) return
    // A status that merely re-confirms keeps its start time — `since` marks the
    // transition, not the latest re-evaluation.
    this.health = next.status === this.health.status ? { ...next, since: this.health.since } : next
    for (const o of this.healthObservers) o(this.health)
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
    let msg: ServerMessage | null
    try {
      // Lenient parse: for the collection-bearing messages, one poisoned element
      // (e.g. a session with an out-of-enum agentKind) is quarantined instead of
      // failing the whole batch — otherwise a single bad row blanks an entire list.
      const result = parseServerMessageLenient(raw)
      msg = result.message
      if (result.dropped > 0) {
        // Never silent: a swallowed drop here was what turned a one-row data bug into
        // an invisible, blank-UI outage. Make every quarantine observable.
        console.warn(`[podium] quarantined ${result.dropped} invalid item(s) in a ${msg?.type ?? '?'} message`)
      }
    } catch (err) {
      console.warn('[podium] dropped an unparseable server message', err)
      return
    }
    if (!msg) return
    if (msg.type === 'pong') {
      // Liveness was already recorded in onmessage; here the pong closes out the
      // oldest in-flight ping to yield a round-trip sample.
      const sentAt = this.pingQueue.shift()
      if (sentAt !== undefined) {
        this.lastRttMs = Date.now() - sentAt
        if (this.pingQueue.length === 0) this.clearStaleTimer()
        this.evaluateHealth()
      }
      return
    }
    if (msg.type === 'welcome') {
      this.clientIdValue = msg.clientId
      this.notifyConnections()
      return
    }
    if (msg.type === 'sessionsChanged') {
      this.sessionList = msg.sessions
      for (const o of this.sessionObservers) o(this.sessionList)
      return
    }
    if (msg.type === 'conversationsChanged') {
      this.conversationList = msg.conversations
      for (const o of this.conversationObservers) o(this.conversationList)
      return
    }
    if (msg.type === 'hostMetricsChanged') {
      this.hostMetricsList = msg.hosts
      for (const o of this.hostMetricsObservers) o(this.hostMetricsList)
      return
    }
    if (msg.type === 'issuesChanged') {
      this.issueList = msg.issues
      for (const o of this.issueObservers) o(this.issueList)
      return
    }
    if (msg.type === 'issueUpdated') {
      this.issueList = this.issueList.map((i) => (i.id === msg.issue.id ? msg.issue : i))
      for (const o of this.issueObservers) o(this.issueList)
      for (const o of this.issueUpdatedObservers) o(msg.issue)
      return
    }
    if (msg.type === 'attentionEvent') {
      for (const o of this.attentionObservers) {
        o({ sessionId: msg.sessionId, title: msg.title, body: msg.body })
      }
      return
    }
    if (msg.type === 'transcriptDelta') {
      const entry = this.transcripts.get(msg.sessionId)
      if (!entry) return
      // Track the newest cursor so a reconnect resumes from here. A reset frame
      // re-seeds: keep the new tail too (the caller re-reads its window).
      if (msg.tail) entry.since = msg.tail
      const reset = msg.reset ?? false
      for (const o of entry.observers) o(msg.items, { reset })
      return
    }
    if (msg.type === 'sessionTitleChanged') {
      let changed = false
      this.sessionList = this.sessionList.map((s) => {
        if (s.sessionId !== msg.sessionId || s.title === msg.title) return s
        changed = true
        return { ...s, title: msg.title }
      })
      if (changed) for (const o of this.sessionObservers) o(this.sessionList)
      return
    }
    if (msg.type === 'sessionDraftChanged') {
      for (const o of this.draftObservers) o(msg.sessionId, msg.text)
      return
    }
    if (msg.type === 'sessionAgentStateChanged') {
      let changed = false
      this.sessionList = this.sessionList.map((s) => {
        if (s.sessionId !== msg.sessionId) return s
        changed = true
        return { ...s, agentState: msg.state }
      })
      if (changed) for (const o of this.sessionObservers) o(this.sessionList)
      return
    }
    if (msg.type === 'machinesChanged') {
      this.machinesList = msg.machines
      for (const o of this.machinesObservers) o(this.machinesList)
      return
    }
    this.connections.get(msg.sessionId)?._ingest(msg)
  }

  private notifyConnections(): void {
    for (const c of this.connections.values()) c._notifyHubChange()
  }

  private sendRaw(msg: Parameters<typeof encode>[0]): void {
    this.socket?.send(encode(msg))
  }
}

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
    this.hub._sendInput({ type: 'input', sessionId: this.sessionId, data: utf8ToBase64(bytes) })
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
  _ingest(msg: ServerMessage): void {
    switch (msg.type) {
      case 'attached':
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
        break
      case 'outputFrame':
        this.lastSeq = msg.seq
        this.epoch = msg.epoch
        this.emit()
        this.cb.onFrame?.(fromBase64Utf8(msg.data))
        break
      case 'controllerChanged':
        this.controllerId = msg.controllerId
        this.cols = msg.geometry.cols
        this.rows = msg.geometry.rows
        this.emit()
        break
      case 'geometry':
        this.cols = msg.cols
        this.rows = msg.rows
        this.emit()
        break
      case 'agentExit':
        this.emit()
        break
      default:
        break
    }
  }

  /** @internal Hub-internal: connection/clientId changed → recompute role. */
  _notifyHubChange(): void {
    this.emit()
  }

  private emit(): void {
    this.cb.onState?.(this.state())
  }
}
