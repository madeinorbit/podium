import type { AgentObservation, AgentRuntimeState, ControlMessage } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

const registries: SessionRegistry[] = []
const at = (second: number) => `2026-07-19T12:00:${String(second).padStart(2, '0')}.000Z`

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

function runtime(
  phase: AgentRuntimeState['phase'],
  second: number,
  extra: Partial<AgentRuntimeState> = {},
): AgentRuntimeState {
  return {
    phase,
    since: at(second),
    workingMsTotal: 0,
    nativeSubagentCount: 0,
    ...extra,
  }
}

function harness({
  terminalProvenance = 'live',
  resumable = true,
  terminalTransitionKind = 'turn_terminal',
  terminalPhase = 'idle',
  closing = false,
}: {
  terminalProvenance?: 'live' | 'bootstrap'
  resumable?: boolean
  terminalTransitionKind?: AgentObservation['transitionKind']
  terminalPhase?: AgentRuntimeState['phase']
  closing?: boolean
} = {}) {
  const store = new SessionStore(':memory:')
  const daemon: ControlMessage[] = []
  const registry = new SessionRegistry(store)
  registries.push(registry)
  registry.modules.sessions.attachDaemon('local', (message) => daemon.push(message))
  const { sessionId } = registry.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: '/proj',
  })
  registry.modules.sessions.onDaemonMessageFrom('local', {
    type: 'bind',
    sessionId,
    cmd: 'codex',
    cwd: '/proj',
    agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
  })
  if (resumable) {
    registry.modules.sessions.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'codex-thread', value: 'thread-1' },
      confidence: 'exact',
    })
  }
  const base: AgentObservation = {
    podiumSessionId: sessionId,
    provider: 'codex',
    providerSessionId: 'thread-1',
    bindingVersion: 1,
    providerTurnId: 'turn-1',
    providerPromptId: 'prompt-1',
    observerGeneration: 1,
    providerCursor: { segmentId: 'rollout-1', components: { file: 10 } },
    providerAt: at(10),
    receivedAt: at(11),
    sourceEventKind: 'rollout_fold',
    transitionKind: 'snapshot',
    provenance: 'bootstrap',
    inputOrigin: 'provider',
    turnEpoch: 1,
    priorPhase: 'working',
    nextPhase: 'working',
    transitionId: 'bootstrap-working',
    state: runtime('working', 10),
  }
  const observe = (observation: AgentObservation) =>
    registry.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservation',
      observation,
    })
  observe(base)
  const terminal: AgentObservation = {
    ...base,
    providerCursor: { segmentId: 'rollout-1', components: { file: 20 } },
    providerAt: at(20),
    receivedAt: at(21),
    sourceEventKind: 'task_complete',
    transitionKind: terminalTransitionKind,
    provenance: terminalProvenance,
    priorPhase: 'working',
    nextPhase: terminalPhase,
    transitionId: 'terminal-1',
    state:
      terminalPhase === 'idle'
        ? runtime(
            'idle',
            20,
            closing
              ? {
                  idle: { kind: 'done' },
                  nativeSubagentCount: 1,
                  awaitingSubagents: true,
                  nativeSubagents: [{ id: 'child-1' }],
                }
              : { idle: { kind: 'done' } },
          )
        : runtime(terminalPhase, 20),
  }
  observe(terminal)
  const confirm = (generation: number) =>
    registry.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObserverLiveConfirmation',
      sessionId,
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 1,
      observerGeneration: 1,
      providerCursor: terminal.providerCursor,
      livePollSequence: generation,
      confirmedAt: at(21 + generation),
    })
  return { registry, store, daemon, sessionId, base, terminal, observe, confirm }
}

describe('durable terminal hibernation proof', () => {
  it('keeps explicit legacy hibernation proof-free', () => {
    const registry = new SessionRegistry()
    registry.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/repo',
    })
    registry.modules.sessions.onDaemonMessageFrom('local', {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/repo',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    registry.modules.sessions.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'legacy-session' },
    })
    registry.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentState',
      sessionId,
      state: runtime('idle', 1, { idle: { kind: 'done' } }),
    })

    expect(registry.modules.sessions.hasValidTerminalProof(sessionId)).toBe(false)
    expect(registry.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
  })

  it('qualifies one unchanged live terminal exactly once', () => {
    const { registry, store, daemon, sessionId, confirm } = harness()
    expect(registry.modules.sessions.hasValidTerminalProof(sessionId)).toBe(false)
    confirm(1)
    expect(registry.modules.sessions.hasValidTerminalProof(sessionId)).toBe(true)

    expect(
      registry.modules.sessions.hibernateSession({ sessionId, requireTerminalProof: true }),
    ).toEqual({ ok: true })
    expect(registry.modules.sessions.hasValidTerminalProof(sessionId)).toBe(false)
    expect(store.observationCheckpoints.getTerminalCandidate(sessionId)?.consumedAt).toBeTruthy()
    expect(daemon.filter((message) => message.type === 'kill')).toHaveLength(1)
    expect(
      registry.modules.sessions.hibernateSession({ sessionId, requireTerminalProof: true }).ok,
    ).toBe(false)
    expect(daemon.filter((message) => message.type === 'kill')).toHaveLength(1)
  })

  it.each([
    'input',
    'output',
    'queue',
  ] as const)('cancels a confirmed proof after newer %s', (kind) => {
    const { registry, sessionId, confirm } = harness()
    confirm(1)
    expect(registry.modules.sessions.hasValidTerminalProof(sessionId)).toBe(true)
    if (kind === 'input') registry.modules.sessions.sendText({ sessionId, text: 'new turn' })
    if (kind === 'queue') registry.modules.sessions.queueText({ sessionId, text: 'queued turn' })
    if (kind === 'output')
      registry.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentFrame',
        sessionId,
        seq: 1,
        data: Buffer.from('late output').toString('base64'),
      })
    expect(registry.modules.sessions.hasValidTerminalProof(sessionId)).toBe(false)
    expect(
      registry.modules.sessions.hibernateSession({ sessionId, requireTerminalProof: true }).ok,
    ).toBe(false)
  })

  it('cannot use a stale proof after a real new prompt', () => {
    const { registry, sessionId, base, observe, confirm } = harness()
    confirm(1)
    observe({
      ...base,
      providerCursor: { segmentId: 'rollout-1', components: { file: 30 } },
      providerAt: at(30),
      receivedAt: at(31),
      sourceEventKind: 'task_started',
      transitionKind: 'turn_opened',
      provenance: 'live',
      turnEpoch: 2,
      providerTurnId: 'turn-2',
      providerPromptId: 'prompt-2',
      priorPhase: 'idle',
      nextPhase: 'working',
      transitionId: 'turn-2-open',
      state: runtime('working', 30),
    })
    expect(registry.modules.sessions.hasValidTerminalProof(sessionId)).toBe(false)
    expect(
      registry.modules.sessions.hibernateSession({ sessionId, requireTerminalProof: true }).ok,
    ).toBe(false)
  })

  it('requires two completed live confirmations for a bootstrap-only terminal', () => {
    const { registry, store, sessionId, terminal } = harness({ terminalProvenance: 'bootstrap' })
    expect(store.observationCheckpoints.getTerminalCandidate(sessionId)).toBeNull()
    expect(
      store.sessions.loadSessions().find((session) => session.id === sessionId)?.activityCount ?? 0,
    ).toBe(0)
    // A legacy/bootstrap-reconciled terminal has no live edge to arm pass one.
    const lease = store.observationCheckpoints.get(sessionId)
    expect(lease?.checkpoint?.terminalFence?.transitionId).toBe(terminal.transitionId)
    const message = (generation: number) =>
      registry.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentObserverLiveConfirmation',
        sessionId,
        provider: 'codex',
        providerSessionId: 'thread-1',
        bindingVersion: 1,
        observerGeneration: 1,
        providerCursor: terminal.providerCursor,
        livePollSequence: generation,
        confirmedAt: at(40 + generation),
      })
    message(1)
    expect(registry.modules.sessions.hasValidTerminalProof(sessionId)).toBe(false)
    message(1)
    expect(registry.modules.sessions.hasValidTerminalProof(sessionId)).toBe(false)
    message(2)
    expect(registry.modules.sessions.hasValidTerminalProof(sessionId)).toBe(true)
  })

  it('leaves lifecycle and kill side effects untouched when atomic consume loses a race', () => {
    const { registry, store, daemon, sessionId, confirm } = harness()
    confirm(1)
    const proofBefore = store.observationCheckpoints.getTerminalCandidate(sessionId)
    const autoContinue = (
      registry.modules.sessions as unknown as {
        autoContinue: { onSessionGone(sessionId: string): void }
      }
    ).autoContinue
    const gone = vi.spyOn(autoContinue, 'onSessionGone')
    vi.spyOn(store.observationCheckpoints, 'consumeTerminalCandidate').mockReturnValue(false)
    const beforeKills = daemon.filter((message) => message.type === 'kill').length

    expect(
      registry.modules.sessions.hibernateSession({ sessionId, requireTerminalProof: true }),
    ).toEqual({ ok: false, reason: 'terminal proof changed before hibernation' })
    expect(
      registry.modules.sessions.listSessions().find((session) => session.sessionId === sessionId)
        ?.status,
    ).toBe('live')
    expect(store.observationCheckpoints.getTerminalCandidate(sessionId)).toEqual(proofBefore)
    expect(gone).not.toHaveBeenCalled()
    expect(daemon.filter((message) => message.type === 'kill')).toHaveLength(beforeKills)
  })

  it('manual stop cancels the proof and auto-reap cannot double-act', async () => {
    const { registry, daemon, sessionId, confirm } = harness()
    confirm(1)
    expect((await registry.modules.sessions.stopSession({ sessionId })).ok).toBe(true)
    const kills = daemon.filter((message) => message.type === 'kill').length
    expect(
      registry.modules.sessions.hibernateSession({ sessionId, requireTerminalProof: true }).ok,
    ).toBe(false)
    expect(daemon.filter((message) => message.type === 'kill')).toHaveLength(kills)
  })

  it('cancels pass one on exact rebind and requires two polls after a new generation', () => {
    const rebound = harness()
    rebound.registry.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservationRebind',
      sessionId: rebound.sessionId,
      provider: 'codex',
      providerSessionId: 'thread-1',
      observerGeneration: 1,
      bindingVersion: 1,
      nextProviderSessionId: 'thread-2',
      resumeKind: 'codex-thread',
      rebindId: 'proof-rebind',
    })
    expect(rebound.store.observationCheckpoints.getTerminalCandidate(rebound.sessionId)).toBeNull()

    const restarted = harness()
    restarted.store.observationCheckpoints.advanceGeneration(
      restarted.sessionId,
      'codex',
      'thread-1',
    )
    const confirm = (livePollSequence: number) =>
      restarted.registry.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentObserverLiveConfirmation',
        sessionId: restarted.sessionId,
        provider: 'codex',
        providerSessionId: 'thread-1',
        bindingVersion: 1,
        observerGeneration: 2,
        providerCursor: restarted.terminal.providerCursor,
        livePollSequence,
        confirmedAt: at(50 + livePollSequence),
      })
    confirm(1)
    expect(restarted.registry.modules.sessions.hasValidTerminalProof(restarted.sessionId)).toBe(
      false,
    )
    confirm(2)
    expect(restarted.registry.modules.sessions.hasValidTerminalProof(restarted.sessionId)).toBe(
      true,
    )
  })

  it('fails closed for non-resumable terminals and accepts session-terminal edges', () => {
    const nonresumable = harness({ resumable: false })
    nonresumable.confirm(1)
    expect(
      nonresumable.registry.modules.sessions.hasValidTerminalProof(nonresumable.sessionId),
    ).toBe(false)
    const ended = harness({ terminalTransitionKind: 'session_terminal', terminalPhase: 'ended' })
    expect(ended.store.observationCheckpoints.getTerminalCandidate(ended.sessionId)).not.toBeNull()
  })

  it('arms pass one when last-subagent bookkeeping stabilizes a terminal fence', () => {
    const h = harness({ closing: true })
    expect(h.store.observationCheckpoints.getTerminalCandidate(h.sessionId)).toBeNull()
    h.observe({
      ...h.terminal,
      providerCursor: { segmentId: 'rollout-1', components: { file: 25 } },
      receivedAt: at(25),
      sourceEventKind: 'subagent_bookkeeping',
      transitionKind: 'subagent_bookkeeping',
      priorPhase: 'idle',
      nextPhase: 'idle',
      transitionId: 'last-child-stopped',
      state: runtime('idle', 20, { idle: { kind: 'done' }, nativeSubagentCount: 0 }),
    })
    expect(h.store.observationCheckpoints.getTerminalCandidate(h.sessionId)).not.toBeNull()
  })

  it('sees pending mail older than 500 newer ledger rows', () => {
    const h = harness()
    for (let index = 0; index <= 500; index += 1) {
      const id = `mail-${String(index).padStart(3, '0')}`
      h.store.messages.addMessage({
        id,
        threadId: id,
        inReplyTo: null,
        fromKind: 'system',
        fromSession: null,
        fromIssue: null,
        toKind: 'session',
        toId: h.sessionId,
        kind: 'message',
        urgency: 'fyi',
        lifecycle: 'wait',
        body: 'mail',
        expiresAt: null,
        createdAt: new Date(Date.UTC(2026, 6, 19, 12, 0, 0, index)).toISOString(),
        status: index === 0 ? 'queued' : 'read',
        deliveredAt: null,
        deliveredTo: null,
        ackedBy: null,
        hop: 0,
        clampedFrom: null,
        remindedAt: null,
      })
    }
    h.confirm(1)
    h.confirm(2)
    expect(h.registry.modules.sessions.hasValidTerminalProof(h.sessionId)).toBe(false)
  })

  it('uses delivery semantics for pending response proof', () => {
    const h = harness()
    const add = (
      id: string,
      status: 'delivered' | 'read',
      expectsResponse: boolean,
      expiresAt: string | null,
    ) =>
      h.store.messages.addMessage({
        id,
        threadId: id,
        inReplyTo: null,
        fromKind: 'system',
        fromSession: null,
        fromIssue: null,
        toKind: 'session',
        toId: h.sessionId,
        kind: 'message',
        urgency: 'fyi',
        lifecycle: 'wait',
        body: id,
        expiresAt,
        createdAt: at(1),
        status,
        deliveredAt: at(2),
        deliveredTo: h.sessionId,
        ackedBy: null,
        hop: 0,
        clampedFrom: null,
        remindedAt: null,
        expectsResponse,
      })
    add('ordinary-fyi', 'delivered', false, null)
    add('expired-request', 'delivered', true, at(1))
    expect(h.store.messages.pendingForSessionProof(h.sessionId, at(30))).toEqual([])
    add('read-request', 'read', true, null)
    expect(
      h.store.messages.pendingForSessionProof(h.sessionId, at(30)).map((row) => row.id),
    ).toEqual(['read-request'])
  })

  it('keeps consumed proof inert under late causal, confirmation, and legacy frames', () => {
    const h = harness()
    h.confirm(1)
    expect(
      h.registry.modules.sessions.hibernateSession({
        sessionId: h.sessionId,
        requireTerminalProof: true,
      }),
    ).toEqual({ ok: true })
    const checkpoint = h.store.observationCheckpoints.get(h.sessionId)
    const proof = h.store.observationCheckpoints.getTerminalCandidate(h.sessionId)
    const effects: unknown[] = []
    h.registry.bus.on('session.stateChanged', (event) => effects.push(event))
    h.observe({
      ...h.base,
      providerCursor: { segmentId: 'rollout-1', components: { file: 30 } },
      provenance: 'live',
      transitionKind: 'turn_opened',
      turnEpoch: 2,
      priorPhase: 'idle',
      nextPhase: 'working',
      transitionId: 'late-working',
      state: runtime('working', 30),
    })
    h.confirm(2)
    h.registry.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentState',
      sessionId: h.sessionId,
      state: runtime('working', 31),
    })
    expect(
      h.registry.modules.sessions.listSessions().find((row) => row.sessionId === h.sessionId)
        ?.status,
    ).toBe('hibernated')
    expect(h.store.observationCheckpoints.get(h.sessionId)).toEqual(checkpoint)
    expect(h.store.observationCheckpoints.getTerminalCandidate(h.sessionId)).toEqual(proof)
    expect(effects).toEqual([])
  })
})
