import {
  type ConversationSummaryWire,
  encode,
  type HostMetricsWire,
  parseServerMessage,
  type ServerMessage,
  type SessionMeta,
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
  private intentionalClose = false
  private readonly connections = new Map<string, SessionConnection>()
  private readonly sessionObservers = new Set<(s: SessionMeta[]) => void>()
  private readonly conversationObservers = new Set<(c: ConversationSummaryWire[]) => void>()
  private readonly hostMetricsObservers = new Set<(h: HostMetricsWire[]) => void>()

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

    let socket: WebSocketLike
    try {
      socket = this.makeSocket(this.opts.url)
    } catch (err) {
      this.opts.onError?.(errorMessage(err, 'WebSocket connection failed'), err)
      return
    }

    let opened = false
    let reportedError = false
    this.intentionalClose = false
    this.socket = socket
    socket.onopen = () => {
      opened = true
      this.connectedFlag = true
      this.sendRaw({
        type: 'hello',
        clientId: this.clientIdValue,
        viewport: { ...this.opts.viewport },
      })
      for (const sessionId of this.connections.keys()) this.sendRaw({ type: 'attach', sessionId })
      this.notifyConnections()
    }
    socket.onmessage = (ev) => this.route(String(ev.data))
    socket.onerror = (ev) => {
      reportedError = true
      this.opts.onError?.('WebSocket connection failed', ev)
    }
    socket.onclose = () => {
      if (!this.intentionalClose && !opened && !reportedError) {
        this.opts.onError?.('WebSocket connection closed before connecting')
      }
      this.connectedFlag = false
      this.socket = undefined
      this.notifyConnections()
    }
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

  /** @internal Used by SessionConnection to send its sessionId-tagged messages. */
  _send(msg: Parameters<typeof encode>[0]): void {
    this.sendRaw(msg)
  }

  dispose(): void {
    this.intentionalClose = true
    this.socket?.close()
    this.socket = undefined
    this.connectedFlag = false
    this.notifyConnections()
  }

  private route(raw: string): void {
    let msg: ServerMessage
    try {
      msg = parseServerMessage(raw)
    } catch {
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

  sendInput(bytes: string): void {
    this.hub._send({ type: 'input', sessionId: this.sessionId, data: utf8ToBase64(bytes) })
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
        this.emit()
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
