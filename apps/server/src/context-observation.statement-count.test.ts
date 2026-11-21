import { asSessionId, type SessionId } from '@podium/model'
import type { RuntimeEventMessage } from '@podium/protocol/daemon'
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
}
const contextPin = (agentKind: 'codex' | 'opencode'): StatementPin<Fixture> => ({
  name: `normalized context live admission (${agentKind})`,
  sizes: [3, 24],
  async setup(size) {
    const store = await openTestStore(':memory:')
    const reg = await SessionRegistry.create(store, undefined, {
      instanceId: 'default',
      rehearseBoot: true,
    })
    await settledCommand(() => attachHostDaemon(reg, () => {}))
    await quietShipping(reg)
    const ids: SessionId[] = []
    for (let i = 0; i < size; i++) {
      const { sessionId } = await settledCommand(() =>
        reg.modules.sessions.createSession({ agentKind, cwd: '/tmp/invented-context' }),
      )
      await settledOperation(() =>
        reg.gateway.routeDaemonFrame(store.hostMachineId, {
          type: 'bind',
          sessionId,
          cmd: 'invented context provider',
          cwd: '/tmp/invented-context',
          agentKind,
          geometry: { cols: 80, rows: 24 },
        }),
      )
      ids.push(sessionId)
    }
    await settledOperation(() => reg.modules.sessions.flushBroadcasts())
    await reg.changeLedger.authority.settled()
    const sessionId = ids[0] ?? asSessionId('missing-test-session')
    const lease = await store.observationCheckpoints.get(sessionId)
    if (agentKind === 'codex' && !lease)
      throw new Error('Causal session creation did not issue an observation lease')
    const at = '2026-11-21T12:00:00.000Z'
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
    return { reg, store, ids, frame, stored: await store.sessions.getSession(sessionId) }
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
    await f.reg.dispose()
    await f.store.close()
  },
})
const pin = contextPin('codex')

describe('context telemetry stays live and uses a constant lease read', () => {
  it('reads exactly one lease at small and larger working sets without saving telemetry', async () => {
    await expectConstantStatements(pin, 1)
  })
  it('admits a non-causal harness using its existing stream generation with two fixed keyed reads', async () => {
    await expectConstantStatements(contextPin('opencode'), 2)
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
