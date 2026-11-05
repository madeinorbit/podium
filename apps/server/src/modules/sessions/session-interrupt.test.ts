/**
 * INTERRUPT NAMES THE TURN IT IS FOR (POD-6397).
 *
 * Driven through the REAL composed server (`makeOracle`): the daemon's state
 * frames move the session's turn, `effects.create` with kind
 * `session.interrupt` names the turn, and every assertion reads back the
 * effect record, the session's synced state and the frames the daemon was sent.
 */

import { type AgentRuntimeState, mintDeviceId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { appliedReply, envelope, submit } from '../sync-write/outbox-test-support'
import { disposeOracles, makeOracle, type Oracle, waitFor } from './oracle-support'
import { SESSION_INTERRUPT_DEADLINE_MS, SESSION_INTERRUPT_KIND } from './session-interrupt-effect'

afterEach(() => disposeOracles())

const interruptRequests = (o: Oracle, sessionId: SessionId) =>
  o.daemon.filter(
    (m): m is Extract<ControlMessage, { type: 'runtimeInterruptRequest' }> =>
      m.type === 'runtimeInterruptRequest' && m.sessionId === sessionId,
  )

const effectOf = async (o: Oracle, id: string) => await o.store.effects.get(id)

async function settled(o: Oracle, id: string) {
  await waitFor(async () => {
    const status = (await effectOf(o, id))?.status
    return status !== undefined && status !== 'pending' && status !== 'running'
  }, `effect ${id} to settle`)
  return await effectOf(o, id)
}

/** A live claude-code session, bound on the oracle's daemon. */
async function liveSession(o: Oracle): Promise<SessionId> {
  const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/p',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  return sessionId
}

/** The daemon reports the agent's phase, at `since`, with the turn it marked. */
async function report(
  o: Oracle,
  sessionId: SessionId,
  phase: AgentRuntimeState['phase'],
  since: string,
  turnStartedAt: string,
): Promise<void> {
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'agentState',
    sessionId,
    state: { phase, since, nativeSubagentCount: 0, turnStartedAt },
  })
}

const stateOf = async (o: Oracle, sessionId: SessionId) =>
  (await o.reg.modules.sessions.sessionById(sessionId))?.agentState

async function interrupt(o: Oracle, sessionId: SessionId, input: Record<string, unknown>) {
  const id = mintDeviceId('eff_')
  appliedReply(
    await submit(
      o,
      envelope(
        'effects.create',
        { id, kind: SESSION_INTERRUPT_KIND, target: { kind: 'session', id: sessionId }, input },
        `int-${id}`,
      ),
    ),
  )
  return id
}

/** The daemon answers the stop, as a real one does; returns the request. */
async function answerStop(
  o: Oracle,
  sessionId: SessionId,
  result: { ok: true } | { reason: 'turn_ended' | 'unsupported'; detail?: string } = { ok: true },
) {
  await waitFor(() => interruptRequests(o, sessionId).length > 0, 'the interrupt request')
  // biome-ignore lint/style/noNonNullAssertion: waited for above.
  const request = interruptRequests(o, sessionId).at(-1)!
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'runtimeLifecycleResult',
    requestId: request.requestId,
    sessionId,
    result,
  })
  return request
}

const T0 = '2026-11-05T10:00:00.000Z'
const T1 = '2026-11-05T10:01:00.000Z'
const T2 = '2026-11-05T10:02:00.000Z'

describe('a session.interrupt effect', () => {
  it('runs as "interrupting" until the named turn ends, then succeeds', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    await report(o, sessionId, 'working', T0, T0)

    const id = await interrupt(o, sessionId, { turn: T0 })
    await answerStop(o, sessionId)
    await waitFor(
      async () => (await effectOf(o, id))?.stage === 'interrupting',
      'the stop to be asked for',
    )
    expect(await effectOf(o, id)).toMatchObject({ status: 'running', stage: 'interrupting' })

    await report(o, sessionId, 'idle', T1, T0)
    expect(await settled(o, id)).toMatchObject({
      status: 'succeeded',
      result: { ended: 'stopped', requested: 'protocol' },
    })
    expect(interruptRequests(o, sessionId)).toHaveLength(1)
  })

  it('carries the turn to the daemon, and stops it when the daemon says it runs', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    await report(o, sessionId, 'working', T0, T0)

    const id = await interrupt(o, sessionId, { turn: T0 })
    expect((await answerStop(o, sessionId)).turn).toBe(T0)
    await report(o, sessionId, 'idle', T1, T0)

    expect(await settled(o, id)).toMatchObject({
      status: 'succeeded',
      result: { ended: 'stopped' },
    })
  })

  it('a turn the daemon says is over succeeds as already ended, and the next turn runs on', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    await report(o, sessionId, 'working', T0, T0)
    await report(o, sessionId, 'idle', T1, T0)
    await report(o, sessionId, 'working', T2, T2)

    const id = await interrupt(o, sessionId, { turn: T0 })
    // The server asks anyway: the daemon, not its stored copy, judges the turn.
    expect((await answerStop(o, sessionId, { reason: 'turn_ended' })).turn).toBe(T0)

    expect(await settled(o, id)).toMatchObject({
      status: 'succeeded',
      result: { ended: 'already' },
    })
    expect(interruptRequests(o, sessionId)).toHaveLength(1)
    expect((await stateOf(o, sessionId))?.phase).toBe('working')
  })

  it('the server never skips the request on its own copy of the state', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    await report(o, sessionId, 'working', T0, T0)
    await report(o, sessionId, 'idle', T1, T0)

    const id = await interrupt(o, sessionId, { turn: T0 })
    await answerStop(o, sessionId, { reason: 'turn_ended' })

    expect(await settled(o, id)).toMatchObject({
      status: 'succeeded',
      result: { ended: 'already' },
    })
  })

  it('fails at its deadline while the turn still runs, so the app can offer Kill', async () => {
    let clock = Date.parse('2026-11-05T10:00:00.000Z')
    const o = await makeOracle({ now: () => clock })
    const sessionId = await liveSession(o)
    await report(o, sessionId, 'working', T0, T0)

    const id = await interrupt(o, sessionId, { turn: T0 })
    await answerStop(o, sessionId)
    await waitFor(
      async () => (await effectOf(o, id))?.stage === 'interrupting',
      'the stop to be asked for',
    )
    clock += SESSION_INTERRUPT_DEADLINE_MS + 1

    expect(await settled(o, id)).toMatchObject({ status: 'failed', error: { code: 'deadline' } })
    expect((await stateOf(o, sessionId))?.phase).toBe('working')
  })

  it("a refused stop fails with the driver's reason", async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    await report(o, sessionId, 'working', T0, T0)

    const id = await interrupt(o, sessionId, { turn: T0 })
    await answerStop(o, sessionId, { reason: 'unsupported', detail: 'no stop here' })

    expect(await settled(o, id)).toMatchObject({
      status: 'failed',
      error: { code: 'refused', message: 'unsupported: no stop here' },
    })
  })

  it('sessions.interrupt answers its old shape through a session.interrupt record', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    await report(o, sessionId, 'working', T0, T0)

    const answer = o.call.sessions.interrupt({ sessionId })
    await answerStop(o, sessionId)

    expect(await answer).toEqual({ ok: true, requested: 'protocol' })
    const records = (await o.store.effects.listInStatus('running', 10)).filter(
      (r) => r.kind === SESSION_INTERRUPT_KIND && r.target.id === sessionId,
    )
    expect(records).toHaveLength(1)
  })
})
