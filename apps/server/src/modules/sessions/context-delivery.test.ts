import {
  createTerminalRuntime,
  type TerminalHarnessProfile,
  type TerminalHostPorts,
} from '@podium/harness/driver/host'
import { type AgentKind, asMachineId, asSessionId, firstAdminMemberId } from '@podium/model'
import type { ContextObservation, RuntimeEvent, SessionSnapshot } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  contextFixtureAt,
  contextFixtureCausal,
  installContextFixture,
} from '../../../../../packages/harness/src/driver/testing/context-fixture'
import { createMemoryDriverSlots } from '../../../../../packages/harness/src/driver/testing/driver-slots'
import { SessionDaemonProjection, type SessionDaemonProjectionPorts } from './daemon-projection'
import { conditionOf } from './live-topics'
import { Session } from './session'

const sessionId = asSessionId('context-projection-session')
const machineId = asMachineId('context-projection-machine')
const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
})
function projection() {
  const session = new Session({
    sessionId,
    machineId,
    ownerUserId: firstAdminMemberId(),
    agentKind: 'codex',
    durableLabel: 'invented-context-projection',
    cwd: '/tmp/invented',
    title: 'Invented context delivery',
    origin: { kind: 'spawn' },
    createdAt: contextFixtureAt,
    geometry: { cols: 80, rows: 24 },
    toDaemon: vi.fn(),
  })
  const writes = vi.fn(() => {
    throw new Error('Context telemetry must not be persisted')
  })
  const broadcast = vi.fn()
  const ports = {
    sessions: new Map([[sessionId, session]]),
    persist: writes,
    persistDraft: writes,
    write: writes,
    broadcastSessions: broadcast,
  } as unknown as SessionDaemonProjectionPorts
  return { session, writes, broadcast, projection: new SessionDaemonProjection(ports) }
}
const profile: TerminalHarnessProfile = {
  driverId: 'generic-pty',
  instrumentationRequired: false,
  composerReadiness: 'on-bind',
  sendProof: ['transcript-echo'],
  transcriptTimestamps: 'absent',
  needsSubmitVerification: false,
  usesRawFirstTurn: false,
  archivable: false,
  reportsContextPercent: false,
  interruptBytes: '\u001b',
  interruptQuitsWhenIdle: false,
}
function event(observation: ContextObservation): RuntimeEvent {
  const { context, ...causal } = observation
  return { ...causal, t: 'metadata', change: { kind: 'context-observation', context } }
}

describe('fake native context through real generic composition', () => {
  it('accepts same-cursor enrichment by revision, rejects reverse replay and restores an unchanged offline sample', async () => {
    const f = projection()
    const original: ContextObservation = {
      ...contextFixtureCausal(10),
      context: {
        version: 1,
        status: 'available',
        sample: {
          bindingVersion: 1,
          observerGeneration: 1,
          contextRevision: 1,
          turnEpoch: 0,
          id: 'count-only',
          at: contextFixtureAt,
        },
        occupancy: {
          basis: 'current-context',
          percent: { value: 42, accuracy: 'reported', source: 'invented source' },
        },
      },
    }
    await f.projection.runtimeEvent(sessionId, event(original))
    if (original.context.status !== 'available') throw new Error('No invented native sample')
    const enriched: ContextObservation = {
      ...original,
      context: {
        ...original.context,
        sample: { ...original.context.sample, id: 'enriched', contextRevision: 2 },
      },
    }
    await f.projection.runtimeEvent(sessionId, event(enriched))
    await f.projection.runtimeEvent(sessionId, event(original))
    expect(f.session.contextObservation).toEqual(enriched)
    f.session.markContextOffline()
    await f.projection.metadataSnapshot(sessionId, {
      binding: {
        sessionId,
        driver: 'generic-pty',
        family: 'terminal',
        harness: 'fixture',
        workdir: '/tmp/invented',
        resume: null,
        process: { key: 'invented' },
        bindingVersion: 1,
      },
      context: enriched,
      at: contextFixtureAt,
      cursor: enriched.cursor,
      observerGeneration: 1,
      turnEpoch: 0,
      state: { phase: 'idle', since: contextFixtureAt, nativeSubagentCount: 0 },
      interactions: [],
    } as SessionSnapshot)
    expect(f.session.contextObservation).toEqual(enriched)
    expect(f.writes).not.toHaveBeenCalled()
  })

  it('scopes ordering to the admitted binding before reset generation/revision and ignores late old empty snapshots', async () => {
    const f = projection()
    const observation = (
      bindingVersion: number,
      generation: number,
      revision: number,
      id: string,
    ): ContextObservation => ({
      ...contextFixtureCausal(10, generation),
      context: {
        version: 1,
        status: 'available',
        sample: {
          bindingVersion,
          observerGeneration: generation,
          contextRevision: revision,
          turnEpoch: 0,
          id,
          at: contextFixtureAt,
        },
        occupancy: {
          basis: 'current-context',
          percent: { value: 42, accuracy: 'reported', source: 'invented source' },
        },
      },
    })
    await f.projection.runtimeEvent(sessionId, event(observation(1, 9, 5, 'old-binding')))
    const empty = (bindingVersion: number, generation: number): SessionSnapshot =>
      ({
        binding: {
          sessionId,
          driver: 'generic-pty',
          family: 'terminal',
          harness: 'fixture',
          workdir: '/tmp/invented',
          resume: null,
          process: { key: 'invented' },
          bindingVersion,
        },
        at: contextFixtureAt,
        cursor: contextFixtureCausal(10).cursor,
        observerGeneration: generation,
        turnEpoch: 0,
        state: { phase: 'idle', since: contextFixtureAt, nativeSubagentCount: 0 },
        interactions: [],
      }) as SessionSnapshot
    await f.projection.metadataSnapshot(sessionId, empty(2, 1))
    expect(f.session.contextObservation?.context).toMatchObject({
      status: 'unavailable',
      revision: { bindingVersion: 2, observerGeneration: 1, contextRevision: 0 },
    })
    const current = observation(2, 1, 1, 'new-binding')
    await f.projection.runtimeEvent(sessionId, event(current))
    await f.projection.metadataSnapshot(sessionId, empty(1, 99))
    await f.projection.runtimeEvent(sessionId, event(observation(1, 99, 99, 'late-old-binding')))
    expect(f.session.contextObservation).toEqual(current)
    expect(f.writes).not.toHaveBeenCalled()
  })
  it('forwards opaque callback payloads before terminal receipt/lifecycle filtering', async () => {
    const adapter = installContextFixture()
    releases.push(adapter.release)
    const frames: RuntimeEvent[] = []
    const runtime = createTerminalRuntime(
      {
        now: () => Date.parse(contextFixtureAt),
        send: (frame: { type: string; event?: RuntimeEvent }) => {
          if (frame.type === 'runtimeEvent' && frame.event) frames.push(frame.event)
        },
      } as unknown as TerminalHostPorts,
      undefined,
      createMemoryDriverSlots(),
    )
    releases.push(() => runtime.dispose())
    const handle = runtime.register(
      {
        sessionId,
        agentKind: 'fixture' as AgentKind,
        cwd: '/tmp/invented',
        resume: { kind: 'claude-session', value: 'invented-primary' },
      },
      profile,
    )
    runtime.onHookPayload(sessionId, {
      id: 'status-only',
      percent: 50,
      nativeSessionId: 'invented-primary',
    })
    expect((await handle.snapshot()).context?.context).toMatchObject({
      status: 'available',
      sample: { id: 'status-only' },
    })
    expect(frames).toContainEqual(
      expect.objectContaining({
        t: 'metadata',
        change: { kind: 'context-observation', context: expect.any(Object) },
      }),
    )
  })
  it('publishes coarse context, reconnects with original identity, clears and recovers without process or persistence calls', async () => {
    const adapter = installContextFixture()
    releases.push(adapter.release)
    const f = projection()
    const frames: RuntimeEvent[] = []
    const pending: Promise<void>[] = []
    const host = {
      now: () => Date.parse(contextFixtureAt),
      trackedState: () => undefined,
      draftSyncing: () => false,
      stopSession: vi.fn(async () => true),
      setTimer: setTimeout,
      clearTimer: clearTimeout,
      send: (frame: { type: string; event?: RuntimeEvent }) => {
        if (frame.type === 'runtimeEvent' && frame.event) {
          frames.push(frame.event)
          pending.push(f.projection.runtimeEvent(sessionId, frame.event))
        }
      },
    } as unknown as TerminalHostPorts
    const runtime = createTerminalRuntime(host, undefined, createMemoryDriverSlots())
    releases.push(() => runtime.dispose())
    const register = (generation: number) =>
      runtime.register(
        {
          sessionId,
          agentKind: 'fixture' as AgentKind,
          cwd: '/tmp/invented',
          resume: { kind: 'claude-session', value: 'invented-primary' },
          observerGeneration: generation,
          bindingVersion: generation,
          rebind: generation > 1,
        },
        profile,
      )
    const handle = register(1)
    const causal = contextFixtureCausal(10)
    runtime.observeContextPayload(
      sessionId,
      { id: 'first', percent: 0, nativeSessionId: 'invented-primary' },
      causal,
    )
    await Promise.all(pending.splice(0))
    expect(frames).toContainEqual(
      expect.objectContaining({
        ...causal,
        t: 'metadata',
        change: { kind: 'context-observation', context: expect.any(Object) },
      }),
    )
    expect(conditionOf(f.session)).toMatchObject({
      context: {
        status: 'available',
        sample: { id: 'first', at: causal.at },
        occupancy: { percent: { value: 0 } },
      },
      contextUsagePercent: 0,
    })
    f.session.requestedModel = 'requested-next-turn-model'
    expect(conditionOf(f.session).context).toMatchObject({
      model: { modelId: 'invented-native-model' },
    })
    runtime.loseContext(sessionId)
    await Promise.all(pending.splice(0))
    expect(conditionOf(f.session).context?.status).toBe('stale')
    await handle.context?.summary({ timeoutMs: 100 })
    await Promise.all(pending.splice(0))
    expect(conditionOf(f.session).context?.status).toBe('available')
    const snapshot = await handle.snapshot()
    expect(snapshot.context).toEqual(f.session.contextObservation)
    const reconnected = projection()
    await reconnected.projection.metadataSnapshot(sessionId, snapshot as SessionSnapshot)
    expect(conditionOf(reconnected.session)).toEqual(conditionOf(f.session))
    reconnected.session.markContextOffline()
    expect(conditionOf(reconnected.session).context?.status).toBe('stale')
    runtime.invalidateContext(sessionId)
    await Promise.all(pending.splice(0))
    expect(conditionOf(f.session).context?.status).toBe('pending')
    expect(conditionOf(f.session).contextUsagePercent).toBeUndefined()
    runtime.observeContextPayload(
      sessionId,
      { id: 'after-reset', percent: 125, nativeSessionId: 'invented-primary' },
      contextFixtureCausal(11),
    )
    await Promise.all(pending.splice(0))
    expect(conditionOf(f.session).context).toMatchObject({
      status: 'available',
      occupancy: { percent: { value: 125 } },
    })
    expect(conditionOf(f.session).contextUsagePercent).toBeUndefined()
    await f.projection.metadataSnapshot(sessionId, snapshot as SessionSnapshot)
    expect(conditionOf(f.session).context).toMatchObject({ sample: { id: 'after-reset' } })
    register(2)
    await Promise.all(pending.splice(0))
    expect(conditionOf(f.session).context).toMatchObject({
      status: 'pending',
      revision: { observerGeneration: 2, bindingVersion: 2 },
    })
    runtime.observeContextPayload(
      sessionId,
      { id: 'late', percent: 50 },
      contextFixtureCausal(30, 1),
    )
    await Promise.all(pending.splice(0))
    expect(conditionOf(f.session).context?.status).toBe('pending')
    expect(f.writes).not.toHaveBeenCalled()
    expect(host.stopSession).not.toHaveBeenCalled()
  })
})
