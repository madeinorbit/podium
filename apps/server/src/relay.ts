import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  AgentKind,
  ClientMessage,
  ControlMessage,
  ConversationDiagnosticWire,
  ConversationSummaryWire,
  DaemonMessage,
  Geometry,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  ResumeRef,
  ServerMessage,
  SessionMeta,
} from '@podium/protocol'
import { type ClientConn, type Send, Session } from './session'
import { SessionStore } from './store'

const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 }
const SCAN_TIMEOUT_MS = 10_000

export interface ScanResult {
  conversations: ConversationSummaryWire[]
  diagnostics: ConversationDiagnosticWire[]
}

export interface ScanReposResult {
  repositories: GitRepositoryWire[]
  diagnostics: GitDiscoveryDiagnosticWire[]
}

/** Registry of all sessions + the single daemon link + all client connections. Routes by sessionId. */
export class SessionRegistry {
  private daemonSend: Send<ControlMessage> | undefined
  private readonly sessions = new Map<string, Session>()
  private readonly clients = new Map<string, ClientConn>()
  private readonly pendingScans = new Map<string, (r: ScanResult) => void>()
  private readonly pendingRepoScans = new Map<string, (r: ScanReposResult) => void>()
  private nextClientNum = 0
  // Shared by scan() ('r' prefix) and scanRepos() ('rr' prefix). Each scan
  // variant must use a distinct string prefix so ids never collide across the
  // separate pending maps.
  private nextRequestNum = 0

  constructor(private readonly store: SessionStore = new SessionStore(':memory:')) {
    this.loadFromStore()
  }

  private persist(session: Session): void {
    this.store.upsertSession(session.toRow())
  }

  private loadFromStore(): void {
    // Implemented in Task 7.
  }

  attachDaemon(send: Send<ControlMessage>): void {
    this.daemonSend = send
  }
  detachDaemon(): void {
    this.daemonSend = undefined
  }
  private readonly toDaemon: Send<ControlMessage> = (msg) => this.daemonSend?.(msg)

  // ---- tRPC control plane ----
  listSessions(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => s.toMeta())
  }

  createSession(input: { agentKind: AgentKind; cwd: string; title?: string }): {
    sessionId: string
  } {
    return this.spawn({ ...input, origin: { kind: 'spawn' } })
  }

  resumeSession(input: {
    agentKind: AgentKind
    cwd: string
    resume: ResumeRef
    conversationId: string
    title?: string
  }): { sessionId: string } {
    return this.spawn({
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title,
      origin: { kind: 'resume', conversationId: input.conversationId },
      resume: input.resume,
    })
  }

  killSession(input: { sessionId: string }): void {
    this.toDaemon({ type: 'kill', sessionId: input.sessionId })
    this.sessions.get(input.sessionId)?.detachAll()
    this.sessions.delete(input.sessionId)
    this.store.deleteSession(input.sessionId)
    for (const c of this.clients.values()) c.attached.delete(input.sessionId)
    this.broadcastSessions()
  }

  scan(): Promise<ScanResult> {
    const requestId = `r${this.nextRequestNum++}`
    return new Promise<ScanResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingScans.delete(requestId)
        resolve({
          conversations: [],
          diagnostics: [{ severity: 'error', message: 'discovery scan timed out' }],
        })
      }, SCAN_TIMEOUT_MS)
      timer.unref?.()
      this.pendingScans.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.toDaemon({ type: 'scanRequest', requestId })
    })
  }

  scanRepos(
    roots: string[],
    opts: { includeHome?: boolean; maxDepth?: number } = {},
  ): Promise<ScanReposResult> {
    const requestId = `rr${this.nextRequestNum++}`
    return new Promise<ScanReposResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRepoScans.delete(requestId)
        resolve({
          repositories: [],
          diagnostics: [{ severity: 'error', path: '', message: 'repos scan timed out' }],
        })
      }, SCAN_TIMEOUT_MS)
      timer.unref?.()
      this.pendingRepoScans.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.toDaemon({
        type: 'scanReposRequest',
        requestId,
        roots,
        ...(opts.includeHome === undefined ? {} : { includeHome: opts.includeHome }),
        ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
      })
    })
  }

  private spawn(input: {
    agentKind: AgentKind
    cwd: string
    title?: string
    origin: SessionMeta['origin']
    resume?: ResumeRef
  }): { sessionId: string } {
    const sessionId = randomUUID()
    const session = new Session({
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
      origin: input.origin,
      createdAt: new Date().toISOString(),
      geometry: { ...DEFAULT_GEOMETRY },
      toDaemon: this.toDaemon,
      tmuxLabel: `podium-${sessionId}`,
      ...(input.resume ? { resume: input.resume } : {}),
    })
    this.sessions.set(sessionId, session)
    this.persist(session)
    this.toDaemon({
      type: 'spawn',
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      ...(input.resume ? { resume: input.resume } : {}),
      geometry: { ...DEFAULT_GEOMETRY },
    })
    this.broadcastSessions()
    return { sessionId }
  }

  // ---- ws data plane: clients ----
  attachClient(send: Send<ServerMessage>): string {
    const id = `c${this.nextClientNum++}`
    this.clients.set(id, { id, send, viewport: { ...DEFAULT_GEOMETRY }, attached: new Set() })
    send({ type: 'welcome', clientId: id })
    send({ type: 'sessionsChanged', sessions: this.listSessions() })
    return id
  }

  detachClient(id: string): void {
    const client = this.clients.get(id)
    if (!client) return
    for (const sessionId of client.attached) this.sessions.get(sessionId)?.detachClient(id)
    this.clients.delete(id)
    this.broadcastSessions()
  }

  onClientMessage(id: string, msg: ClientMessage): void {
    const client = this.clients.get(id)
    if (!client) return
    switch (msg.type) {
      case 'hello':
        client.viewport = { cols: msg.viewport.cols, rows: msg.viewport.rows }
        break
      case 'attach': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) return
        client.attached.add(msg.sessionId)
        session.attachClient(client)
        this.broadcastSessions()
        break
      }
      case 'detach':
        client.attached.delete(msg.sessionId)
        this.sessions.get(msg.sessionId)?.detachClient(id)
        this.broadcastSessions()
        break
      case 'input':
        this.sessions.get(msg.sessionId)?.handleInput(id, msg.data)
        break
      case 'resize':
        this.sessions.get(msg.sessionId)?.handleResize(id, msg.cols, msg.rows)
        break
      case 'requestControl':
        this.sessions.get(msg.sessionId)?.requestControl(id)
        this.broadcastSessions()
        break
      case 'redrawRequest':
        this.sessions.get(msg.sessionId)?.redraw()
        break
    }
  }

  // ---- ws data plane: daemon ----
  onDaemonMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case 'bind': {
        this.sessions.get(msg.sessionId)?.markLive(msg.cmd, msg.geometry)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        break
      }
      case 'agentFrame':
        this.sessions.get(msg.sessionId)?.onFrame(msg.seq, msg.data)
        break
      case 'agentExit': {
        this.sessions.get(msg.sessionId)?.onExit(msg.code)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        break
      }
      case 'spawnError': {
        this.sessions.get(msg.sessionId)?.markSpawnError(msg.message)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        break
      }
      case 'title': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        session.setTitle(msg.title)
        this.persist(session)
        // A dedicated per-session message — not broadcastSessions(). Agents emit
        // titles at spinner frame-rate; rebroadcasting the whole list each time
        // would be wasteful, and late-joining clients still get the title via
        // listSessions() on attach.
        const update: ServerMessage = {
          type: 'sessionTitleChanged',
          sessionId: msg.sessionId,
          title: msg.title,
        }
        for (const c of this.clients.values()) c.send(update)
        break
      }
      case 'scanResult': {
        const resolve = this.pendingScans.get(msg.requestId)
        if (resolve) {
          this.pendingScans.delete(msg.requestId)
          resolve({ conversations: msg.conversations, diagnostics: msg.diagnostics })
        }
        break
      }
      case 'scanReposResult': {
        const resolve = this.pendingRepoScans.get(msg.requestId)
        if (resolve) {
          this.pendingRepoScans.delete(msg.requestId)
          resolve({ repositories: msg.repositories, diagnostics: msg.diagnostics })
        }
        break
      }
    }
  }

  private broadcastSessions(): void {
    const msg: ServerMessage = { type: 'sessionsChanged', sessions: this.listSessions() }
    for (const c of this.clients.values()) c.send(msg)
  }
}
