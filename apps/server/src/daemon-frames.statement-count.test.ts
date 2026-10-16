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
import {
  expectConstantStatements,
  type PinnedCounts,
  quietShipping,
  type StatementPin,
  type StatementTally,
} from './test-support/statement-count'

// RE-PINNED AFTER C1 (POD-6183; measured per commit on the polaris VM). Each
// frame now reads grants from the `grants` table where the world index held a
// copy (POD-6155 step "read grants from the table": +1 to +4 per frame, one per
// access check), and counts pending mail and queued input in SQL where counters
// were kept in memory (step "count pending mail and queued input in SQL": +1).
// Neither depends on the number of sessions. The step that answers "which
// issue owns this folder" with one indexed query (POD-6155 step 5) adds that
// query once to every frame that resolves its session's issue: +1.
//
// RE-PINNED FOR B6 (POD-6189), measured on the polaris VM. A frame is one
// operation now (`store/executor/operation-scope.ts`), holding the post-commit
// effects and bus reactions it starts, and the grants loader memoises for the
// whole of it: the projection inside the frame's write span, the session-owner
// check and the reprojections after it, and the publication read a resource's
// grants ONCE. Frames drop by the repeats, against the integration tip they
// were rebased on (e1db4b96b6, whose C3 dedup against stored rows adds one
// statement per commit and was not re-pinned there): agentObservation 13 -> 12,
// transcriptDelta 11 -> 10, runtimeEvent 39 -> 35, agentExit 28 -> 26,
// agentObservationRebind 21 -> 20, agentState 32 -> 28, runtimeEvent binding
// 29 -> 27; flushActivity is C3's 4. `expectGrantReads` pins one read per
// resource: the binding's second is the runtime board projection, a drain that
// serves several frames and runs each record as its own operation.
//
// RE-PINNED FOR POD-6192 (D1c of the issue map removal), measured on the
// polaris VM. A frame's session-access check walks the subtree scope's
// ancestors (`session-access.ts` -> `IssueHierarchyModule.ancestorIds`), which
// read the issue's parent off the in-memory issue map and now reads the issue's
// row: +1 for runtimeEvent 35 -> 36, agentExit 26 -> 27, agentState 28 -> 29.

/**
 * Reads of the `grants` table in one tally [POD-6189]. Statement keys keep
 * their table since POD-6189, so a cut builder select still says `FROM "grants"`.
 */
const grantReads = (tally: StatementTally): number =>
  [...tally.byQuery].reduce((n, [key, count]) => (/^select\b.*\bfrom "grants"/i.test(key) ? n + count : n), 0)

/**
 * A frame reads each resource's grants at most once [POD-6189]: its access
 * checks go through the per-operation loader, inside its write spans too, so
 * `resources` is the number of distinct resources the frame's work checks.
 */
const expectGrantReads = (counts: PinnedCounts, resources: number): void => {
  expect(grantReads(counts.small), 'grant reads at the small size').toBe(resources)
  expect(grantReads(counts.large), 'grant reads at the large size').toBe(resources)
}

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
  await quietShipping(reg)
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
    const counts = await expectConstantStatements(
      pin('agentFrame', async (f) => await route(f, { type: 'agentFrame', sessionId: f.ids[0], seq: 0, data: 'QQ==' })),
      0,
    )
    expectGrantReads(counts, 0)
  })

  it('agentObservation (idle snapshot) of one session among many', async () => {
    const counts = await expectConstantStatements(
      pin('agentObservation', async (f) => await route(f, { type: 'agentObservation', observation: observation(f.ids[0]!) })),
      12,
    )
    expect(counts.small.statements).toBeGreaterThan(0)
    expectGrantReads(counts, 1)
  })

  // The echo confirmation behind this frame reads its rows together; that loop is
  // pinned where it runs, in modules/messages/transcript-echo.statement-count.test.ts.
  it('transcriptDelta with as many user items as the size', async () => {
    const counts = await expectConstantStatements(
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
      10,
    )
    expectGrantReads(counts, 1)
  })

  it('runtimeEvent (contract session start) of one session among many', async () => {
    const counts = await expectConstantStatements(
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
      36,
    )
    expectGrantReads(counts, 1)
  })

  // Every busy session is written in one commit [POD-6175]: one many-row
  // upsert and the projection pass's two reads (grants, queued messages). No
  // change is appended: output counters live in the row, not in the session's
  // wire meta, so every change dedups away.
  it('activity flush after output on every session', async () => {
    const counts = await expectConstantStatements(
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
    expectGrantReads(counts, 1)
  })
})

// Every frame that reads a session's observation checkpoint, which comes from
// the database on each frame [POD-6159]: one primary-key read per reader,
// whatever the size. A binding event has two readers (the observer-generation
// check in the daemon lifecycle and the binding gate), so it reads twice.
describe('daemon frames that read an observation checkpoint: pinned at 5 and 200', () => {
  it('agentExit of the fenced observer', async () => {
    const counts = await expectConstantStatements(
      pin('agentExit', async (f) =>
        await route(f, { type: 'agentExit', sessionId: f.ids[0], code: 0, observerGeneration: 1 })),
      27,
    )
    expectGrantReads(counts, 1)
  })

  it('agentObservationRebind onto a new provider thread', async () => {
    const counts = await expectConstantStatements(
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
      20,
    )
    expectGrantReads(counts, 1)
  })

  it('agentObserverLiveConfirmation without a terminal fence', async () => {
    const counts = await expectConstantStatements(
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
    expectGrantReads(counts, 0)
  })

  it('agentState (legacy, unfenced) of one session among many', async () => {
    const counts = await expectConstantStatements(
      pin('agentState', async (f) => await route(f, { type: 'agentState', sessionId: f.ids[0], state: idle })),
      29,
    )
    expectGrantReads(counts, 1)
  })

  it('runtimeEvent binding of a contract session', async () => {
    const counts = await expectConstantStatements(
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
      27,
    )
    expectGrantReads(counts, 2)
  })
})
