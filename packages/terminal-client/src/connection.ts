import { encode, parseServerMessage } from '@podium/protocol'

export interface WebSocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
}

export interface ConnectionViewport {
  cols: number
  rows: number
  dpr: number
}

export interface ConnectionState {
  connected: boolean
  clientId: string
  controllerId: string
  sessionId: string
  role: 'controller' | 'spectator'
  cols: number
  rows: number
  epoch: number
  lastSeq: number
}

export interface SessionConnectionOptions {
  url: string
  viewport: ConnectionViewport
  makeSocket?: (url: string) => WebSocketLike
  onFrame?: (text: string) => void
  onState?: (state: ConnectionState) => void
}

function toBase64(bytes: string): string {
  return btoa(bytes)
}

function fromBase64Utf8(b64: string): string {
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export class SessionConnection {
  private readonly opts: SessionConnectionOptions
  private readonly makeSocket: (url: string) => WebSocketLike
  private socket: WebSocketLike | undefined
  private viewport: ConnectionViewport
  private connected = false
  private clientId = ''
  private controllerId = ''
  private sessionId = ''
  private cols: number
  private rows: number
  private epoch = 0
  private lastSeq = -1

  constructor(opts: SessionConnectionOptions) {
    this.opts = opts
    this.makeSocket = opts.makeSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
    this.viewport = { ...opts.viewport }
    this.cols = opts.viewport.cols
    this.rows = opts.viewport.rows
  }

  connect(): void {
    const socket = this.makeSocket(this.opts.url)
    this.socket = socket
    socket.onopen = () => {
      this.connected = true
      this.sendRaw({ type: 'hello', clientId: this.clientId, viewport: { ...this.viewport } })
      this.sendRaw({ type: 'redrawRequest' })
      this.emitState()
    }
    socket.onmessage = (ev) => this.onServerMessage(String(ev.data))
    socket.onclose = () => {
      this.connected = false
      this.emitState()
    }
  }

  sendInput(bytes: string): void {
    this.sendRaw({ type: 'input', data: toBase64(bytes) })
  }

  sendResize(cols: number, rows: number): void {
    this.viewport = { ...this.viewport, cols, rows }
    this.cols = cols
    this.rows = rows
    this.sendRaw({ type: 'resize', cols, rows })
  }

  requestControl(): void {
    this.sendRaw({ type: 'requestControl' })
  }

  redraw(): void {
    this.sendRaw({ type: 'redrawRequest' })
  }

  state(): ConnectionState {
    return {
      connected: this.connected,
      clientId: this.clientId,
      controllerId: this.controllerId,
      sessionId: this.sessionId,
      role: this.clientId !== '' && this.clientId === this.controllerId ? 'controller' : 'spectator',
      cols: this.cols,
      rows: this.rows,
      epoch: this.epoch,
      lastSeq: this.lastSeq,
    }
  }

  dispose(): void {
    this.socket?.close()
    this.socket = undefined
    this.connected = false
    this.emitState()
  }

  private onServerMessage(raw: string): void {
    let msg: ReturnType<typeof parseServerMessage>
    try {
      msg = parseServerMessage(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case 'welcome':
        this.clientId = msg.clientId
        this.sessionId = msg.sessionId
        this.controllerId = msg.controllerId
        this.cols = msg.geometry.cols
        this.rows = msg.geometry.rows
        break
      case 'outputFrame':
        this.lastSeq = msg.seq
        this.epoch = msg.epoch
        this.opts.onFrame?.(fromBase64Utf8(msg.data))
        break
      case 'controllerChanged':
        this.controllerId = msg.controllerId
        this.cols = msg.geometry.cols
        this.rows = msg.geometry.rows
        break
      case 'geometry':
        this.cols = msg.cols
        this.rows = msg.rows
        break
      case 'agentExit':
        break
    }
    this.emitState()
  }

  private sendRaw(msg: Parameters<typeof encode>[0]): void {
    this.socket?.send(encode(msg))
  }

  private emitState(): void {
    this.opts.onState?.(this.state())
  }
}
