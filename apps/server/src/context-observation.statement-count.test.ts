import { asSessionId, type SessionId } from '@podium/model'
import { CAP_SESSION_ACCESS } from '@podium/protocol'
import {
  CAP_CONTEXT_OBSERVATION_V1,
  type RuntimeEventMessage,
  type RuntimeSnapshotRequestMessage,
  type SessionSnapshot,
} from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  quietShipping,
  type StatementPin,
  settledCommand,
  settledOperation,
} from './test-support/statement-count'

interface Fixture {
  reg: SessionRegistry
  store: SessionStore
  ids: SessionId[]
  frame: RuntimeEventMessage
  stored: unknown
  snapshot: SessionSnapshot
  replay(snapshot?: SessionSnapshot): Promise<void>
  holdSnapshots(snapshot?: SessionSnapshot): void
  requestSnapshot(): Promise<void>
  replyPendingSnapshot(snapshot: SessionSnapshot, newest?: boolean): Promise<void>
  release(): void
}
const contextPin = (agentKind: 'codex' | 'opencode', bootstrap = true): StatementPin<Fixture> => ({
  name: `normalized context live admission (${agentKind})`,
  sizes: [3, 24],
  async setup(size) {
    const store = await openTestStore(':memory:')
    const reg = await SessionRegistry.create(store, undefined, {
      instanceId: 'default',
      rehearseBoot: true,
    })
    const at = '2026-11-21T12:00:00.000Z'
    const snapshots = new Map<SessionId, SessionSnapshot>()
    const requests = new Map<string, RuntimeSnapshotRequestMessage>()
    let replyEnabled = bootstrap
    let completedSnapshots = 0
    const snapshotReleases: (() => void)[] = []
    const snapshotOf = (sessionId: SessionId): SessionSnapshot =>
      snapshots.get(sessionId) ?? {
        binding: {
          sessionId,
          driver: 'generic-pty',
          family: 'terminal',
          harness: agentKind,
          workdir: '/tmp/invented-context',
          resume: null,
          process: { key: 'invented-process' },
          bindingVersion: 1,
        },
        state: { phase: 'idle', since: at, nativeSubagentCount: 0 },
        cursor: { segmentId: 'invented-context-source', components: { seq: 0 } },
        observerGeneration: 1,
        turnEpoch: 0,
        interactions: [],
        at,
      }
    const reply = async (
      request: RuntimeSnapshotRequestMessage,
      snapshot = snapshotOf(request.sessionId),
    ) => {
      requests.delete(request.requestId)
      await reg.gateway.routeDaemonFrame(store.hostMachineId, {
        type: 'runtimeSnapshotResult',
        requestId: request.requestId,
        sessionId: request.sessionId,
        result: { snapshot },
      })
    }
    await settledCommand(() =>
      attachHostDaemon(
        reg,
        (message) => {
          if (message.type !== 'runtimeSnapshotRequest') return
          requests.set(message.requestId, message)
          if (replyEnabled) void reply(message)
        },
        { caps: [CAP_SESSION_ACCESS, CAP_CONTEXT_OBSERVATION_V1] },
      ),
    )
    await quietShipping(reg)
    const bind = async (sessionId: SessionId) => {
      await settledOperation(() =>
        reg.gateway.routeDaemonFrame(store.hostMachineId, {
          type: 'bind',
          sessionId,
          cmd: 'invented context provider',
          cwd: '/tmp/invented-context',
          agentKind,
          driverId: 'generic-pty',
          geometry: { cols: 80, rows: 24 },
        }),
      )
    }
    const ids: SessionId[] = []
    for (let i = 0; i < size; i++) {
      const { sessionId } = await settledCommand(() =>
        reg.modules.sessions.createSession({ agentKind, cwd: '/tmp/invented-context' }),
      )
      const session = reg.modules.sessions.sessions.get(sessionId)
      if (!session) throw new Error('No live invented session')
      const confirm = session.confirmContextBootstrap.bind(session)
      const spy = vi.spyOn(session, 'confirmContextBootstrap').mockImplementation((...args) => {
        const accepted = confirm(...args)
        completedSnapshots++
        return accepted
      })
      snapshotReleases.push(() => spy.mockRestore())
      await bind(sessionId)
      ids.push(sessionId)
    }
    await settledOperation(() => reg.modules.sessions.flushBroadcasts())
    await reg.changeLedger.authority.settled()
    const sessionId = ids[0] ?? asSessionId('missing-test-session')
    if (bootstrap) await vi.waitFor(() => expect(completedSnapshots).toBe(size))
    const lease = await store.observationCheckpoints.get(sessionId)
    if (agentKind === 'codex' && !lease)
      throw new Error('Causal session creation did not issue an observation lease')
    const generation = lease?.observationGeneration ?? 1
    const frame: RuntimeEventMessage = {
      type: 'runtimeEvent',
      sessionId,
      deliveryId: 'invented-context-delivery',
      event: {
        t: 'metadata',
        change: {
          kind: 'context-observation',
          context: {
            version: 1,
            status: 'available',
            sample: {
              id: 'invented-context-sample',
              at,
              bindingVersion: lease?.bindingVersion ?? 1,
              observerGeneration: generation,
              turnEpoch: 0,
              contextRevision: 1,
            },
            occupancy: {
              basis: 'current-context',
              percent: { value: 42, accuracy: 'reported', source: 'invented provider' },
            },
          },
        },
        at,
        provenance: 'live',
        cursor: { segmentId: 'invented-context-source', components: { seq: 1 } },
        observerGeneration: generation,
        turnEpoch: 0,
      },
    }
    return {
      reg,
      store,
      ids,
      frame,
      snapshot: snapshotOf(sessionId),
      stored: await store.sessions.getSession(sessionId),
      release: () => {
        for (const release of snapshotReleases) release()
      },
      holdSnapshots: (snapshot) => {
        replyEnabled = false
        if (snapshot) snapshots.set(sessionId, snapshot)
      },
      requestSnapshot: () => bind(sessionId),
      replyPendingSnapshot: async (snapshot, newest = false) => {
        const pending = [...requests.values()].filter((request) => request.sessionId === sessionId)
        const request = newest ? pending.at(-1) : pending[0]
        if (!request) throw new Error('No held invented snapshot request')
        const before = completedSnapshots
        await reply(request, snapshot)
        await vi.waitFor(() => expect(completedSnapshots).toBeGreaterThan(before))
      },
      replay: async (snapshot) => {
        if (snapshot) snapshots.set(sessionId, snapshot)
        const before = completedSnapshots
        replyEnabled = true
        const pending = [...requests.values()].filter((request) => request.sessionId === sessionId)
        if (pending.length) {
          for (const request of pending) await reply(request)
        } else await bind(sessionId)
        await vi.waitFor(() =>
          expect(completedSnapshots).toBeGreaterThanOrEqual(before + (pending.length || 1)),
        )
      },
    }
  },
  target: (f) => f.store,
  run: async (f) => {
    await settledOperation(() => f.reg.gateway.routeDaemonFrame(f.store.hostMachineId, f.frame))
    await settledOperation(() => f.reg.modules.sessions.flushBroadcasts())
  },
  check: async (_, f) => {
    const sessionId = f.frame.sessionId
    const condition = await f.reg.modules.sessions.liveTopics.snapshot(
      'session.condition',
      sessionId,
    )
    expect(condition).toMatchObject({
      context: { status: 'available', sample: { id: 'invented-context-sample' } },
      contextUsagePercent: 42,
    })
    expect(await f.store.sessions.getSession(sessionId)).toEqual(f.stored)
    expect(await f.store.events.listRuntimeEvents(sessionId)).toEqual([])
    expect(await f.store.events.runtimeEventCheckpoint(sessionId)).toBeNull()
  },
  teardown: async (f) => {
    f.release()
    await f.reg.dispose()
    await f.store.close()
  },
})
const pin = contextPin('codex')

function measurement(
  f: Fixture,
  generation: number,
  bindingVersion: number,
  id: string,
): RuntimeEventMessage {
  const event = f.frame.event
  if (
    event.t !== 'metadata' ||
    event.change.kind !== 'context-observation' ||
    event.change.context.status !== 'available'
  )
    throw new Error('No invented measurement')
  return {
    ...f.frame,
    deliveryId: `invented-${id}`,
    event: {
      ...event,
      observerGeneration: generation,
      change: {
        kind: 'context-observation',
        context: {
          ...event.change.context,
          sample: {
            ...event.change.context.sample,
            id,
            bindingVersion,
            observerGeneration: generation,
          },
        },
      },
    },
  }
}

async function admitGeneration(f: Fixture, generation: number): Promise<void> {
  await settledOperation(() =>
    f.reg.gateway.routeDaemonFrame(f.store.hostMachineId, {
      type: 'runtimeEvent',
      sessionId: f.frame.sessionId,
      deliveryId: `invented-lifecycle-${generation}`,
      event: {
        t: 'state',
        change: { kind: 'state_snapshot', state: f.snapshot.state },
        at: f.snapshot.at,
        provenance: 'bootstrap',
        observerGeneration: generation,
        turnEpoch: 0,
        cursor: { segmentId: 'invented-current-runtime', components: { seq: 1 } },
      },
    }),
  )
}

describe('context telemetry stays live and uses a constant lease read', () => {
  it('reads exactly one lease at small and larger working sets without saving telemetry', async () => {
    await expectConstantStatements(pin, 1)
  })
  it('admits a non-causal harness only within its verified snapshot scope, with one keyed lease read', async () => {
    await expectConstantStatements(contextPin('opencode'), 1)
  })
  it('cannot establish non-causal binding authority from an early telemetry payload', async () => {
    const base = contextPin('opencode', false)
    await expectConstantStatements(
      {
        ...base,
        check: async (_, f) => {
          const condition = await f.reg.modules.sessions.liveTopics.snapshot(
            'session.condition',
            f.frame.sessionId,
          )
          expect(condition?.context).toBeUndefined()
          expect(await f.store.events.runtimeEventCheckpoint(f.frame.sessionId)).toBeNull()
          await f.replay()
          await base.run(f, 0)
          await base.check?.(undefined, f, 0)
        },
      },
      1,
    )
  })
  it('bootstraps non-causal scope through RPC with three fixed reads including live publication', async () => {
    const base = contextPin('opencode', false)
    await expectConstantStatements(
      {
        ...base,
        run: (f) => f.replay(),
        check: async (_, f) => {
          const condition = await f.reg.modules.sessions.liveTopics.snapshot(
            'session.condition',
            f.frame.sessionId,
          )
          expect(condition?.context).toMatchObject({
            status: 'unavailable',
            revision: { bindingVersion: 1, observerGeneration: 1 },
          })
          expect(await f.store.events.runtimeEventCheckpoint(f.frame.sessionId)).toBeNull()
        },
      },
      3,
    )
  })
  it('uses the one live context scope after non-causal bootstrap, with one keyed lease lookup', async () => {
    const base = contextPin('opencode')
    await expectConstantStatements(
      {
        ...base,
        setup: async (size) => {
          const f = await base.setup(size)
          await base.run(f, size)
          const event = f.frame.event
          if (
            event.t !== 'metadata' ||
            event.change.kind !== 'context-observation' ||
            event.change.context.status !== 'available'
          )
            throw new Error('No invented context fixture')
          f.frame = {
            ...f.frame,
            deliveryId: 'invented-context-update',
            event: {
              ...event,
              change: {
                kind: 'context-observation',
                context: {
                  ...event.change.context,
                  sample: { ...event.change.context.sample, contextRevision: 2 },
                },
              },
            },
          }
          return f
        },
      },
      1,
    )
  })
  it('recovers an unchanged idle sample on RPC replay and rejects telemetry from an old binding', async () => {
    const base = contextPin('opencode')
    const f = await base.setup(1)
    try {
      await base.run(f, 1)
      const event = f.frame.event
      if (
        event.t !== 'metadata' ||
        event.change.kind !== 'context-observation' ||
        event.change.context.status !== 'available'
      )
        throw new Error('No invented context event')
      const { t: _type, change, ...causal } = event
      const observation = { ...causal, context: change.context }
      const session = f.reg.modules.sessions.sessions.get(f.frame.sessionId)
      expect(session?.markContextOffline()).toBe(true)
      await f.replay({ ...f.snapshot, context: observation })
      expect(session?.contextObservation).toEqual(observation)

      const replacement = {
        ...f.snapshot,
        binding: { ...f.snapshot.binding, bindingVersion: 2 },
      }
      f.holdSnapshots()
      await f.requestSnapshot()
      await f.requestSnapshot()
      await f.replyPendingSnapshot(replacement, true)
      expect(session?.contextObservation?.context).toMatchObject({
        status: 'unavailable',
        revision: { bindingVersion: 2, observerGeneration: 1 },
      })
      await base.run(f, 1)
      expect(session?.contextObservation?.context.status).toBe('unavailable')
      f.frame = {
        ...f.frame,
        deliveryId: 'invented-new-binding',
        event: {
          ...event,
          change: {
            kind: 'context-observation',
            context: {
              ...event.change.context,
              sample: { ...event.change.context.sample, bindingVersion: 2, id: 'new-binding' },
            },
          },
        },
      }
      await base.run(f, 1)
      expect(session?.contextObservation?.context).toMatchObject({
        status: 'available',
        sample: { bindingVersion: 2, id: 'new-binding' },
      })
      await f.replyPendingSnapshot(f.snapshot)
      expect(session?.contextObservation?.context).toMatchObject({
        status: 'available',
        sample: { bindingVersion: 2, id: 'new-binding' },
      })
    } finally {
      await base.teardown?.(f)
    }
  })
  it.each([
    false,
    true,
  ])('retires non-causal scope on admitted generation change and recovers through verified replay (prior head=%s)', async (priorHead) => {
    const base = contextPin('opencode')
    const f = await base.setup(1)
    try {
      await base.run(f, 1)
      const event = f.frame.event
      if (
        event.t !== 'metadata' ||
        event.change.kind !== 'context-observation' ||
        event.change.context.status !== 'available'
      )
        throw new Error('No invented context event')
      const originalContext = event.change.context
      const session = f.reg.modules.sessions.sessions.get(f.frame.sessionId)
      const original = session?.contextObservation
      if (priorHead) await admitGeneration(f, 1)
      f.holdSnapshots({ ...f.snapshot, observerGeneration: 2 })
      await admitGeneration(f, 2)
      const checkpoint = await f.store.events.runtimeEventCheckpoint(f.frame.sessionId)
      expect(checkpoint?.observerGeneration).toBe(2)
      const rows = await f.store.events.listRuntimeEvents(f.frame.sessionId)
      const stored = await f.store.sessions.getSession(f.frame.sessionId)
      f.frame = {
        ...f.frame,
        deliveryId: 'invented-obsolete-context',
        event: {
          ...event,
          change: {
            kind: 'context-observation',
            context: {
              ...originalContext,
              sample: { ...originalContext.sample, id: 'obsolete-observer', contextRevision: 2 },
            },
          },
        },
      }
      await base.run(f, 1)
      expect(session?.contextObservation).toMatchObject({
        at: original?.at,
        cursor: original?.cursor,
        context: { status: 'stale', sample: { id: 'invented-context-sample' } },
      })
      expect(await f.store.sessions.getSession(f.frame.sessionId)).toEqual(stored)
      for (const generation of [2, 3]) {
        await f.replay({ ...f.snapshot, observerGeneration: generation })
        f.frame = {
          ...f.frame,
          deliveryId: `invented-context-generation-${generation}`,
          event: {
            ...event,
            observerGeneration: generation,
            change: {
              kind: 'context-observation',
              context: {
                ...originalContext,
                sample: {
                  ...originalContext.sample,
                  id: `current-${generation}`,
                  observerGeneration: generation,
                },
              },
            },
          },
        }
        await base.run(f, 1)
        expect(session?.contextObservation?.context).toMatchObject({
          status: 'available',
          sample: { id: `current-${generation}`, observerGeneration: generation },
        })
      }
      expect(await f.store.events.runtimeEventCheckpoint(f.frame.sessionId)).toEqual(checkpoint)
      expect(await f.store.events.listRuntimeEvents(f.frame.sessionId)).toEqual(rows)
    } finally {
      await base.teardown?.(f)
    }
  })
  it('ignores a snapshot reply started before an admitted lifecycle transition', async () => {
    const base = contextPin('opencode', false)
    const f = await base.setup(1)
    try {
      const session = f.reg.modules.sessions.sessions.get(f.frame.sessionId)
      f.holdSnapshots({ ...f.snapshot, observerGeneration: 2 })
      await admitGeneration(f, 2)
      const event = f.frame.event
      if (event.t !== 'metadata' || event.change.kind !== 'context-observation')
        throw new Error('No fixture')
      const { t: _type, change, ...causal } = event
      await f.replyPendingSnapshot({
        ...f.snapshot,
        context: { ...causal, context: change.context },
      })
      await base.run(f, 1)
      expect(session?.contextObservation).toBeUndefined()
      await f.replyPendingSnapshot({ ...f.snapshot, observerGeneration: 2 })
      f.frame = measurement(f, 2, 1, 'after-lifecycle')
      await base.run(f, 1)
      expect(session?.contextObservation?.context).toMatchObject({
        status: 'available',
        sample: { id: 'after-lifecycle', observerGeneration: 2 },
      })
    } finally {
      await base.teardown?.(f)
    }
  })
  it('admits a newer verified binding with reset counters despite an older ordinary head', async () => {
    const base = contextPin('opencode')
    const f = await base.setup(1)
    try {
      await f.replay({ ...f.snapshot, observerGeneration: 9 })
      f.frame = measurement(f, 9, 1, 'old-binding-native')
      await base.run(f, 1)
      await admitGeneration(f, 9)
      const head = await f.store.events.runtimeEventCheckpoint(f.frame.sessionId)
      expect(head?.observerGeneration).toBe(9)
      f.holdSnapshots()
      await f.requestSnapshot()
      await f.requestSnapshot()
      await f.replyPendingSnapshot(
        { ...f.snapshot, binding: { ...f.snapshot.binding, bindingVersion: 2 } },
        true,
      )
      f.frame = measurement(f, 1, 2, 'new-binding-native')
      await base.run(f, 1)
      const session = f.reg.modules.sessions.sessions.get(f.frame.sessionId)
      expect(session?.contextObservation?.context).toMatchObject({
        status: 'available',
        sample: { id: 'new-binding-native', bindingVersion: 2, observerGeneration: 1 },
      })
      await f.replyPendingSnapshot({ ...f.snapshot, observerGeneration: 9 })
      f.frame = measurement(f, 9, 1, 'late-old-binding')
      await base.run(f, 1)
      expect(session?.contextObservation?.context).toMatchObject({
        status: 'available',
        sample: { id: 'new-binding-native' },
      })
      expect(await f.store.events.runtimeEventCheckpoint(f.frame.sessionId)).toEqual(head)
    } finally {
      await base.teardown?.(f)
    }
  })
  it('detects a planted per-session read on the admitted frame path', async () => {
    await expectArmed(pin, 1, (f) => {
      const original = f.reg.gateway.routeDaemonFrame.bind(f.reg.gateway)
      const spy = vi
        .spyOn(f.reg.gateway, 'routeDaemonFrame')
        .mockImplementation(async (...args) => {
          for (const id of f.ids) await f.store.sessions.getSession(id)
          return original(...args)
        })
      return () => spy.mockRestore()
    })
  })
})
