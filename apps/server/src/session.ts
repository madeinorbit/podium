import type {
  AgentKind,
  AgentRuntimeState,
  ControlMessage,
  Geometry,
  ResumeRef,
  ServerMessage,
  SessionMeta,
  SessionOrigin,
  TranscriptItem,
  WorkState,
} from '@podium/protocol'
import { WorkState as WorkStateSchema } from '@podium/protocol'
import type { SessionRow } from './store'

export type Send<T> = (msg: T) => void

export interface ClientConn {
  id: string
  send: Send<ServerMessage>
  viewport: Geometry
  attached: Set<string>
  /** Page-visibility presence — drives smart notification routing. */
  visible: boolean
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
  name?: string
  archived?: boolean
  workState?: WorkState
}

// Replay-on-attach: keep a bounded buffer of recent agent output so a freshly attached
// or re-mounted client reconstructs the screen instead of starting blank. Redraw (a
// SIGWINCH nudge) covers alt-screen TUIs that fully repaint; this covers normal-buffer
// apps (shells, Ink) whose scrollback a redraw cannot recreate. Reset on a screen clear
// or alt-screen transition keeps the buffer small and aligned to the current screen.
const MAX_REPLAY_BYTES = 256 * 1024
// Bounded structured-transcript buffer per session — late subscribers get this.
const MAX_TRANSCRIPT_ITEMS = 3000
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
  /** How to bring this session back after its process is gone (hibernate→resume).
   *  Set at spawn for resumes; learned later from the daemon for fresh spawns. */
  resume?: ResumeRef
  lastActiveAt: string
  title: string
  /** User-set name; empty = fall back to the live title. */
  name = ''
  archived = false
  workState: WorkState | undefined
  cmd = ''
  status: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited' = 'starting'
  exitCode: number | undefined
  agentState: AgentRuntimeState | undefined
  /** True once a structured transcript has been seen — drives chat capability. */
  transcriptAvailable = false
  geometry: Geometry
  epoch = 0
  controllerId: string | null = null
  private readonly toDaemon: Send<ControlMessage>
  private readonly clients = new Map<string, ClientConn>()
  // Recent agent output (base64 frames) for replay-on-attach; bounded by MAX_REPLAY_BYTES.
  private readonly outputLog: { seq: number; data: string }[] = []
  private outputLogBytes = 0
  // Structured transcript buffer (chat view) + which clients want its stream.
  // Holds the connection (not just the id): a chat-only client subscribes
  // without ever attaching to the PTY.
  private transcript: TranscriptItem[] = []
  private readonly transcriptSubscribers = new Map<string, ClientConn>()

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
    if (init.name) this.name = init.name
    if (init.archived) this.archived = init.archived
    if (init.workState) this.workState = init.workState
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

  /** Subscribe a client to the structured transcript: snapshot now, appends after. */
  subscribeTranscript(client: ClientConn): void {
    this.transcriptSubscribers.set(client.id, client)
    client.send({
      type: 'transcriptSnapshot',
      sessionId: this.sessionId,
      items: this.transcript,
    })
  }

  unsubscribeTranscript(clientId: string): void {
    this.transcriptSubscribers.delete(clientId)
  }

  /** The buffered structured transcript (superagent tools read this). */
  transcriptItems(): TranscriptItem[] {
    return this.transcript
  }

  /** Daemon pushed parsed transcript items; buffer (bounded) and fan out.
   *  Returns true the first time a transcript is observed (the chat-capability
   *  transition), so the registry can broadcast the updated SessionMeta. */
  appendTranscript(items: TranscriptItem[], reset: boolean): boolean {
    const becameAvailable =
      !this.transcriptAvailable && (items.length > 0 || this.transcript.length > 0)
    if (becameAvailable) this.transcriptAvailable = true
    if (reset) this.transcript = []
    this.transcript = this.transcript.concat(items)
    if (this.transcript.length > MAX_TRANSCRIPT_ITEMS) {
      this.transcript = this.transcript.slice(-MAX_TRANSCRIPT_ITEMS)
    }
    for (const client of this.transcriptSubscribers.values()) {
      if (reset) {
        client.send({
          type: 'transcriptSnapshot',
          sessionId: this.sessionId,
          items: this.transcript,
        })
      } else {
        client.send({ type: 'transcriptAppend', sessionId: this.sessionId, items })
      }
    }
    return becameAvailable
  }

  detachClient(clientId: string): void {
    this.clients.delete(clientId)
    this.transcriptSubscribers.delete(clientId)
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
    // A hibernated session's process exit is the *expected* result of the
    // hibernate kill — don't let it overwrite the hibernated state.
    if (this.status === 'hibernated') return
    this.status = 'exited'
    this.exitCode = code
    // The harness-observed phase described a running agent; that agent is gone.
    // Leaving it set would make the home board / superagent / Continue button
    // keep treating a dead session as 'working' or 'errored'.
    this.agentState = undefined
    this.broadcast({ type: 'agentExit', sessionId: this.sessionId, code })
  }

  /** A spawn that never started — surface as an exit so attached clients stop waiting. */
  markSpawnError(message: string): void {
    this.status = 'exited'
    this.exitCode = -1
    this.agentState = undefined
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
    // 'exited' is included on purpose: a reattach only produces a bind when the
    // daemon found the durable master alive. That means the row was wrongly
    // marked exited — its attach client died on a daemon restart while the agent
    // survived in its scope. The live master is authoritative, so clear the stale
    // exit and bring the session back.
    if (this.status === 'starting' || this.status === 'reconnecting' || this.status === 'exited') {
      this.status = 'live'
      this.exitCode = undefined
    }
    // Adopt the daemon's geometry only if no controller has resized us yet.
    if (this.controllerId === null) this.geometry = { ...geometry }
  }

  toRow(): SessionRow {
    return {
      id: this.sessionId,
      agentKind: this.agentKind,
      cwd: this.cwd,
      title: this.title,
      name: this.name || null,
      archived: this.archived,
      workState: this.workState ?? null,
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
      ...(this.name ? { name: this.name } : {}),
      cwd: this.cwd,
      status: this.status,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.agentState ? { agentState: this.agentState } : {}),
      controllerId: this.controllerId,
      geometry: { ...this.geometry },
      epoch: this.epoch,
      clientCount: this.clients.size,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      origin: this.origin,
      archived: this.archived,
      ...(this.workState ? { workState: this.workState } : {}),
      ...(this.resume ? { resumable: true } : {}),
      ...(this.transcriptAvailable ? { transcriptAvailable: true } : {}),
    }
  }

  /** Parse a persisted work_state column; unknown strings read as unsorted. */
  static parseWorkState(raw: string | null): WorkState | undefined {
    if (raw === null) return undefined
    const parsed = WorkStateSchema.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients.values()) c.send(msg)
  }
}
