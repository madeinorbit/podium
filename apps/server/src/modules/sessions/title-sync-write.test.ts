/**
 * AN AGENT NAMES ITS OWN SESSION ON THE SYNC WRITE ENTRY POINT (POD-6601).
 *
 * `podium session title` from a relayed agent: the CLI's `sessions.title` relay
 * arm is an adapter onto `submit`; the session row the name writes carries the
 * command's provenance and the reply a receipt; a replay answers the recorded
 * result and writes nothing; the user's own name is refused in the result, not
 * thrown; and nobody without a session behind them reaches the handler.
 */

import type { SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAMILY_COMMAND_NAMES } from '../sync-write/family-commands'
import { envelope, rowsOf, submit } from '../sync-write/outbox-test-support'
import { disposeOracles, makeOracle, type Oracle } from './oracle-support'

afterEach(() => disposeOracles())

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

async function relay(
  o: Oracle,
  sessionId: SessionId,
  requestId: string,
  router: string,
  proc: string,
  input: unknown,
): Promise<RelayResult> {
  await o.reg.gateway.routeDaemonFrame(o.store.hostMachineId, {
    type: 'agentRelayRequest',
    requestId,
    sessionId,
    router,
    proc,
    input,
  })
  const answered = (): RelayResult | undefined =>
    o.daemon.find(
      (msg): msg is RelayResult => msg.type === 'agentRelayResult' && msg.requestId === requestId,
    )
  await vi.waitFor(() => expect(answered()).toBeDefined())
  return answered() as RelayResult
}

async function agent(o: Oracle): Promise<SessionId> {
  return (await o.reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' }))
    .sessionId
}

const nameOf = async (o: Oracle, sessionId: SessionId) =>
  (await o.reg.modules.sessions.sessionById(sessionId))?.name

describe('sessions.title on the entry point', () => {
  it('is a registered sync write', async () => {
    const o = await makeOracle()
    expect(o.reg.modules.syncWrite.registry.names()).toContain('sessions.title')
    expect(FAMILY_COMMAND_NAMES).toContain('sessions.title')
  })

  it('names the caller with provenance and a receipt; the replay writes nothing', async () => {
    const o = await makeOracle()
    const sessionId = await agent(o)
    const env = envelope('sessions.title', { name: 'Retry backoff' }, 'mut_title_1')
    const first = await relay(o, sessionId, 'r-title-1', 'sync', 'submit', env)
    expect(first.ok).toBe(true)
    const reply = first.result as { outcome: string; result: unknown; receipt: { seq: number } }
    expect(reply).toMatchObject({
      outcome: 'applied',
      result: { ok: true, name: 'Retry backoff' },
    })
    const rows = await rowsOf(o, 'mut_title_1')
    expect(rows.map((row) => [row.entity, row.entityId])).toContainEqual(['session', sessionId])
    expect(reply.receipt.seq).toBeGreaterThanOrEqual(Math.max(...rows.map((row) => row.seq)))
    expect(await nameOf(o, sessionId)).toBe('Retry backoff')

    const setAgentName = vi.spyOn(o.reg.modules.sessions, 'setAgentName')
    const replay = await relay(o, sessionId, 'r-title-2', 'sync', 'submit', env)
    expect(replay.result).toMatchObject({ outcome: 'applied', replayed: true })
    expect(setAgentName).not.toHaveBeenCalled()
    expect(await rowsOf(o, 'mut_title_1')).toHaveLength(rows.length)
  })

  it("the CLI's sessions.title arm is a thin adapter onto the entry point", async () => {
    const o = await makeOracle()
    const sessionId = await agent(o)
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const titled = await relay(o, sessionId, 'r-arm', 'sessions', 'title', { name: 'Lease expiry' })
    expect(titled).toMatchObject({ ok: true, result: { ok: true, name: 'Lease expiry' } })
    expect(entry.mock.calls.map(([env, , transport]) => [env.command, transport])).toEqual([
      ['sessions.title', 'relay'],
    ])
    // An older CLI's `title` spelling is the same write.
    await relay(o, sessionId, 'r-arm-old', 'sessions', 'title', { title: 'Older spelling' })
    expect(await nameOf(o, sessionId)).toBe('Older spelling')
  })

  it("the user's name is refused in the result, and nothing is written", async () => {
    const o = await makeOracle()
    const sessionId = await agent(o)
    await o.reg.modules.sessions.renameSession(o.reg.modules.sessions.serverWriter, {
      sessionId,
      name: 'Mine',
    })
    const env = envelope('sessions.title', { name: 'Agent pick' }, 'mut_title_user')
    const refused = await relay(o, sessionId, 'r-user', 'sync', 'submit', env)
    expect(refused.result).toMatchObject({ outcome: 'applied', result: { ok: false } })
    expect(await nameOf(o, sessionId)).toBe('Mine')
  })

  it('a blank name is refused in the sentence the arm always answered', async () => {
    const o = await makeOracle()
    const sessionId = await agent(o)
    const setAgentName = vi.spyOn(o.reg.modules.sessions, 'setAgentName')
    const viaArm = await relay(o, sessionId, 'r-blank', 'sessions', 'title', { name: '   ' })
    expect(viaArm).toMatchObject({ ok: false, error: 'name is required' })
    expect(setAgentName).not.toHaveBeenCalled()
  })

  it('is not served on tRPC: the operator has no session to name', async () => {
    const o = await makeOracle()
    const setAgentName = vi.spyOn(o.reg.modules.sessions, 'setAgentName')
    expect(await submit(o, envelope('sessions.title', { name: 'x' }, 'mut_title_trpc'))).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized' },
    })
    expect(setAgentName).not.toHaveBeenCalled()
  })
})
