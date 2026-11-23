/**
 * AN AGENT'S ACTION OFFER ON THE SYNC WRITE ENTRY POINT (POD-6419).
 *
 * `podium offer` from a relayed agent: a newer CLI's `sync.submit` and an older
 * CLI's `offer.<proc>` relay arm both reach `submit`; the session row the offer
 * writes carries the command's provenance and the reply a receipt; a replay
 * answers the recorded result and writes nothing; the input keeps its sentences;
 * and a caller with no session behind it is refused before the handler.
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

const OFFER = {
  message: 'Retry backoff is ready',
  actions: [{ label: 'Merge', prompt: 'Merge it' }],
}

describe('offer.set and offer.clear on the entry point', () => {
  it('both are registered sync writes', async () => {
    const o = await makeOracle()
    for (const name of ['offer.set', 'offer.clear']) {
      expect(o.reg.modules.syncWrite.registry.names()).toContain(name)
      expect(FAMILY_COMMAND_NAMES).toContain(name)
    }
  })

  it("a newer CLI's sync.submit sets the offer with provenance and a receipt; the replay writes nothing", async () => {
    const o = await makeOracle()
    const sessionId = await agent(o)
    const env = envelope('offer.set', OFFER, 'mut_offer_set')
    const first = await relay(o, sessionId, 'r-offer-1', 'sync', 'submit', env)
    expect(first.ok).toBe(true)
    const reply = first.result as { outcome: string; result: unknown; receipt: { seq: number } }
    expect(reply).toMatchObject({ outcome: 'applied', result: { ok: true } })
    const rows = await rowsOf(o, 'mut_offer_set')
    expect(rows.map((row) => [row.entity, row.entityId])).toContainEqual(['session', sessionId])
    expect(reply.receipt.seq).toBeGreaterThanOrEqual(Math.max(...rows.map((row) => row.seq)))
    expect((await o.reg.modules.sessions.sessionById(sessionId))?.offer).toMatchObject({
      message: 'Retry backoff is ready',
    })

    const setOffer = vi.spyOn(o.reg.modules.sessions, 'setOffer')
    const replay = await relay(o, sessionId, 'r-offer-2', 'sync', 'submit', env)
    expect(replay.result).toMatchObject({
      outcome: 'applied',
      replayed: true,
      result: { ok: true },
    })
    expect(setOffer).not.toHaveBeenCalled()
    expect(await rowsOf(o, 'mut_offer_set')).toHaveLength(rows.length)
  })

  it("an older CLI's offer.<proc> arm is a thin adapter onto the entry point", async () => {
    const o = await makeOracle()
    const sessionId = await agent(o)
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const set = await relay(o, sessionId, 'r-legacy-set', 'offer', 'set', OFFER)
    expect(set).toMatchObject({ ok: true, result: { ok: true } })
    const clear = await relay(o, sessionId, 'r-legacy-clear', 'offer', 'clear', {})
    expect(clear).toMatchObject({ ok: true, result: { ok: true, cleared: true } })
    expect(entry.mock.calls.map(([env, , transport]) => [env.command, transport])).toEqual([
      ['offer.set', 'relay'],
      ['offer.clear', 'relay'],
    ])
    expect((await o.reg.modules.sessions.sessionById(sessionId))?.offer).toBeUndefined()
  })

  it('a bad offer is refused in the sentence the relay always answered, and nothing is written', async () => {
    const o = await makeOracle()
    const sessionId = await agent(o)
    const many = Array.from({ length: 7 }, (_, i) => ({ label: `a${i}`, prompt: 'p' }))
    const env = envelope('offer.set', { message: 'm', actions: many }, 'mut_offer_bad')
    const viaSubmit = await relay(o, sessionId, 'r-bad', 'sync', 'submit', env)
    expect(viaSubmit.result).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'invalid', message: 'at most 6 actions are allowed' },
    })
    expect(await rowsOf(o, 'mut_offer_bad')).toEqual([])
    const viaArm = await relay(o, sessionId, 'r-bad-arm', 'offer', 'set', {
      message: '',
      actions: [],
    })
    expect(viaArm).toMatchObject({ ok: false, error: 'message must contain 1..4000 characters' })
  })

  it('is not served on tRPC: the operator has no session to offer on', async () => {
    const o = await makeOracle()
    const setOffer = vi.spyOn(o.reg.modules.sessions, 'setOffer')
    expect(await submit(o, envelope('offer.set', OFFER, 'mut_offer_trpc'))).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized' },
    })
    expect(setOffer).not.toHaveBeenCalled()
  })
})
