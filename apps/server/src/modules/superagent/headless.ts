import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { canonicalHeadlessContractFacts } from '@podium/agent-runtime'
import { describeError } from '@podium/logger'
import type {
  AccountId,
  AgentKind,
  Attribution,
  Geometry,
  HarnessAgent,
  IssueId,
  ResumeRef,
  SessionId,
  ThreadId,
  UserId,
} from '@podium/model'
import { asAccountId, asSessionId, type MachineId } from '@podium/model'
import type {
  HeadlessActivityEvent,
  HeadlessTurnEvent,
  LiveServerMessage,
  ServerMessage,
} from '@podium/protocol'
import type {
  ControlMessage,
  DaemonMessage,
  RuntimeEvent,
  TurnReceipt,
} from '@podium/protocol/daemon'
import { harnessSupportsNoTools } from '../../harness-manifest'
import { Session, type SessionDurableState } from '../sessions/session'

export interface HeadlessRuntimeRelay {
  send(input: {
    sessionId: SessionId
    turnId?: string
    text: string
    origin: 'system'
    delivery: 'when-ready'
    allowedTools?: string[]
    permissionMode?: string
    toolPolicy?: 'none'
    mcpConfig?: string
    resumeValue?: string
    sessionUuid?: string
    accountId?: string
    requestDigest?: string
    structuredPermissions?: true
    contextPrompt?: string
    systemPrompt?: string
    timeoutMs?: number
    model?: string
    effort?: string
  }): Promise<TurnReceipt>
  interrupt(sessionId: SessionId): Promise<{ ok: true } | { reason: string; detail?: string }>
  onEvent(listener: (sessionId: SessionId, event: RuntimeEvent) => void | Promise<void>): () => void
}

export interface HeadlessHistoryRelay {
  history(
    sessionId: SessionId,
    machineId: MachineId,
    range: { direction: 'before' | 'after'; limit: number },
  ): Promise<
    { sessionId: SessionId; result: { page: { items: readonly { role?: string; text?: string }[] } } | { reason: string; detail?: string } }
  >
  snapshot(
    sessionId: SessionId,
    machineId: MachineId,
  ): Promise<
    { sessionId: SessionId; result: { snapshot: { binding: { resume: { value: string } | null } } } | { reason: string; detail?: string } }
  >
}

export interface HeadlessDeps {
  /** Deployment-qualified durable namespace, injected by server composition. */
  durableLabelFor(sessionId: SessionId): string
  getSession(sessionId: SessionId): Session | undefined
  /** Register a freshly constructed headless session in the registry's map. */
  registerSession(session: Session): void
  resolveMachine(requested: string | undefined, cwd: string, agentKind: AgentKind): Promise<MachineId>
  defaultMachine(): Promise<MachineId>
  toMachine(machineId: MachineId, msg: ControlMessage): void
  /** Mint a globally unique requestId with the given prefix (shared counter —
   *  ids must never collide across the registry's pending maps).
   *  Retained for the legacy ack path; contract turns no longer mint one. */
  nextRequestId(prefix: string): string
  /** A fresh copy of the default PTY geometry (headless rows still carry one). */
  defaultGeometry(): Geometry
  persist(session: Session): Promise<void>
  /** Mutate the durable half as a DRAFT and persist it [POD-3330]. */
  write(session: Session, mutate: (draft: SessionDurableState) => void): void
  broadcastSessions(): void
  clients(): Iterable<{ send(msg: ServerMessage): void }>
  /** Driver-contract relay. Late-bound: read through the closure at call time,
   *  since the gateway is constructed after this service. */
  relay(): HeadlessRuntimeRelay
  /** History/snapshot reads for output + resume. Same late-bound rule. */
  store(): HeadlessHistoryRelay
}

/**
 * Headless harness sessions (concierge unification): persistent, PTY-less session
 * rows the superagent drives turn-by-turn. Sessions are established on the
 * daemon via `spawn`/`reattach` carrying `runtimeContract: 'headless'` (no
 * manifest `select()` ever returns it); turns ride the driver-contract WS
 * relay (`runtimeSendRequest` with headless fields, `gateway.interrupt`,
 * `gateway.events`, `runtimeHistory`/`runtimeSnapshot`).
 */
export class HeadlessService {
  constructor(private readonly deps: HeadlessDeps) {}

  /**
   * Create a headless harness session row: a persistent, PTY-less session the
   * superagent drives turn-by-turn. Status is 'live' for as long
   * as the thread exists. Also establishes the daemon-side headless session
   * via `spawn` with `runtimeContract: 'headless'` (fire-and-forget; the turn
   * path retries if the daemon has not bound it yet).
   */
  async createHeadlessSession(input: {
    sessionId?: SessionId
    agentKind: AgentKind
    cwd: string
    title?: string
    spawnedBy?: string
    machineId?: MachineId
    ownerUserId: UserId
    createdBy?: Attribution
    issueId?: IssueId
    accountId?: AccountId
    model?: string
    effort?: string
    requireNoTools?: boolean
  }): Promise<{ sessionId: SessionId }> {
    if (input.requireNoTools && !harnessSupportsNoTools(input.agentKind)) {
      throw new Error(`harness ${input.agentKind} cannot enforce a no-tools headless session`)
    }
    if (input.requireNoTools && !input.accountId?.startsWith(`native:${input.agentKind}:`)) {
      throw new Error(`harness ${input.agentKind} requires an exact native account fingerprint`)
    }
    // MINT SITE: a server-minted session id. The brand belongs where the id is
    // GENERATED — nothing upstream had it, so this is not an adapter cast.
    const sessionId = input.sessionId ?? asSessionId(randomUUID())
    const machineId = await this.deps.resolveMachine(input.machineId, input.cwd, input.agentKind)
    const existing = this.deps.getSession(sessionId)
    if (existing) {
      const same =
        existing.headless &&
        existing.agentKind === input.agentKind &&
        existing.cwd === input.cwd &&
        existing.machineId === machineId &&
        existing.ownerUserId === input.ownerUserId &&
        JSON.stringify(existing.createdBy) === JSON.stringify(input.createdBy) &&
        existing.issueId === input.issueId &&
        existing.accountId === input.accountId &&
        existing.model === input.model &&
        existing.effort === input.effort
      if (!same) throw new Error(`refusing to reuse mismatched headless session ${sessionId}`)
      return { sessionId }
    }
    const session = new Session({
      sessionId,
      durableLabel: this.deps.durableLabelFor(sessionId),
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
      // A mint, so the claim is honest: no conversation yet. `setHeadlessResume`
      // below promotes it the moment the first turn reports the harness's id.
      conversationBinding: 'never',
      ownerUserId: input.ownerUserId,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
    })
    this.deps.registerSession(session)
    await this.deps.persist(session)
    this.deps.broadcastSessions()
    // Establish the daemon-side headless session over the existing WS relay.
    // Fire-and-forget: a turn that lands before the bind reports `not_running`
    // (retryable), and `resumePendingTurns` re-drives it after reconnect.
    try {
      this.deps.toMachine(machineId, {
        type: 'spawn',
        sessionId,
        durableLabel: this.deps.durableLabelFor(sessionId),
        agentKind: input.agentKind,
        cwd: input.cwd,
        geometry: this.deps.defaultGeometry(),
        ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
        ...(input.effort && input.effort !== 'auto' ? { effort: input.effort } : {}),
        runtimeContract: 'headless',
      })
    } catch {
      // Establishment is best-effort; the turn path reports the failure.
    }
    return { sessionId }
  }

  /** Read immutable launch identity for deterministic headless replay. */
  headlessSession(sessionId: SessionId): Session | undefined {
    const session = this.deps.getSession(sessionId)
    return session?.headless ? session : undefined
  }

  /**
   * Record the harness's own session id on a headless session once the first
   * turn reports it — the resume ref every later turn (and the "open in
   * terminal" escape hatch) reattaches to. Persisted + broadcast, mirroring how
   * PTY sessions learn their resume refs from the daemon.
   */
  setHeadlessResume(sessionId: SessionId, resume: ResumeRef): void {
    const session = this.deps.getSession(sessionId)
    if (!session?.headless) return
    // Through `setResume` on the draft [POD-3330]: a bag has no setter, so a
    // bare assignment would skip the `conversationBinding` promotion — on the
    // very path whose comment at the mint site says this call is what promotes
    // a headless session off its `'never'` claim.
    this.deps.write(session, (draft) => session.setResume(resume, draft))
    this.deps.broadcastSessions()
  }

  /** Fan a headless turn-activity event out to every connected client
   *  (turn-start/turn-end markers + the daemon's mid-turn progress events). */
  broadcastHeadlessActivity(sessionId: SessionId, event: HeadlessActivityEvent): void {
    const session = this.deps.getSession(sessionId)
    if (session?.headless) {
      const nextPhase = event.kind === 'turn-end' ? 'idle' : 'working'
      const prior = session.agentState
      if (prior?.phase !== nextPhase) {
        const now = new Date()
        const priorTotal = prior?.workingMsTotal ?? 0
        const completedStretch =
          prior?.phase === 'working' ? Math.max(0, now.getTime() - Date.parse(prior.since)) : 0
        this.deps.write(session, (draft) =>
          session.setAgentState(
            {
              phase: nextPhase,
              since: now.toISOString(),
              workingMsTotal: priorTotal + completedStretch,
              nativeSubagentCount: prior?.nativeSubagentCount ?? 0,
              ...(nextPhase === 'idle'
                ? {
                    idle: {
                      kind: event.kind === 'turn-end' && event.error ? 'interrupted' : 'done',
                    },
                  }
                : {}),
              stateSource: 'poll',
              stateConfidence: 1,
              stateObservedAt: now.toISOString(),
            },
            true,
            draft,
          ),
        )
        this.deps.broadcastSessions()
      }
    }
    const msg: LiveServerMessage = { type: 'headlessActivity', sessionId, event }
    for (const c of this.deps.clients()) c.send(msg)
  }

  /**
   * One turn of a headless harness session via the driver-contract WS relay.
   * Mid-turn progress (contract `partial` fragments) streams to `onEvent`
   * before the result resolves; the transcript history delivers the canonical
   * output.
   *
   * Digest/account are minted here over the contract facts and fenced by the
   * daemon before dispatch (mismatch refuses, never runs). A reconnect replays
   * the SAME turnId and the daemon's durable journal returns without rerun.
   * The original deadline survives a restart: the waiter is budget+slack, and
   * a re-dispatch after restart waits only the remainder via the same turnId.
   */
  async headlessTurn(
    input: {
      turnId: string
      sessionId: SessionId
      threadId: ThreadId
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
      toolPolicy?: 'none'
      resumeValue?: string
      sessionUuid?: string
      timeoutMs?: number
    },
    onEvent?: (event: HeadlessTurnEvent) => void,
  ): Promise<{
    ok: boolean
    error?: string
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    harnessSessionId?: string
    output?: string
    retryable?: boolean
    accountId?: AccountId
    requestDigest?: string
  }> {
    if (input.toolPolicy === 'none' && !harnessSupportsNoTools(input.agent)) {
      throw new Error(`harness ${input.agent} cannot enforce a no-tools headless turn`)
    }
    const session = this.deps.getSession(input.sessionId)
    const machineId = session?.machineId ?? await this.deps.defaultMachine()
    const accountId = session?.accountId ?? asAccountId('')
    if (input.toolPolicy === 'none') {
      if (!accountId.startsWith(`native:${input.agent}:`)) {
        throw new Error(
          `tool-less headless session ${input.sessionId} has no exact account identity`,
        )
      }
      if (!session?.ownerUserId || !session.createdBy || !session.issueId) {
        throw new Error(
          `tool-less headless session ${input.sessionId} has incomplete requester identity`,
        )
      }
    }
    const model = input.model && input.model !== 'auto' ? input.model : undefined
    const effort = input.effort && input.effort !== 'auto' ? input.effort : undefined
    const requestDigest = createHash('sha256')
      .update(
        canonicalHeadlessContractFacts({
          prompt: input.prompt,
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(input.allowedTools !== undefined ? { allowedTools: [...input.allowedTools] } : {}),
          ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
          ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}),
          ...(input.mcpConfig !== undefined ? { mcpConfig: input.mcpConfig } : {}),
          ...(input.resumeValue !== undefined ? { resumeValue: input.resumeValue } : {}),
          ...(input.sessionUuid !== undefined ? { sessionUuid: input.sessionUuid } : {}),
          ...(input.contextPrompt !== undefined ? { contextPrompt: input.contextPrompt } : {}),
          ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          turnId: input.turnId,
          sessionId: input.sessionId,
          accountId,
        }),
      )
      .digest('hex')
    const budgetMs = input.timeoutMs ?? 600_000
    const waitMs = budgetMs + 10_000
    const relay = this.deps.relay()
    const store = this.deps.store()

    // Subscribe BEFORE the send so a synchronously-completing turn cannot slip
    // between the receipt and the first read (same rule as genericAskAndAwait).
    let wantedEpoch: number | undefined
    let terminal: RuntimeEvent | undefined
    const seenPartials: { text: string; hint?: string }[] = []
    const unsubscribe = relay.onEvent((sid, event) => {
      if (sid !== input.sessionId) return
      if (event.t === 'turn') {
        const ev = event.ev
        if (ev.ev === 'started') {
          if (wantedEpoch === undefined) wantedEpoch = ev.turnEpoch
          return
        }
        if (wantedEpoch === undefined) return
        if (ev.turnEpoch !== wantedEpoch) return
        terminal = event
        return
      }
      if (event.t === 'item' && onEvent) {
        const item = (event as { item?: { kind?: string; item?: { id?: string; text?: string } } }).item
        if (item?.kind === 'partial' && typeof item.item?.text === 'string') {
          const id = item.item.id ?? ''
          const hint = id.startsWith(`headless:${input.turnId}:`) ? id.slice(`headless:${input.turnId}:`.length) || undefined : undefined
          const text = item.item.text
          seenPartials.push(hint ? { text, hint } : { text })
          try {
            onEvent(hint ? { kind: 'partial-text', text, itemHint: hint } : { kind: 'partial-text', text })
          } catch {
            // Progress fan-out is best-effort; it must not fail the turn.
          }
        }
      }
    })
    try {
      let receipt: TurnReceipt
      try {
        receipt = await relay.send({
          sessionId: input.sessionId,
          turnId: input.turnId,
          text: input.prompt,
          origin: 'system',
          delivery: 'when-ready',
          ...(input.allowedTools ? { allowedTools: [...input.allowedTools] } : {}),
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
          ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
          ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
          ...(input.sessionUuid ? { sessionUuid: input.sessionUuid } : {}),
          accountId,
          requestDigest,
          ...(input.contextPrompt ? { contextPrompt: input.contextPrompt } : {}),
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        })
      } catch (error) {
        return { ok: false, error: describeError(error), retryable: true }
      }
      if (receipt.outcome === 'refused') {
        const reason = receipt.refusal.reason
        const detail = receipt.refusal.detail ?? 'headless turn refused'
        // Retryable only when the turn never reached a driver: no machine, or
        // the session is not (yet) behind the contract. Every other refusal
        // (digest/account/tool-policy/busy/unsupported) is a verdict, not a
        // transport gap — retrying would rerun a fenced turn.
        if (reason === 'not_running') {
          return { ok: false, error: detail, retryable: true }
        }
        if (reason === 'invalid_value' && /digest|identity|account/i.test(detail)) {
          return { ok: false, error: 'headless result identity mismatch' }
        }
        return { ok: false, error: detail }
      }
      if (receipt.outcome === 'unverified') {
        return { ok: false, error: 'headless turn transport timed out', retryable: true }
      }
      if (receipt.outcome === 'queued') {
        return { ok: false, error: 'headless turn was queued; expected direct dispatch', retryable: true }
      }
      // accepted
      wantedEpoch = receipt.turnEpoch
      const deadline = Date.now() + waitMs
      for (;;) {
        if (terminal) break
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          try {
            await relay.interrupt(input.sessionId)
          } catch {
            // Fencing is best-effort; the retryable report below is the verdict.
          }
          return { ok: false, error: 'headless turn transport timed out', retryable: true }
        }
        await new Promise((r) => setTimeout(r, Math.min(50, remaining)))
      }
      const term = (terminal as { ev: { ev: string; verdict?: string; reason?: string; detail?: string } }).ev
      // Read the canonical output + resume after the fence. Best-effort: a
      // history/snapshot miss must not turn a completed turn into a failure.
      let output: string | undefined
      let harnessSessionId: string | undefined
      try {
        const hist = await store.history(input.sessionId, machineId, { direction: 'before', limit: 1000 })
        if ('page' in hist.result) {
          const items = hist.result.page.items
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i]
            if (item && (item as { role?: string }).role === 'assistant' && typeof (item as { text?: string }).text === 'string' && (item as { text: string }).text) {
              output = (item as { text: string }).text
              break
            }
          }
          if (output === undefined) {
            const texts = items
              .filter((it) => typeof (it as { text?: string }).text === 'string' && (it as { text: string }).text)
              .map((it) => (it as { text: string }).text)
            if (texts.length > 0) output = texts[texts.length - 1]
          }
        }
      } catch {
        // Best-effort; terminal verdict below still decides.
      }
      try {
        const snap = await store.snapshot(input.sessionId, machineId)
        if ('snapshot' in snap.result && snap.result.snapshot.binding.resume) {
          harnessSessionId = snap.result.snapshot.binding.resume.value
        }
      } catch {
        // Best-effort; the caller binds what is reported.
      }
      if (term.ev === 'completed') {
        if (term.verdict === 'interrupted') {
          return {
            ok: false,
            error: 'turn interrupted',
            ...(harnessSessionId ? { harnessSessionId } : {}),
            ...(output ? { output } : {}),
            accountId,
            requestDigest,
          }
        }
        return {
          ok: true,
          ...(harnessSessionId ? { harnessSessionId } : {}),
          ...(output ? { output } : {}),
          accountId,
          requestDigest,
        }
      }
      const reason = (term as { reason?: string }).reason ?? 'provider-error'
      const detail = (term as { detail?: string }).detail
      const error = detail ? `${reason}: ${detail}` : reason
      return {
        ok: false,
        error,
        ...(harnessSessionId ? { harnessSessionId } : {}),
        ...(output ? { output } : {}),
        accountId,
        requestDigest,
      }
    } finally {
      unsubscribe()
    }
  }

  /** The server has durably committed the terminal result and no longer needs
   * the daemon's per-turn journal for restart replay.
   *
   * Still rides the legacy `headlessTurnAck` frame: the driver-contract WS
   * relay has no ack verb yet, and the daemon's handler is the same
   * identity-checked `acknowledgeDurableHeadlessTurn` either way. A dedicated
   * `runtimeHeadlessAckRequest` is the follow-up that lets POD-4279 delete the
   * legacy port outright. */
  async headlessTurnAck(
    sessionId: SessionId,
    turnId: string,
    requestDigest: string,
    accountId: AccountId,
  ): Promise<void> {
    const machineId = this.deps.getSession(sessionId)?.machineId ?? await this.deps.defaultMachine()
    this.deps.toMachine(machineId, {
      type: 'headlessTurnAck',
      sessionId,
      turnId,
      requestDigest,
      accountId,
    })
  }

  /** Interrupt a headless session's running turn via the driver-contract relay.
   *  Fire-and-forget; the turn's own terminal event reports the outcome. */
  async headlessInterrupt(sessionId: SessionId): Promise<void> {
    try {
      await this.deps.relay().interrupt(sessionId)
    } catch {
      // Fencing is best-effort; the waiter (or reaper) owns the verdict.
    }
  }

  /** (Re)establish the daemon-side headless session — the reattach equivalent
   *  for sessions with no PTY. Sends `reattach` with `runtimeContract:
   *  'headless'`; the daemon adopts (or resumes) the headless handle and
   *  rebinds the transcript tail. Best-effort and idempotent. */
  async headlessBind(input: {
    sessionId: SessionId
    agentKind: AgentKind
    cwd: string
    resumeValue: string
  }): Promise<{ ok: boolean; error?: string }> {
    const session = this.deps.getSession(input.sessionId)
    const machineId = session?.machineId ?? await this.deps.defaultMachine()
    try {
      this.deps.toMachine(machineId, {
        type: 'reattach',
        sessionId: input.sessionId,
        durableLabel: this.deps.durableLabelFor(input.sessionId),
        agentKind: input.agentKind,
        cwd: input.cwd,
        lastKnownGeometry: this.deps.defaultGeometry(),
        resume: { kind: 'headless-session', value: input.resumeValue },
        runtimeContract: 'headless',
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
  }

  // ---- legacy daemon result fan-in (kept as no-ops for the mux) ----
  // Contract turns report via `gateway.events`/`runtimeHistory`, never via
  // `headlessTurnEvent`/`headlessTurnResult`. These stay only because the
  // daemon mux's `HeadlessDaemonPort` names them; they must not resolve
  // anything.

  onTurnEvent(_msg: Extract<DaemonMessage, { type: 'headlessTurnEvent' }>): void {
    return
  }

  onTurnResult(_msg: Extract<DaemonMessage, { type: 'headlessTurnResult' }>): void {
    return
  }

  onBindResult(_msg: Extract<DaemonMessage, { type: 'headlessBindResult' }>): void {
    return
  }
}
