import type {
  AgentKind,
  AgentRuntimeState,
  ControlMessage,
  Geometry,
  ResumeRef,
  ServerMessage,
  SessionMeta,
  SessionOrigin,
} from '@podium/protocol'
import type { SessionRow } from './store'

export type Send<T> = (msg: T) => void

export interface ClientConn {
  id: string
  send: Send<ServerMessage>
  viewport: Geometry
  attached: Set<string>
}

export interface SessionInit {
  sessionId: string
  agentKind: AgentKind
  cwd: string
  title: string
  origin: SessionOrigin
  createdAt: string
  geometry: Geometry
  toDaemon: Send<ControlMessage>
  resume?: ResumeRef
  durableLabel?: string
  lastActiveAt?: string
  status?: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'
  exitCode?: number
}

// Replay-on-attach: keep a bounded buffer of recent agent output so a freshly attached
// or re-mounted client reconstructs the screen instead of starting blank. Redraw (a
// SIGWINCH nudge) covers alt-screen TUIs that fully repaint; this covers normal-buffer
// apps (shells, Ink) whose scrollback a redraw cannot recreate. Reset on a screen clear
// or alt-screen transition keeps the buffer small and aligned to the current screen.
const MAX_REPLAY_BYTES = 256 * 1024
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const SCREEN_RESET = /\x1b\[[23]J|\x1bc|\x1b\[\?1049[hl]/

/** One agent's relay state: controller gating, geometry/epoch, and its attached clients. */
export class Session {
  readonly sessionId: string
  readonly agentKind: AgentKind
  readonly cwd: string
  readonly origin: SessionOrigin
  readonly createdAt: string
  readonly durableLabel: string
  readonly resume?: ResumeRef
  lastActiveAt: string
  title: string
  cmd = ''
  status: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited' = 'starting'
  exitCode: number | undefined
  agentState: AgentRuntimeState | undefined
  geometry: Geometry
  epoch = 0
  controllerId: string | null = null
  private readonly toDaemon: Send<ControlMessage>
  private readonly clients = new Map<string, ClientConn>()
  // Recent agent output (base64 frames) for replay-on-attach; bounded by MAX_REPLAY_BYTES.
  private readonly outputLog: { seq: number; data: string }[] = []
  private outputLogBytes = 0

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId
    this.agentKind = init.agentKind
    this.cwd = init.cwd
    this.title = init.title
    this.origin = init.origin
    this.createdAt = init.createdAt
    this.geometry = { ...init.geometry }
    this.toDaemon = init.toDaemon
    this.durableLabel = init.durableLabel ?? `podium-${init.sessionId}`
    this.resume = init.resume
    this.lastActiveAt = init.lastActiveAt ?? init.createdAt
    if (init.status) this.status = init.status
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
  }

  get clientCount(): number {
    return this.clients.size
  }

  attachClient(client: ClientConn): void {
    this.clients.set(client.id, client)
    if (this.controllerId === null) this.controllerId = client.id
    client.send({
      type: 'attached',
      sessionId: this.sessionId,
      controllerId: this.controllerId,
      geometry: { ...this.geometry },
      epoch: this.epoch,
    })
    // Replay buffered output so this client reconstructs the current screen. Sent after
    // `attached` (whose epoch triggers a clean-slate clear) and before any live frames.
    for (const f of this.outputLog) {
      client.send({
        type: 'outputFrame',
        sessionId: this.sessionId,
        seq: f.seq,
        epoch: this.epoch,
        data: f.data,
      })
    }
  }

  detachClient(clientId: string): void {
    this.clients.delete(clientId)
    if (this.controllerId === clientId) {
      this.controllerId = this.clients.keys().next().value ?? null
      if (this.controllerId !== null) {
        this.broadcast({
          type: 'controllerChanged',
          sessionId: this.sessionId,
          controllerId: this.controllerId,
          geometry: { ...this.geometry },
        })
      }
    }
  }

  detachAll(): void {
    this.clients.clear()
    this.controllerId = null
  }

  handleInput(clientId: string, data: string): void {
    if (clientId === this.controllerId) {
      this.toDaemon({ type: 'input', sessionId: this.sessionId, data })
    }
  }

  handleResize(clientId: string, cols: number, rows: number): void {
    const client = this.clients.get(clientId)
    if (client) client.viewport = { cols, rows }
    if (clientId === this.controllerId) {
      this.geometry = { cols, rows }
      this.toDaemon({ type: 'resize', sessionId: this.sessionId, cols, rows })
    }
  }

  requestControl(clientId: string): void {
    if (!this.clients.has(clientId)) return
    this.controllerId = clientId
    this.geometry = { ...(this.clients.get(clientId)?.viewport ?? this.geometry) }
    this.epoch += 1
    this.toDaemon({
      type: 'resize',
      sessionId: this.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
    this.toDaemon({ type: 'redraw', sessionId: this.sessionId })
    this.broadcast({
      type: 'controllerChanged',
      sessionId: this.sessionId,
      controllerId: clientId,
      geometry: { ...this.geometry },
    })
    this.broadcast({
      type: 'geometry',
      sessionId: this.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
  }

  redraw(): void {
    this.toDaemon({ type: 'redraw', sessionId: this.sessionId })
  }

  onFrame(seq: number, data: string): void {
    this.bufferFrame(seq, data)
    this.broadcast({ type: 'outputFrame', sessionId: this.sessionId, seq, epoch: this.epoch, data })
  }

  private bufferFrame(seq: number, data: string): void {
    // A screen clear / alt-screen switch makes prior frames irrelevant: drop them so the
    // buffer stays aligned to the current screen (and bounded for full-screen TUIs).
    if (SCREEN_RESET.test(Buffer.from(data, 'base64').toString('latin1'))) {
      this.outputLog.length = 0
      this.outputLogBytes = 0
    }
    this.outputLog.push({ seq, data })
    this.outputLogBytes += data.length
    while (this.outputLogBytes > MAX_REPLAY_BYTES && this.outputLog.length > 1) {
      const dropped = this.outputLog.shift()
      if (dropped) this.outputLogBytes -= dropped.data.length
    }
  }

  onExit(code: number): void {
    this.status = 'exited'
    this.exitCode = code
    this.broadcast({ type: 'agentExit', sessionId: this.sessionId, code })
  }

  /** A spawn that never started — surface as an exit so attached clients stop waiting. */
  markSpawnError(message: string): void {
    this.status = 'exited'
    this.exitCode = -1
    console.warn(`[podium] spawn failed for ${this.sessionId}: ${message}`)
    this.broadcast({ type: 'agentExit', sessionId: this.sessionId, code: -1 })
  }

  /** Adopt a live terminal title the agent set (OSC). Replaces the cwd-derived default. */
  /** Harness-observed runtime state (hooks-driven). Not persisted — it's live-only. */
  setAgentState(state: AgentRuntimeState): void {
    this.lastActiveAt = new Date().toISOString()
    this.agentState = state
  }

  setTitle(title: string): void {
    this.lastActiveAt = new Date().toISOString()
    this.title = title
  }

  markLive(cmd: string, geometry: Geometry): void {
    this.lastActiveAt = new Date().toISOString()
    this.cmd = cmd
    if (this.status === 'starting' || this.status === 'reconnecting') this.status = 'live'
    // Adopt the daemon's geometry only if no controller has resized us yet.
    if (this.controllerId === null) this.geometry = { ...geometry }
  }

  toRow(): SessionRow {
    return {
      id: this.sessionId,
      agentKind: this.agentKind,
      cwd: this.cwd,
      title: this.title,
      originKind: this.origin.kind,
      conversationId: this.origin.kind === 'resume' ? this.origin.conversationId : null,
      resumeKind: this.resume?.kind ?? null,
      resumeValue: this.resume?.value ?? null,
      status: this.status,
      exitCode: this.exitCode ?? null,
      durableLabel: this.durableLabel,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    }
  }

  toMeta(): SessionMeta {
    return {
      sessionId: this.sessionId,
      agentKind: this.agentKind,
      title: this.title,
      cwd: this.cwd,
      status: this.status,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.agentState ? { agentState: this.agentState } : {}),
      controllerId: this.controllerId,
      geometry: { ...this.geometry },
      epoch: this.epoch,
      clientCount: this.clients.size,
      createdAt: this.createdAt,
      origin: this.origin,
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients.values()) c.send(msg)
  }
}
