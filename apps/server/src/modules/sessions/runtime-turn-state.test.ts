/**
 * A runtime-driven session's turn state is durable (POD-6160 D2h).
 *
 * The phase and working time of a session driven through the runtime event
 * gate used to live on the resident session only: a restart lost them, and
 * once the session map holds running sessions only, a parked session would lose
 * them as soon as it left memory. They now ride on the runtime checkpoint row,
 * written in the event's transaction. A hibernated session waiting on its user
 * keeps showing that attention, and the notify replay (which reads the
 * not-exited sessions' facts) keeps finding it, both when the session is read as
 * a durable record (as an evicted session is) and after a restart.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import type { RuntimeEvent } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

const at = '2026-10-16T12:00:00.000Z'

function stateEvent(seq: number, change: Record<string, unknown>, provenance: RuntimeEvent['provenance'] = 'live'): RuntimeEvent {
  return {
    t: 'state',
    change,
    at,
    provenance,
    cursor: { segmentId: 'runtime-segment', components: { seq } },
    observerGeneration: 1,
    turnEpoch: 1,
  } as RuntimeEvent
}

async function runtimeSession(reg: SessionRegistry, store: SessionStore): Promise<SessionId> {
  // The host daemon double confirms process retirement, which hibernation waits for.
  await attachHostDaemon(reg)
  const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/project' })
  await reg.gateway.routeDaemonFrame(store.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'codex app-server',
    cwd: '/project',
    agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
    driverId: 'codex-app-server',
  })
  return sessionId
}

async function send(reg: SessionRegistry, store: SessionStore, sessionId: SessionId, event: RuntimeEvent) {
  await reg.gateway.routeDaemonFrame(store.hostMachineId, {
    type: 'runtimeEvent',
    sessionId,
    deliveryId: `turn-state-${event.cursor.components.seq}`,
    event,
  })
}

describe('durable runtime turn state (POD-6160 D2h)', () => {
  it('keeps a hibernated session waiting on its user in needs_user, read as a record and after a restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-turn-state-')), 'state.sqlite')
    const store = await openTestStore(file)
    const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    const sessionId = await runtimeSession(reg, store)
    await send(reg, store, sessionId, stateEvent(1, { kind: 'session_started' }, 'bootstrap'))
    const waiting = { phase: 'needs_user', since: at, nativeSubagentCount: 0, workingMsTotal: 1_500 }
    await send(reg, store, sessionId, stateEvent(2, { kind: 'state_snapshot', state: waiting }))
    expect((await reg.modules.sessions.sessionById(sessionId))?.agentState?.phase).toBe('needs_user')
    // The checkpoint row carries what the session shows.
    expect((await store.events.runtimeEventCheckpoint(sessionId))?.turnState?.phase).toBe('needs_user')

    // A runtime session learns its resume ref from a binding event.
    await send(reg, store, sessionId, {
      t: 'binding',
      resume: { kind: 'codex-thread', value: 'thread-turn-state' },
      confidence: 'exact',
      bindingVersion: 1,
      ackRequested: false,
      at,
      provenance: 'live',
      cursor: { segmentId: 'runtime-segment', components: { seq: 3 } },
      observerGeneration: 1,
      turnEpoch: 1,
    } as RuntimeEvent)
    // The binding reaches the session through the board projection's drain.
    await reg.modules.sessions.runtimeGateway.replayBoardProjection()
    expect(await reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
    await reg.modules.sessions.flushActivity()

    // As an evicted session is answered: its durable record, and the facts the
    // notify replay reads for the not-exited sessions.
    const record = (await reg.modules.sessions.records.read([sessionId])).get(sessionId)
    expect(record?.status).toBe('hibernated')
    expect(record?.agentState).toMatchObject({ phase: 'needs_user' })
    const replayed = await reg.modules.sessions.readSessionFactsWithStatuses(['starting', 'live', 'reconnecting', 'hibernated'])
    expect(replayed.find((s) => s.sessionId === sessionId)?.agentState?.phase).toBe('needs_user')

    // After a restart: restored with the session, and replayed again.
    await reg.dispose()
    await store.close()
    const store2 = await openTestStore(file)
    const reg2 = await SessionRegistry.create(store2, undefined, { instanceId: 'default' })
    registries.push(reg2)
    expect((await reg2.modules.sessions.sessionById(sessionId))?.agentState?.phase).toBe('needs_user')
    const replayedAfterRestart = await reg2.modules.sessions.readSessionFactsWithStatuses(['hibernated'])
    expect(replayedAfterRestart.find((s) => s.sessionId === sessionId)?.agentState?.phase).toBe('needs_user')
  })
})
