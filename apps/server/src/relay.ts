import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { PodiumSettings } from '@podium/core'
import {
  AgentKind,
  type AgentRuntimeState,
  type ClientMessage,
  type ControlMessage,
  type ConversationDiagnosticWire,
  type ConversationSummaryWire,
  type DaemonMessage,
  type Geometry,
  type GitDiscoveryDiagnosticWire,
  type GitRepositoryWire,
  type HostMetricsWire,
  type RepoOp,
  type ResumeRef,
  type ServerMessage,
  type SessionMeta,
  type UsageBucketWire,
  type WorkState,
} from '@podium/protocol'
import { attentionNotice, pushNtfy } from './notify'
import { type ClientConn, type Send, Session } from './session'
import { type PinKind, SessionStore } from './store'

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

/** The daemon's memoryBreakdownResult, minus wire plumbing (type/requestId). */
export type MemoryBreakdown = Omit<
  Extract<DaemonMessage, { type: 'memoryBreakdownResult' }>,
  'type' | 'requestId'
>

/** Outcome of a daemon-executed operation (git op / harness one-shot). */
export interface OpResult {
  ok: boolean
  output: string
}

/** Registry of all sessions + the single daemon link + all client connections. Routes by sessionId. */
export class SessionRegistry {
  private daemonSend: Send<ControlMessage> | undefined
  // Control messages produced before a daemon attaches (e.g. a starter session
  // created at boot, before the daemon ws finishes connecting) would otherwise be
  // dropped silently. Queue them here and flush in order once a daemon attaches.
  private readonly pendingToDaemon: ControlMessage[] = []
  private readonly sessions = new Map<string, Session>()
  private readonly clients = new Map<string, ClientConn>()
  private readonly pendingScans = new Map<string, (r: ScanResult) => void>()
  private readonly pendingRepoScans = new Map<string, (r: ScanReposResult) => void>()
  private readonly pendingBreakdowns = new Map<string, (r: MemoryBreakdown | undefined) => void>()
  private readonly pendingRepoOps = new Map<string, (r: OpResult) => void>()
  private readonly pendingHarnessExecs = new Map<string, (r: OpResult) => void>()
  private readonly pendingUsage = new Map<
    string,
    (r: { hostname: string; buckets: UsageBucketWire[] }) => void
  >()
  private latestConversations: ConversationSummaryWire[] = []
  private latestConversationDiagnostics: ConversationDiagnosticWire[] = []
  // Latest health sample per daemon host, keyed by hostname — ready for several
  // machines even while the registry holds a single daemon socket.
  private readonly latestHostMetrics = new Map<string, HostMetricsWire>()
  private nextClientNum = 0
  // Shared by scan() ('r' prefix) and scanRepos() ('rr' prefix). Each scan
  // variant must use a distinct string prefix so ids never collide across the
  // separate pending maps.
  private nextRequestNum = 0

  constructor(private readonly store: SessionStore = new SessionStore(':memory:')) {
    this.loadFromStore()
  }

  /** The backing store — shared with services that persist their own tables (superagent). */
  get sessionStore(): SessionStore {
    return this.store
  }

  private persist(session: Session): void {
    this.store.upsertSession(session.toRow())
  }

  private loadFromStore(): void {
    for (const r of this.store.loadSessions()) {
      const kind = AgentKind.safeParse(r.agentKind)
      if (!kind.success) {
        console.warn(
          `[podium] skipping persisted session ${r.id}: invalid agentKind ${JSON.stringify(r.agentKind)}`,
        )
        continue
      }
      // Layer 3: a previously live/starting session may still be running in its tmux
      // server. Reload it as 'reconnecting' so attachDaemon can re-bind it; exited stays
      // exited, hibernated stays hibernated.
      const reloadStatus =
        r.status === 'live' || r.status === 'starting' ? 'reconnecting' : r.status
      const exitCode = r.status === 'exited' ? r.exitCode : null
      if (r.originKind === 'resume' && !r.conversationId) {
        console.warn(`[podium] persisted resume session ${r.id} has no conversationId`)
      }
      const session = new Session({
        sessionId: r.id,
        agentKind: kind.data,
        cwd: r.cwd,
        title: r.title,
        origin:
          r.originKind === 'resume'
            ? { kind: 'resume', conversationId: r.conversationId ?? '' }
            : { kind: 'spawn' },
        createdAt: r.createdAt,
        geometry: { ...DEFAULT_GEOMETRY },
        toDaemon: this.toDaemon,
        durableLabel: r.durableLabel,
        lastActiveAt: r.lastActiveAt,
        status: reloadStatus,
        exitCode: exitCode ?? undefined,
        ...(r.name ? { name: r.name } : {}),
        archived: r.archived,
        ...(Session.parseWorkState(r.workState)
          ? { workState: Session.parseWorkState(r.workState) }
          : {}),
        ...(r.resumeKind && r.resumeValue
          ? { resume: { kind: r.resumeKind, value: r.resumeValue } }
          : {}),
      })
      this.sessions.set(r.id, session)
      if (r.status !== reloadStatus) this.persist(session)
    }
  }

  attachDaemon(send: Send<ControlMessage>): void {
    this.daemonSend = send
    // Flush control messages buffered while no daemon was attached (e.g. a boot
    // session's spawn produced before the daemon ws connected).
    if (this.pendingToDaemon.length > 0) {
      for (const m of this.pendingToDaemon.splice(0)) send(m)
    }
    // Re-bind survivor sessions: ask the daemon to reattach to their live tmux session.
    for (const s of this.sessions.values()) {
      if (s.status === 'reconnecting') {
        this.toDaemon({
          type: 'reattach',
          sessionId: s.sessionId,
          durableLabel: s.durableLabel,
          agentKind: s.agentKind,
          cwd: s.cwd,
          geometry: s.geometry,
        })
      }
    }
  }
  detachDaemon(): void {
    this.daemonSend = undefined
    // The daemon's host samples are only as live as its socket — drop them so a
    // dead machine's numbers never linger as truth.
    if (this.latestHostMetrics.size > 0) {
      this.latestHostMetrics.clear()
      this.broadcastHostMetrics()
    }
  }
  private readonly toDaemon: Send<ControlMessage> = (msg) => {
    if (this.daemonSend) this.daemonSend(msg)
    else this.pendingToDaemon.push(msg)
  }

  // ---- tRPC control plane ----
  listSessions(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => s.toMeta())
  }

  listPins() {
    return this.store.listPins()
  }

  setPin(kind: PinKind, id: string, pinned: boolean) {
    this.store.setPin(kind, id, pinned)
  }

  listTabOrders() {
    return this.store.listTabOrders()
  }

  setTabOrder(worktree: string, sessionIds: string[]) {
    this.store.setTabOrder(worktree, sessionIds)
  }

  getSettings(): PodiumSettings {
    return this.store.getSettings()
  }

  setSettings(settings: PodiumSettings): PodiumSettings {
    this.store.setSettings(settings)
    return settings
  }

  /** Agent kind may be omitted — the settings default decides ('auto' = Claude Code). */
  createSession(input: { agentKind?: AgentKind; cwd: string; title?: string }): {
    sessionId: string
  } {
    const defaults = this.store.getSettings().sessionDefaults
    const agentKind =
      input.agentKind ?? (defaults.agent === 'auto' ? 'claude-code' : defaults.agent)
    return this.spawn({
      agentKind,
      cwd: input.cwd,
      ...(input.title !== undefined ? { title: input.title } : {}),
      origin: { kind: 'spawn' },
    })
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

  /**
   * The overview "Continue" button: nudge an errored agent to retry by typing
   * `continue⏎` into its PTY. Guarded to the errored phase so a stray click
   * can't inject text into a healthy prompt.
   */
  continueSession({ sessionId }: { sessionId: string }): { ok: boolean } {
    const session = this.sessions.get(sessionId)
    if (session?.agentState?.phase !== 'errored') return { ok: false }
    this.toDaemon({
      type: 'input',
      sessionId,
      data: Buffer.from('continue\r').toString('base64'),
    })
    return { ok: true }
  }

  /**
   * Chat-view send: type a message into the agent's input as if pasted. Multi-line
   * text goes bracketed so the harness treats it as one block instead of
   * submitting at each newline; a trailing CR submits.
   */
  sendText({ sessionId, text }: { sessionId: string; text: string }): { ok: boolean } {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
    }
    const body = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text
    this.toDaemon({
      type: 'input',
      sessionId,
      data: Buffer.from(`${body}\r`).toString('base64'),
    })
    return { ok: true }
  }

  /** Set (or clear with '') the user-facing session name. */
  renameSession({ sessionId, name }: { sessionId: string; name: string }): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.name = name.trim()
    this.persist(session)
    this.broadcastSessions()
  }

  setArchived({ sessionId, archived }: { sessionId: string; archived: boolean }): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.archived = archived
    this.persist(session)
    this.broadcastSessions()
  }

  setWorkState({ sessionId, workState }: { sessionId: string; workState: WorkState | null }): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.workState = workState ?? undefined
    this.persist(session)
    this.broadcastSessions()
  }

  /**
   * Park a live session: kill its process (and durable host) but keep the row,
   * its transcript, and the resume ref. One click brings it back. Returns false
   * when the session can't come back later (no resume ref) — we refuse rather
   * than silently turn "hibernate" into "kill".
   */
  hibernateSession({ sessionId }: { sessionId: string }): { ok: boolean; reason?: string } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    if (session.status !== 'live') return { ok: false, reason: 'not running' }
    if (!session.resume) {
      return { ok: false, reason: 'no resume ref yet — the agent has not reported one' }
    }
    session.status = 'hibernated'
    this.persist(session)
    this.toDaemon({ type: 'kill', sessionId })
    this.broadcastSessions()
    return { ok: true }
  }

  /** Wake a hibernated session: respawn under the same id with its resume ref. */
  resurrectSession({ sessionId }: { sessionId: string }): { ok: boolean; reason?: string } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    // Hibernated (parked on purpose) and exited (process died or was killed
    // externally) are the same situation here: no process, but the row and the
    // resume ref are intact — both come back with one spawn.
    if (session.status !== 'hibernated' && session.status !== 'exited') {
      return { ok: false, reason: 'process still running' }
    }
    // A shell has no conversation to lose — a fresh spawn in the same cwd IS
    // full recovery, so it never needs a resume ref. Agents do: respawning one
    // without its ref would silently discard the conversation.
    if (session.agentKind !== 'shell' && !session.resume) {
      return { ok: false, reason: 'no resume ref' }
    }
    session.status = 'starting'
    session.exitCode = undefined
    this.persist(session)
    this.toDaemon({
      type: 'spawn',
      sessionId,
      agentKind: session.agentKind,
      cwd: session.cwd,
      ...(session.resume ? { resume: session.resume } : {}),
      geometry: session.geometry,
    })
    this.broadcastSessions()
    return { ok: true }
  }

  // At most one hibernation per cooldown window — memory readings need time to
  // reflect the previous kill before deciding to take down another agent.
  private lastAutoHibernateMs = 0
  private maybeAutoHibernate(sample: HostMetricsWire): void {
    const cfg = this.store.getSettings().hibernation
    if (!cfg.enabled) return
    const m = sample.memory
    if (m.totalBytes <= 0) return
    const usedPct = ((m.totalBytes - m.availableBytes) / m.totalBytes) * 100
    if (usedPct < cfg.memoryPct) return
    const now = Date.now()
    if (now - this.lastAutoHibernateMs < 60_000) return
    const idleCutoff = now - cfg.idleMinutes * 60_000
    const candidates = [...this.sessions.values()]
      .filter(
        (s) =>
          s.status === 'live' &&
          s.resume !== undefined &&
          // Only agents that are demonstrably done/idle. needs_user keeps its
          // pending question; working agents are obviously off-limits.
          (s.agentState?.phase === 'idle' || s.agentState?.phase === 'ended') &&
          Date.parse(s.lastActiveAt) <= idleCutoff,
      )
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt))
    const target = candidates[0]
    if (!target) return
    this.lastAutoHibernateMs = now
    console.info(
      `[podium] memory ${usedPct.toFixed(0)}% on ${sample.hostname} ≥ ${cfg.memoryPct}% — hibernating idle session ${target.sessionId}`,
    )
    this.hibernateSession({ sessionId: target.sessionId })
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

  /** Token-usage buckets from the daemon's transcript harvest (empty on timeout). */
  usage(sinceMs?: number): Promise<{ hostname: string; buckets: UsageBucketWire[] }> {
    const requestId = `us${this.nextRequestNum++}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingUsage.delete(requestId)
        resolve({ hostname: '', buckets: [] })
      }, 20_000)
      timer.unref?.()
      this.pendingUsage.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.toDaemon({
        type: 'usageRequest',
        requestId,
        ...(sinceMs !== undefined ? { sinceMs } : {}),
      })
    })
  }

  /** Allowlisted git op on a dev machine (superagent tools). */
  repoOp(op: RepoOp, cwd: string, args?: Record<string, string>): Promise<OpResult> {
    const requestId = `ro${this.nextRequestNum++}`
    return new Promise<OpResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRepoOps.delete(requestId)
        resolve({ ok: false, output: 'no daemon answered the git request in time' })
      }, 35_000)
      timer.unref?.()
      this.pendingRepoOps.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.toDaemon({ type: 'repoOpRequest', requestId, op, cwd, ...(args ? { args } : {}) })
    })
  }

  /** One-shot `claude -p` / `codex exec` on a dev machine (harness-backed LLM work). */
  harnessExec(input: {
    agent: 'claude-code' | 'codex'
    model?: string
    prompt: string
    cwd?: string
  }): Promise<OpResult> {
    const requestId = `hx${this.nextRequestNum++}`
    return new Promise<OpResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHarnessExecs.delete(requestId)
        resolve({ ok: false, output: 'harness run timed out' })
      }, 250_000)
      timer.unref?.()
      this.pendingHarnessExecs.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.toDaemon({
        type: 'harnessExecRequest',
        requestId,
        agent: input.agent,
        prompt: input.prompt,
        ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      })
    })
  }

  /** Ask the daemon who owns the used memory. Resolves undefined when no daemon answers in time. */
  memoryBreakdown(roots: string[]): Promise<MemoryBreakdown | undefined> {
    const requestId = `mb${this.nextRequestNum++}`
    return new Promise<MemoryBreakdown | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingBreakdowns.delete(requestId)
        resolve(undefined)
      }, SCAN_TIMEOUT_MS)
      timer.unref?.()
      this.pendingBreakdowns.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.toDaemon({ type: 'memoryBreakdownRequest', requestId, roots })
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
      durableLabel: `podium-${sessionId}`,
      ...(input.resume ? { resume: input.resume } : {}),
    })
    this.sessions.set(sessionId, session)
    this.persist(session)
    // Model defaults ride along to the daemon; 'auto' means no override at all.
    const defaults = this.store.getSettings().sessionDefaults
    const model = defaults.model !== 'auto' ? defaults.model : undefined
    const subagentModel = defaults.subagentModel !== 'auto' ? defaults.subagentModel : undefined
    this.toDaemon({
      type: 'spawn',
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      ...(input.resume ? { resume: input.resume } : {}),
      geometry: { ...DEFAULT_GEOMETRY },
      ...(model !== undefined && input.agentKind !== 'shell' ? { model } : {}),
      ...(subagentModel !== undefined && input.agentKind === 'claude-code'
        ? { subagentModel }
        : {}),
    })
    this.broadcastSessions()
    return { sessionId }
  }

  // ---- ws data plane: clients ----
  attachClient(send: Send<ServerMessage>): string {
    const id = `c${this.nextClientNum++}`
    this.clients.set(id, {
      id,
      send,
      viewport: { ...DEFAULT_GEOMETRY },
      attached: new Set(),
      visible: true,
    })
    send({ type: 'welcome', clientId: id })
    send({ type: 'sessionsChanged', sessions: this.listSessions() })
    send({
      type: 'conversationsChanged',
      conversations: this.latestConversations,
      diagnostics: this.latestConversationDiagnostics,
    })
    if (this.latestHostMetrics.size > 0) send(this.hostMetricsMessage())
    return id
  }

  detachClient(id: string): void {
    const client = this.clients.get(id)
    if (!client) return
    for (const sessionId of client.attached) this.sessions.get(sessionId)?.detachClient(id)
    // Transcript subscriptions are independent of PTY attachment — sweep them all.
    for (const session of this.sessions.values()) session.unsubscribeTranscript(id)
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
      case 'transcriptSubscribe':
        this.sessions.get(msg.sessionId)?.subscribeTranscript(client)
        break
      case 'transcriptUnsubscribe':
        this.sessions.get(msg.sessionId)?.unsubscribeTranscript(id)
        break
      case 'presence':
        client.visible = msg.visible
        break
      case 'ping':
        client.send({ type: 'pong' })
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
      case 'reattachFailed': {
        const s = this.sessions.get(msg.sessionId)
        if (s) {
          s.onExit(-1) // the surviving tmux session is gone; the agent died with the box
          this.persist(s)
        }
        this.broadcastSessions()
        break
      }
      case 'agentState': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        const prev = session.agentState
        session.setAgentState(msg.state)
        // Phase transitions are low-frequency (seconds apart, never per-frame),
        // so reusing the full sessions broadcast keeps the client protocol unchanged.
        this.broadcastSessions()
        this.notifyAttention(session, prev, msg.state)
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
        this.latestConversations = msg.conversations
        this.latestConversationDiagnostics = msg.diagnostics
        this.indexConversations(msg.conversations)
        this.broadcastConversations()
        const resolve = this.pendingScans.get(msg.requestId)
        if (resolve) {
          this.pendingScans.delete(msg.requestId)
          resolve({ conversations: msg.conversations, diagnostics: msg.diagnostics })
        }
        break
      }
      case 'conversationsChanged': {
        this.latestConversations = msg.conversations
        this.latestConversationDiagnostics = msg.diagnostics
        this.indexConversations(msg.conversations)
        this.broadcastConversations()
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
      case 'hostMetrics': {
        const { type: _type, ...sample } = msg
        this.latestHostMetrics.set(msg.hostname, sample)
        this.broadcastHostMetrics()
        this.maybeAutoHibernate(sample)
        break
      }
      case 'sessionResumeRef': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        if (session.resume?.value !== msg.resume.value) {
          session.resume = msg.resume
          this.persist(session)
        }
        break
      }
      case 'transcriptAppend':
        this.sessions.get(msg.sessionId)?.appendTranscript(msg.items, msg.reset ?? false)
        break
      case 'repoOpResult': {
        const resolve = this.pendingRepoOps.get(msg.requestId)
        if (resolve) {
          this.pendingRepoOps.delete(msg.requestId)
          resolve({ ok: msg.ok, output: msg.output })
        }
        break
      }
      case 'harnessExecResult': {
        const resolve = this.pendingHarnessExecs.get(msg.requestId)
        if (resolve) {
          this.pendingHarnessExecs.delete(msg.requestId)
          resolve({ ok: msg.ok, output: msg.output })
        }
        break
      }
      case 'usageResult': {
        const resolve = this.pendingUsage.get(msg.requestId)
        if (resolve) {
          this.pendingUsage.delete(msg.requestId)
          resolve({ hostname: msg.hostname, buckets: msg.buckets })
        }
        break
      }
      case 'memoryBreakdownResult': {
        const resolve = this.pendingBreakdowns.get(msg.requestId)
        if (resolve) {
          this.pendingBreakdowns.delete(msg.requestId)
          const { type: _type, requestId: _requestId, ...breakdown } = msg
          resolve(breakdown)
        }
        break
      }
    }
  }

  /** Every discovery push lands in the durable index — search sees machines' full history. */
  private indexConversations(conversations: ConversationSummaryWire[]): void {
    this.store.upsertConversations(
      conversations.map((c) => ({
        id: c.id,
        agentKind: c.agentKind,
        providerId: c.providerId,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.projectPath !== undefined ? { projectPath: c.projectPath } : {}),
        ...(c.resume ? { resumeKind: c.resume.kind, resumeValue: c.resume.value } : {}),
        ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
        ...(c.updatedAt !== undefined ? { updatedAt: c.updatedAt } : {}),
        ...(c.messageCount !== undefined ? { messageCount: c.messageCount } : {}),
      })),
    )
  }

  searchConversations(opts: { query?: string; projectPath?: string; limit?: number }) {
    return this.store.searchConversations(opts)
  }

  transcriptFor(sessionId: string) {
    return this.sessions.get(sessionId)?.transcriptItems() ?? []
  }

  setConversationMeta(input: { id: string; name?: string; summary?: string }): void {
    this.store.setConversationMeta(input.id, input)
  }

  /**
   * Smart-routed attention notifications. Web clients always get the event
   * (each shows it only while hidden); the mobile push (ntfy) fires only when
   * NO Podium window is visible anywhere — if you're looking at a desktop, the
   * phone stays quiet.
   */
  private notifyAttention(
    session: Session,
    prev: AgentRuntimeState | undefined,
    next: AgentRuntimeState,
  ): void {
    const settings = this.store.getSettings().notifications
    const name = session.name || session.title || session.cwd.split('/').pop() || 'agent'
    const notice = attentionNotice(name, prev, next)
    if (!notice) return
    if (settings.web) {
      const event: ServerMessage = {
        type: 'attentionEvent',
        sessionId: session.sessionId,
        title: notice.title,
        body: notice.body,
      }
      for (const c of this.clients.values()) c.send(event)
    }
    if (settings.ntfyTopic) {
      const someoneWatching = [...this.clients.values()].some((c) => c.visible)
      if (!someoneWatching) pushNtfy(settings.ntfyTopic, notice)
    }
  }

  private broadcastSessions(): void {
    const msg: ServerMessage = { type: 'sessionsChanged', sessions: this.listSessions() }
    for (const c of this.clients.values()) c.send(msg)
  }

  private broadcastConversations(): void {
    const msg: ServerMessage = {
      type: 'conversationsChanged',
      conversations: this.latestConversations,
      diagnostics: this.latestConversationDiagnostics,
    }
    for (const c of this.clients.values()) c.send(msg)
  }

  private hostMetricsMessage(): ServerMessage {
    return { type: 'hostMetricsChanged', hosts: [...this.latestHostMetrics.values()] }
  }

  private broadcastHostMetrics(): void {
    const msg = this.hostMetricsMessage()
    for (const c of this.clients.values()) c.send(msg)
  }
}
