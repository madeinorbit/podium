/**
 * The common daemon WebSocket frames run a fixed number of statements, whatever
 * the number of sessions on the server or items in the frame [POD-6149,
 * server-data rule 8]. Daemon frames are the server's largest cost (research
 * §2: about 1.25 statements per frame), so each common kind is pinned here.
 */
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { AgentObservation } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import { expectConstantStatements, type StatementPin } from './test-support/statement-count'

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  ids: SessionId[]
}

/** `size` bound codex sessions; on the app-server contract driver when `contract`. */
async function fixture(size: number, contract = false): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {})
  const ids: SessionId[] = []
  for (let i = 0; i < size; i++) {
    const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'codex', cwd: `/w${i}` })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'codex',
      cwd: `/w${i}`,
      agentKind: 'codex',
      geometry: { cols: 80, rows: 24 },
      ...(contract ? { driverId: 'codex-app-server' } : {}),
    } as never)
    ids.push(sessionId)
  }
  await settle(reg)
  return { store, reg, ids }
}

/**
 * Let post-commit bus listeners, which a frame does not await, finish, and run
 * the coalesced session broadcast now. Without this a broadcast timer left by
 * setup can fire inside the counted window at one size and not the other.
 */
async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

const route = async (f: Fixture, frame: unknown) => {
  await f.reg.gateway.routeDaemonFrame(f.reg.sessionStore.hostMachineId, frame as never)
  await settle(f.reg)
}

const at = (second: number) => `2026-07-18T12:00:${String(second).padStart(2, '0')}.000Z`
const idle: AgentRuntimeState = { phase: 'idle', since: at(10), workingMsTotal: 0, nativeSubagentCount: 0 }

const observation = (sessionId: SessionId): AgentObservation => ({
  podiumSessionId: sessionId,
  provider: 'codex',
  providerSessionId: null,
  bindingVersion: 1,
  providerTurnId: null,
  providerPromptId: null,
  observerGeneration: 1,
  providerCursor: { segmentId: 'rollout-1', components: { file: 10 } },
  providerAt: at(10),
  receivedAt: at(11),
  sourceEventKind: 'rollout_fold',
  transitionKind: 'snapshot',
  provenance: 'bootstrap',
  inputOrigin: 'provider',
  turnEpoch: 0,
  priorPhase: 'unknown',
  nextPhase: 'idle',
  transitionId: 'snapshot-10',
  state: idle,
})

const pin = (name: string, run: (f: Fixture, size: number) => Promise<unknown>): StatementPin<Fixture> => ({
  name,
  setup: fixture,
  target: (f) => f.store,
  run,
  teardown: async (f) => {
    await f.reg.dispose()
    await f.store.close()
  },
})

describe('daemon frames: pinned statement counts at 5 and 200', () => {
  it('agentFrame (terminal output) touches no table; activity is flushed later', async () => {
    await expectConstantStatements(
      pin('agentFrame', async (f) => await route(f, { type: 'agentFrame', sessionId: f.ids[0], seq: 0, data: 'QQ==' })),
      0,
    )
  })

  it('agentObservation (idle snapshot) of one session among many', async () => {
    const counts = await expectConstantStatements(
      pin('agentObservation', async (f) => await route(f, { type: 'agentObservation', observation: observation(f.ids[0]!) })),
      9,
    )
    expect(counts.small.statements).toBeGreaterThan(0)
  })

  // The echo confirmation behind this frame reads its rows together; that loop is
  // pinned where it runs, in modules/messages/transcript-echo.statement-count.test.ts.
  it('transcriptDelta with as many user items as the size', async () => {
    await expectConstantStatements(
      pin('transcriptDelta', async (f, size) =>
        await route(f, {
          type: 'transcriptDelta',
          sessionId: f.ids[0],
          items: Array.from({ length: size }, (_, i) => ({
            id: `u${i}`,
            role: 'user',
            text: `[podium message msg_unknown_${i} · from x]\nx\n[end podium message msg_unknown_${i}]`,
            cursor: `c${i}`,
          })),
          tail: `c${size - 1}`,
        }),
      ),
      7,
    )
  })

  it('runtimeEvent (contract session start) of one session among many', async () => {
    await expectConstantStatements(
      {
        ...pin('runtimeEvent', async (f) =>
          await route(f, {
            type: 'runtimeEvent',
            sessionId: f.ids[0],
            deliveryId: 'state-1-20',
            event: {
              t: 'state',
              change: { kind: 'session_started' },
              at: at(20),
              provenance: 'bootstrap',
              cursor: { segmentId: 'runtime-segment', components: { seq: 20 } },
              observerGeneration: 1,
              turnEpoch: 1,
            },
          }),
        ),
        setup: async (size) => await fixture(size, true),
      },
      32,
    )
  })

  // POD-6175: the activity flush persists each busy session on its own, so its
  // count grows with the number of sessions that printed output.
  it.skip('activity flush after output on every session (POD-6175)', async () => {
    await expectConstantStatements(
      {
        ...pin('flushActivity', async (f) => await f.reg.modules.sessions.flushActivity()),
        setup: async (size) => {
          const f = await fixture(size)
          for (const sessionId of f.ids) await route(f, { type: 'agentFrame', sessionId, seq: 0, data: 'QQ==' })
          return f
        },
      },
      4,
    )
  })
})

// Every frame that reads a session's observation checkpoint, which comes from
// the database on each frame [POD-6159]: one primary-key read per reader,
// whatever the size. A binding event has two readers (the observer-generation
// check in the daemon lifecycle and the binding gate), so it reads twice.
describe('daemon frames that read an observation checkpoint: pinned at 5 and 200', () => {
  it('agentExit of the fenced observer', async () => {
    await expectConstantStatements(
      pin('agentExit', async (f) =>
        await route(f, { type: 'agentExit', sessionId: f.ids[0], code: 0, observerGeneration: 1 })),
      23,
    )
  })

  it('agentObservationRebind onto a new provider thread', async () => {
    await expectConstantStatements(
      pin('agentObservationRebind', async (f) =>
        await route(f, {
          type: 'agentObservationRebind',
          sessionId: f.ids[0],
          provider: 'codex',
          providerSessionId: null,
          observerGeneration: 1,
          bindingVersion: 1,
          nextProviderSessionId: 'thread-2',
          resumeKind: 'codex-thread',
          rebindId: 'rebind-1',
        })),
      17,
    )
  })

  it('agentObserverLiveConfirmation without a terminal fence', async () => {
    await expectConstantStatements(
      pin('agentObserverLiveConfirmation', async (f) =>
        await route(f, {
          type: 'agentObserverLiveConfirmation',
          sessionId: f.ids[0],
          provider: 'codex',
          providerSessionId: null,
          bindingVersion: 1,
          observerGeneration: 1,
          providerCursor: { segmentId: 'rollout-1', components: { file: 10 } },
          livePollSequence: 1,
          confirmedAt: at(30),
        })),
      1,
    )
  })

  it('agentState (legacy, unfenced) of one session among many', async () => {
    await expectConstantStatements(
      pin('agentState', async (f) => await route(f, { type: 'agentState', sessionId: f.ids[0], state: idle })),
      25,
    )
  })

  it('runtimeEvent binding of a contract session', async () => {
    await expectConstantStatements(
      {
        ...pin('runtimeEvent binding', async (f) =>
          await route(f, {
            type: 'runtimeEvent',
            sessionId: f.ids[0],
            deliveryId: 'binding-1-21',
            event: {
              t: 'binding',
              resume: { kind: 'codex-thread', value: 'native-thread' },
              confidence: 'exact',
              ackRequested: true,
              bindingVersion: 1,
              at: at(21),
              provenance: 'live',
              cursor: { segmentId: 'runtime-segment', components: { seq: 21 } },
              observerGeneration: 1,
              turnEpoch: 1,
            },
          }),
        ),
        setup: async (size) => await fixture(size, true),
      },
      23,
    )
  })
})
