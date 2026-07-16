import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  AgentKind,
  ControlMessage,
  DaemonMessage,
  Geometry,
  HarnessAgent,
  HeadlessActivityEvent,
  HeadlessTurnEvent,
  LiveServerMessage,
  ResumeRef,
  ServerMessage,
} from '@podium/protocol'
import { Session } from '../sessions/session'

export interface HeadlessDeps {
  getSession(sessionId: string): Session | undefined
  /** Register a freshly constructed headless session in the registry's map. */
  registerSession(session: Session): void
  resolveMachine(requested: string | undefined, cwd: string): string
  defaultMachine(): string
  toMachine(machineId: string, msg: ControlMessage): void
  /** Mint a globally unique requestId with the given prefix (shared counter —
   *  ids must never collide across the registry's pending maps). */
  nextRequestId(prefix: string): string
  /** A fresh copy of the default PTY geometry (headless rows still carry one). */
  defaultGeometry(): Geometry
  persist(session: Session): void
  broadcastSessions(): void
  clients(): Iterable<{ send(msg: ServerMessage): void }>
}

/**
 * Headless harness sessions (concierge unification): persistent, PTY-less session
 * rows the superagent drives turn-by-turn. No spawn message is ever sent to the
 * daemon — it only sees turn requests and transcript binds.
 */
export class HeadlessService {
  private readonly pendingTurns = new Map<
    string,
    {
      resolve: (r: {
        ok: boolean
        error?: string
        harnessSessionId?: string
        output?: string
        retryable?: boolean
      }) => void
      onEvent?: (e: HeadlessTurnEvent) => void
    }
  >()
  private readonly pendingBinds = new Map<string, (r: { ok: boolean; error?: string }) => void>()

  constructor(private readonly deps: HeadlessDeps) {}

  /**
   * Create a headless harness session row: a persistent, PTY-less session the
   * superagent drives turn-by-turn (headlessTurn). Status is 'live' for as long
   * as the thread exists.
   */
  createHeadlessSession(input: {
    agentKind: AgentKind
    cwd: string
    title?: string
    spawnedBy?: string
    machineId?: string
  }): { sessionId: string } {
    const sessionId = randomUUID()
    const machineId = this.deps.resolveMachine(input.machineId, input.cwd)
    const session = new Session({
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
      origin: { kind: 'spawn' },
      createdAt: new Date().toISOString(),
      geometry: this.deps.defaultGeometry(),
      machineId,
      toDaemon: (msg) =>
        this.deps.toMachine(this.deps.getSession(sessionId)?.machineId ?? machineId, msg),
      status: 'live',
      headless: true,
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
    })
    this.deps.registerSession(session)
    this.deps.persist(session)
    this.deps.broadcastSessions()
    return { sessionId }
  }

  /**
   * Record the harness's own session id on a headless session once the first
   * turn reports it — the resume ref every later turn (and the "open in
   * terminal" escape hatch) reattaches to. Persisted + broadcast, mirroring how
   * PTY sessions learn their resume refs from the daemon.
   */
  setHeadlessResume(sessionId: string, resume: ResumeRef): void {
    const session = this.deps.getSession(sessionId)
    if (!session?.headless) return
    session.resume = resume
    this.deps.persist(session)
    this.deps.broadcastSessions()
  }

  /** Fan a headless turn-activity event out to every connected client
   *  (turn-start/turn-end markers + the daemon's mid-turn progress events). */
  broadcastHeadlessActivity(sessionId: string, event: HeadlessActivityEvent): void {
    const msg: LiveServerMessage = { type: 'headlessActivity', sessionId, event }
    for (const c of this.deps.clients()) c.send(msg)
  }

  /**
   * One turn of a headless harness session on the owning daemon. Mid-turn
   * progress (`headlessTurnEvent` frames) streams to `onEvent` before the
   * result resolves; the transcript tail delivers the canonical items.
   */
  headlessTurn(
    input: {
      turnId: string
      sessionId: string
      threadId: string
      agent: HarnessAgent
      model?: string
      effort?: string
      cwd: string
      prompt: string
      contextPrompt?: string
      systemPrompt?: string
      mcpConfig?: string
      allowedTools?: string[]
      permissionMode?: string
      resumeValue?: string
      sessionUuid?: string
      timeoutMs?: number
    },
    onEvent?: (event: HeadlessTurnEvent) => void,
  ): Promise<{
    ok: boolean
    error?: string
    harnessSessionId?: string
    output?: string
    retryable?: boolean
  }> {
    const machineId = this.deps.getSession(input.sessionId)?.machineId ?? this.deps.defaultMachine()
    const requestId = this.deps.nextRequestId('ht')
    const timeoutMs = (input.timeoutMs ?? 600_000) + 10_000
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTurns.delete(requestId)
        resolve({ ok: false, error: 'headless turn transport timed out', retryable: true })
      }, timeoutMs)
      timer.unref?.()
      this.pendingTurns.set(requestId, {
        resolve: (r) => {
          clearTimeout(timer)
          this.pendingTurns.delete(requestId)
          resolve(r)
        },
        ...(onEvent ? { onEvent } : {}),
      })
      try {
        this.deps.toMachine(machineId, {
          type: 'headlessTurnRequest',
          requestId,
          turnId: input.turnId,
          sessionId: input.sessionId,
          threadId: input.threadId,
          agent: input.agent,
          cwd: input.cwd,
          prompt: input.prompt,
          ...(input.contextPrompt ? { contextPrompt: input.contextPrompt } : {}),
          ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
          ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
          ...(input.sessionUuid ? { sessionUuid: input.sessionUuid } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        })
      } catch (error) {
        clearTimeout(timer)
        this.pendingTurns.delete(requestId)
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
        })
      }
    })
  }

  /** The server has durably committed the terminal result and no longer needs
   * the daemon's per-turn journal for restart replay. */
  headlessTurnAck(sessionId: string, turnId: string): void {
    const machineId = this.deps.getSession(sessionId)?.machineId ?? this.deps.defaultMachine()
    this.deps.toMachine(machineId, { type: 'headlessTurnAck', sessionId, turnId })
  }

  /** Interrupt a headless session's running turn (fire-and-forget; the turn's
   *  own headlessTurnResult reports the outcome). */
  headlessInterrupt(sessionId: string): void {
    const machineId = this.deps.getSession(sessionId)?.machineId ?? this.deps.defaultMachine()
    this.deps.toMachine(machineId, {
      type: 'headlessInterrupt',
      requestId: this.deps.nextRequestId('hi'),
      sessionId,
    })
  }

  /** (Re)establish the daemon-side transcript observers/tails for a headless
   *  session — the reattach equivalent for sessions with no PTY. */
  headlessBind(input: {
    sessionId: string
    agentKind: AgentKind
    cwd: string
    resumeValue: string
  }): Promise<{ ok: boolean; error?: string }> {
    const machineId = this.deps.getSession(input.sessionId)?.machineId ?? this.deps.defaultMachine()
    const requestId = this.deps.nextRequestId('hb')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingBinds.delete(requestId)
        resolve({ ok: false, error: 'headless bind timed out' })
      }, 15_000)
      timer.unref?.()
      this.pendingBinds.set(requestId, (r) => {
        clearTimeout(timer)
        this.pendingBinds.delete(requestId)
        resolve(r)
      })
      this.deps.toMachine(machineId, {
        type: 'headlessBind',
        requestId,
        sessionId: input.sessionId,
        agentKind: input.agentKind,
        cwd: input.cwd,
        resumeValue: input.resumeValue,
      })
    })
  }

  // ---- daemon result fan-in (the registry's message switch delegates here) ----

  onTurnEvent(msg: Extract<DaemonMessage, { type: 'headlessTurnEvent' }>): void {
    this.pendingTurns.get(msg.requestId)?.onEvent?.(msg.event)
  }

  onTurnResult(msg: Extract<DaemonMessage, { type: 'headlessTurnResult' }>): void {
    this.pendingTurns.get(msg.requestId)?.resolve({
      ok: msg.ok,
      ...(msg.error !== undefined ? { error: msg.error } : {}),
      ...(msg.harnessSessionId !== undefined ? { harnessSessionId: msg.harnessSessionId } : {}),
      ...(msg.output !== undefined ? { output: msg.output } : {}),
    })
  }

  onBindResult(msg: Extract<DaemonMessage, { type: 'headlessBindResult' }>): void {
    this.pendingBinds.get(msg.requestId)?.({
      ok: msg.ok,
      ...(msg.error !== undefined ? { error: msg.error } : {}),
    })
  }
}
