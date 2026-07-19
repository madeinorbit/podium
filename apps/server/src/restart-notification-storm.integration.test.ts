import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentObservation,
  AgentRuntimeState,
  ControlMessage,
  ObservationProvider,
  ServerMessage,
} from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

type RestartKind = 'daemon-only' | 'server-only' | 'server-and-daemon'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const at = (minute: number) => `2026-07-19T${String(minute).padStart(2, '0')}:00:00.000Z`

function runtime(
  phase: AgentRuntimeState['phase'],
  minute: number,
  extra: Partial<AgentRuntimeState> = {},
): AgentRuntimeState {
  return {
    phase,
    since: at(minute),
    workingMsTotal: 0,
    nativeSubagentCount: 0,
    ...extra,
  }
}

function observation(input: {
  sessionId: string
  provider: ObservationProvider
  providerSessionId: string
  generation: number
  cursor: number
  epoch: number
  transitionId: string
  provenance: AgentObservation['provenance']
  transitionKind: AgentObservation['transitionKind']
  prior: AgentRuntimeState['phase']
  state: AgentRuntimeState
  providerAt: string
  sourceEventKind: string
}): AgentObservation {
  return {
    podiumSessionId: input.sessionId,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    bindingVersion: 1,
    providerTurnId: `turn-${input.epoch}`,
    providerPromptId: `prompt-${input.epoch}`,
    observerGeneration: input.generation,
    providerCursor: {
      segmentId: `${input.provider}:${input.providerSessionId}:terminal-fixture`,
      pathHint: `/isolated/${input.providerSessionId}/history.jsonl`,
      device: 'fixture-device',
      inode: 'fixture-inode',
      components: { file: input.cursor },
    },
    providerAt: input.providerAt,
    receivedAt: at(23),
    sourceEventKind: input.sourceEventKind,
    transitionKind: input.transitionKind,
    provenance: input.provenance,
    inputOrigin: 'provider',
    turnEpoch: input.epoch,
    priorPhase: input.prior,
    nextPhase: input.state.phase,
    transitionId: input.transitionId,
    state: input.state,
  }
}

function durableCounts(
  store: SessionStore,
  childId: string,
  parentId: string,
): {
  phaseRows: number
  notificationFacts: number
  queuedParentNudges: number
} {
  return {
    phaseRows: store.events
      .listEventsSince(0, { kinds: ['session.phase'] })
      .filter((event) => event.subject === childId).length,
    notificationFacts: store.notificationFacts.hasActive(
      `sessionparentnudge:phase-reported:${childId}`,
      parentId,
      at(23),
    )
      ? 1
      : 0,
    queuedParentNudges: store.messages
      .listQueued()
      .filter((message) => message.fromKind === 'system' && message.body.includes(childId)).length,
  }
}

describe('isolated restart notification-storm acceptance [spec:SP-cdb2]', () => {
  it.each([
    ['claude-code', 'claude-terminal-fixture'],
    ['codex', 'codex-terminal-fixture'],
    ['grok', 'grok-terminal-fixture'],
  ] as const)(
    '%s frozen history stays effect-free through daemon, server, and combined restarts',
    async (provider, providerSessionId) => {
      const root = mkdtempSync(join(tmpdir(), `podium-restart-storm-${provider}-`))
      roots.push(root)
      const dbPath = join(root, 'state', 'podium.db')
      const ntfy = vi.fn()
      const telegram = vi.fn()
      const web: ServerMessage[] = []
      let store = new SessionStore(dbPath)
      let registry = new SessionRegistry(store, { ntfy, telegram })
      const controls: ControlMessage[] = []
      const attach = () =>
        registry.modules.sessions.attachDaemon('local', (msg) => controls.push(msg))
      attach()
      registry.modules.settings.setSettings(
        normalizeSettings({
          notifications: {
            web: true,
            ntfyTopic: 'isolated-restart-storm',
            telegramBotToken: 'fixture-token',
            telegramChatId: 'fixture-chat',
          },
          experimental: { notifications: true },
          autoContinue: { enabled: true, promptDismissed: true },
        }),
      )
      registry.modules.sessions.attachClient((message) => web.push(message))
      const parentId = `parent-${provider}`
      const childId = `child-${provider}`
      registry.modules.sessions.createSession({
        sessionId: parentId,
        agentKind: 'claude-code',
        cwd: join(root, 'parent'),
      })
      registry.modules.sessions.createSession({
        sessionId: childId,
        agentKind: provider,
        cwd: join(root, 'child'),
        spawnedBy: `session:${parentId}`,
      })
      registry.modules.sessions.onDaemonMessageFrom('local', {
        type: 'sessionResumeRef',
        sessionId: childId,
        resume: {
          kind:
            provider === 'claude-code'
              ? 'claude-session'
              : provider === 'codex'
                ? 'codex-thread'
                : 'grok-session',
          value: providerSessionId,
        },
        confidence: 'exact',
      })

      const currentGeneration = (): number => {
        const lease = store.observationCheckpoints.get(childId)
        if (!lease) throw new Error('missing observation lease')
        return lease.observationGeneration
      }
      const deliver = (value: AgentObservation) =>
        registry.modules.sessions.onDaemonMessageFrom('local', {
          type: 'agentObservation',
          observation: value,
        })
      const frozen = (generation: number) =>
        observation({
          sessionId: childId,
          provider,
          providerSessionId,
          generation,
          cursor: 100,
          epoch: 1,
          transitionId: `${provider}:frozen-terminal`,
          provenance: 'bootstrap',
          transitionKind: 'snapshot',
          prior: 'errored',
          state: runtime('errored', 1, {
            error: { class: 'server_error', retryable: true },
          }),
          providerAt: at(1),
          sourceEventKind: 'terminal_fixture_fold',
        })

      const originalRecency = store.sessions
        .loadSessions()
        .find((row) => row.id === childId)?.lastActiveAt
      const bootstrapAcks: Array<{
        kind: 'initial' | RestartKind
        generation: number
        result: Extract<ControlMessage, { type: 'agentObservationAck' }>['result']
      }> = []
      const deliverBootstrap = (kind: 'initial' | RestartKind, value: AgentObservation): void => {
        const before = controls.filter(
          (message) =>
            message.type === 'agentObservationAck' &&
            message.sessionId === childId &&
            message.observerGeneration === value.observerGeneration,
        ).length
        deliver(value)
        const acks = controls.filter(
          (message): message is Extract<ControlMessage, { type: 'agentObservationAck' }> =>
            message.type === 'agentObservationAck' &&
            message.sessionId === childId &&
            message.observerGeneration === value.observerGeneration,
        )
        expect(acks).toHaveLength(before + 1)
        const lastAck = acks.at(-1)
        if (!lastAck) throw new Error('missing bootstrap acknowledgement')
        bootstrapAcks.push({
          kind,
          generation: value.observerGeneration,
          result: lastAck.result,
        })
      }
      deliverBootstrap('initial', frozen(currentGeneration()))
      const frozenCheckpoint = store.observationCheckpoints.get(childId)?.checkpoint
      if (!frozenCheckpoint) throw new Error('missing frozen checkpoint')
      expect(store.sessions.loadSessions().find((row) => row.id === childId)?.lastActiveAt).toBe(
        originalRecency,
      )
      expect(store.observationCheckpoints.getTerminalCandidate(childId)).toBeNull()

      const bootstrapSnapshots: Array<{ kind: RestartKind; generation: number }> = []
      const restart = (kind: RestartKind): void => {
        controls.length = 0
        if (kind === 'daemon-only') {
          // The server survives. Replacing the daemon forces a provider-history
          // fold against the durable checkpoint after the new lease is issued.
          registry.modules.sessions.detachDaemon('local')
          attach()
        } else {
          // Both server restart modes reopen the durable store. Their daemon
          // mechanics differ below: a surviving daemon resends its held snapshot;
          // a replaced daemon folds the frozen provider fixture again.
          registry.dispose()
          store.close()
          store = new SessionStore(dbPath)
          registry = new SessionRegistry(store, { ntfy, telegram })
          registry.modules.sessions.attachClient((message) => web.push(message))
          attach()
        }
        const generation = currentGeneration()
        bootstrapSnapshots.push({ kind, generation })
        if (kind === 'server-only') {
          const held = store.observationCheckpoints.get(childId)?.checkpoint
          if (!held?.providerCursor) throw new Error('missing daemon-held checkpoint')
          deliverBootstrap(kind, {
            ...frozen(generation),
            providerCursor: held.providerCursor,
            providerAt: held.providerAt,
            providerTurnId: held.providerTurnId,
            providerPromptId: held.providerPromptId,
            turnEpoch: held.turnEpoch,
            priorPhase: held.turnState.phase,
            nextPhase: held.turnState.phase,
            state: held.turnState,
            transitionId: held.lastTransitionId ?? `${provider}:held-snapshot`,
            sourceEventKind: 'daemon_held_snapshot',
          })
        } else {
          deliverBootstrap(kind, frozen(generation))
        }
      }

      for (const kind of ['daemon-only', 'server-only', 'server-and-daemon'] as const) {
        restart(kind)
        restart(kind)
      }
      await registry.runStewardTick()

      expect(bootstrapSnapshots).toHaveLength(6)
      expect(new Set(bootstrapSnapshots.map((entry) => entry.generation)).size).toBe(6)
      expect(bootstrapAcks).toHaveLength(7)
      expect(bootstrapAcks[0]?.result).toBe('snapshot_applied')
      expect(bootstrapAcks.slice(1).every((ack) => ack.result === 'rejected')).toBe(true)
      expect(store.events.listEventsSince(0, { kinds: ['session.phase'] })).toEqual([])
      expect(store.sessions.loadSessions().find((row) => row.id === childId)?.lastActiveAt).toBe(
        originalRecency,
      )
      expect(
        store.sessions.loadSessions().find((row) => row.id === childId)?.activityCount ?? 0,
      ).toBe(0)
      expect(store.observationCheckpoints.getTerminalCandidate(childId)).toBeNull()
      expect(store.sync.listQueuedMessages(childId)).toEqual([])
      expect(ntfy).not.toHaveBeenCalled()
      expect(telegram).not.toHaveBeenCalled()
      expect(web.filter((message) => message.type === 'attentionEvent')).toEqual([])
      expect(durableCounts(store, childId, parentId)).toEqual({
        phaseRows: 0,
        notificationFacts: 0,
        queuedParentNudges: 0,
      })

      const generation = currentGeneration()
      const working = observation({
        sessionId: childId,
        provider,
        providerSessionId,
        generation,
        cursor: 200,
        epoch: 2,
        transitionId: `${provider}:live-working`,
        provenance: 'live',
        transitionKind: 'turn_opened',
        prior: 'errored',
        state: runtime('working', 20),
        providerAt: at(20),
        sourceEventKind: 'provider_prompt_confirmed',
      })
      const terminal = observation({
        sessionId: childId,
        provider,
        providerSessionId,
        generation,
        cursor: 300,
        epoch: 2,
        transitionId: `${provider}:live-terminal`,
        provenance: 'live',
        transitionKind: 'turn_terminal',
        prior: 'working',
        state: runtime('errored', 21, {
          error: { class: 'server_error', retryable: false },
        }),
        providerAt: at(21),
        sourceEventKind: 'provider_terminal_confirmed',
      })
      deliver(working)
      deliver(terminal)
      deliver(terminal)
      await registry.runStewardTick()
      await registry.runStewardTick()

      const phaseEvents = store.events.listEventsSince(0, { kinds: ['session.phase'] })
      expect(
        phaseEvents.map((event) => (event.payload as { transitionId: string }).transitionId),
      ).toEqual([`${provider}:live-working`, `${provider}:live-terminal`])
      expect(ntfy).toHaveBeenCalledTimes(1)
      expect(telegram).toHaveBeenCalledTimes(1)
      expect(web.filter((message) => message.type === 'attentionEvent')).toHaveLength(1)
      expect(
        store.notificationFacts.hasActive(
          `sessionparentnudge:phase-reported:${childId}`,
          parentId,
          at(23),
        ),
      ).toBe(true)
      const candidate = store.observationCheckpoints.getTerminalCandidate(childId)
      expect(candidate).not.toBeNull()
      expect(durableCounts(store, childId, parentId)).toMatchObject({
        phaseRows: 2,
        notificationFacts: 1,
      })
      expect(durableCounts(store, childId, parentId).queuedParentNudges).toBeLessThanOrEqual(1)

      const effectsBeforeFinalRestart = {
        ntfy: ntfy.mock.calls.length,
        telegram: telegram.mock.calls.length,
        web: web.filter((message) => message.type === 'attentionEvent').length,
        facts: durableCounts(store, childId, parentId),
      }
      const checkpoint = store.observationCheckpoints.get(childId)?.checkpoint
      if (!checkpoint) throw new Error('missing live checkpoint')
      restart('server-and-daemon')
      expect(bootstrapAcks).toHaveLength(8)
      expect(new Set(bootstrapAcks.map((ack) => ack.generation)).size).toBe(8)
      expect(bootstrapAcks.at(-1)?.result).toBe('rejected')
      await registry.runStewardTick()
      expect(ntfy).toHaveBeenCalledTimes(effectsBeforeFinalRestart.ntfy)
      expect(telegram).toHaveBeenCalledTimes(effectsBeforeFinalRestart.telegram)
      expect(web.filter((message) => message.type === 'attentionEvent')).toHaveLength(
        effectsBeforeFinalRestart.web,
      )
      expect(durableCounts(store, childId, parentId)).toEqual(effectsBeforeFinalRestart.facts)
      expect(store.observationCheckpoints.getTerminalCandidate(childId)).toEqual(candidate)
      expect(store.observationCheckpoints.get(childId)?.checkpoint).toEqual(checkpoint)

      registry.dispose()
      store.close()
    },
    30_000,
  )
})
