/**
 * THE CONCERTMASTER COMMANDS ON THE SYNC WRITE ENTRY POINT (POD-7211), on a
 * composed server: the feature gate, the mark and its briefing, the agent's
 * commands over the relay on its own session only, the person's response
 * reaching the agent, and the conversation as synced records.
 */

import { asThreadId, INSTANCE_PREFERENCES_ROW_ID, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { FAMILY_COMMAND_NAMES } from '../sync-write/family-commands'
import {
  appliedReply,
  changeRows,
  envelope,
  rowsOf,
  submit,
} from '../sync-write/outbox-test-support'

afterEach(() => disposeOracles())

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>
let request = 0

async function relay(
  o: Oracle,
  sessionId: SessionId,
  router: string,
  proc: string,
  input: unknown,
): Promise<RelayResult> {
  const requestId = `r-cm-${++request}`
  await o.reg.gateway.routeDaemonFrame(o.store.hostMachine!.id, {
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

const agentSubmit = async (o: Oracle, sessionId: SessionId, command: string, input: unknown) =>
  (await relay(o, sessionId, 'sync', 'submit', envelope(command, input, `mut-${++request}`)))
    .result as { outcome: string; result?: Record<string, unknown>; refusal?: { message: string } }

async function agent(o: Oracle): Promise<SessionId> {
  return (await o.reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' }))
    .sessionId
}

async function enable(o: Oracle): Promise<void> {
  appliedReply(
    await submit(
      o,
      envelope(
        'records.instancePreferences.edit',
        { id: INSTANCE_PREFERENCES_ROW_ID, patch: { experimental: { concertmaster: true } } },
        `mut-flag-${++request}`,
      ),
    ),
  )
  expect(await o.reg.modules.concertmaster?.enabled()).toBe(true)
}

const mark = async (o: Oracle, sessionId: SessionId, on = true) =>
  await submit(o, envelope('concertmaster.assign', { sessionId, on }, `mut-mark-${++request}`))

describe('the concertmaster commands on the entry point', () => {
  it('are registered sync writes', async () => {
    const o = await makeOracle()
    for (const name of ['say', 'ask', 'update', 'resolve', 'retract', 'assign', 'respond']) {
      expect(o.reg.modules.syncWrite.registry.names()).toContain(`concertmaster.${name}`)
      expect(FAMILY_COMMAND_NAMES).toContain(`concertmaster.${name}`)
    }
  })

  it('refuse while the feature is off, and for a session that is not marked', async () => {
    const o = await makeOracle()
    const sessionId = await agent(o)
    expect(await mark(o, sessionId)).toMatchObject({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized' },
    })
    await enable(o)
    const said = await agentSubmit(o, sessionId, 'concertmaster.say', { body: 'hello' })
    expect(said.outcome).toBe('rejected')
    expect(said.refusal?.message).toMatch(/not a Concertmaster/)
    expect(await o.reg.modules.concertmaster?.conversation(sessionId)).toEqual([])
  })

  it('marks a session, briefs its agent, and carries the mark on the session record', async () => {
    const o = await makeOracle()
    await enable(o)
    const sessionId = await agent(o)
    const reply = appliedReply(await mark(o, sessionId))
    expect(reply.result).toEqual({ concertmaster: true, changed: true })
    expect((await o.reg.modules.sessions.sessionById(sessionId))?.concertmaster).toBe(true)
    const ledger = await o.store.messages.listLedger({ sessionId, limit: 20 })
    expect(
      ledger.some((m) => m.fromKind === 'system' && /podium concertmaster say/.test(m.body)),
    ).toBe(true)
    // Clearing it is the way back.
    appliedReply(await mark(o, sessionId, false))
    expect((await o.reg.modules.sessions.sessionById(sessionId))?.concertmaster).toBeUndefined()
  })

  it("writes the agent's messages and asks as records of its own session, and lists them", async () => {
    const o = await makeOracle()
    await enable(o)
    const sessionId = await agent(o)
    appliedReply(await mark(o, sessionId))

    const said = await agentSubmit(o, sessionId, 'concertmaster.say', {
      body: 'The fix is merged.',
    })
    expect(said).toMatchObject({ outcome: 'applied', result: { ok: true } })
    const asked = await agentSubmit(o, sessionId, 'concertmaster.ask', {
      kind: 'decision',
      title: 'Ship today?',
      options: ['Ship', 'Wait'],
    })
    expect(asked).toMatchObject({ outcome: 'applied', result: { ok: true, number: 1 } })
    const bad = await agentSubmit(o, sessionId, 'concertmaster.ask', {
      kind: 'decision',
      title: 'Ship?',
      options: ['Only one'],
    })
    expect(bad.refusal?.message).toMatch(/two options/)

    const conversation = await o.reg.modules.concertmaster?.conversation(sessionId)
    expect(conversation?.map((entry) => [entry.kind, entry.body, entry.status])).toEqual([
      ['say', 'The fix is merged.', undefined],
      ['ask', 'Ship today?', 'open'],
    ])
    // The entries are on the change log as `concertmasterEntry` records.
    expect((await changeRows(o)).map((row) => row.entity)).toContain('concertmasterEntry')

    const listed = await relay(o, sessionId, 'concertmaster', 'list', {})
    expect(listed).toMatchObject({ ok: true })
    expect((listed.result as { asks: { number: number }[] }).asks.map((a) => a.number)).toEqual([1])

    // Another session reaches none of it: the target is always the caller.
    const other = await agent(o)
    const stray = await agentSubmit(o, other, 'concertmaster.resolve', { number: 1 })
    expect(stray.outcome).toBe('rejected')
  })

  it("settles an ask with the person's response and delivers it to the agent", async () => {
    const o = await makeOracle()
    await enable(o)
    const sessionId = await agent(o)
    appliedReply(await mark(o, sessionId))
    await agentSubmit(o, sessionId, 'concertmaster.ask', { title: 'Which database?' })
    const [ask] = (await o.reg.modules.concertmaster?.conversation(sessionId)) ?? []
    const env = envelope(
      'concertmaster.respond',
      { sessionId, entryId: ask?.entryId, response: 'answered', text: 'Postgres' },
      'mut-respond',
    )
    expect(appliedReply(await submit(o, env)).result).toEqual({ settled: true, status: 'answered' })
    const rows = await rowsOf(o, 'mut-respond')
    expect(rows.map((row) => row.entity)).toContain('concertmasterEntry')
    const [settled] = (await o.reg.modules.concertmaster?.conversation(sessionId)) ?? []
    expect(settled).toMatchObject({ status: 'answered', answer: 'Postgres', settledBy: 'user' })
    const ledger = await o.store.messages.listLedger({ sessionId, limit: 20 })
    expect(
      ledger.some(
        (m) =>
          m.fromKind === 'operator' &&
          m.body === 'Answer to ask #1 (question: "Which database?"): Postgres',
      ),
    ).toBe(true)
    // The agent settling it again is told it was answered, and nothing changes.
    const again = await agentSubmit(o, sessionId, 'concertmaster.retract', { number: 1 })
    expect(again.result).toMatchObject({ settled: false })
  })

  it('refuses an offer from a Concertmaster and points at its own commands', async () => {
    const o = await makeOracle()
    await enable(o)
    const sessionId = await agent(o)
    appliedReply(await mark(o, sessionId))
    const offer = await agentSubmit(o, sessionId, 'offer.set', {
      message: 'Ready',
      actions: [{ label: 'Merge', prompt: 'Merge it' }],
    })
    expect(offer.outcome).toBe('rejected')
    expect(offer.refusal?.message).toMatch(/podium concertmaster ask/)
  })

  it("adds the person's message to the conversation once its delivery is confirmed", async () => {
    const o = await makeOracle()
    await enable(o)
    const sessionId = await agent(o)
    appliedReply(await mark(o, sessionId))
    const at = new Date().toISOString()
    await o.store.messages.addMessage(fixtureWriteScope(), {
      id: 'msg_person_1',
      threadId: asThreadId('msg_person_1'),
      inReplyTo: null,
      fromKind: 'operator',
      fromSession: null,
      fromIssue: null,
      toKind: 'session',
      toId: sessionId,
      kind: 'message',
      urgency: 'fyi',
      lifecycle: 'wait',
      body: 'explain the concertmaster thing',
      expiresAt: null,
      createdAt: at,
      deliveryStatus: 'stored',
      deliveredAt: null,
      deliveredTo: null,
      ackedBy: null,
      hop: 0,
      clampedFrom: null,
      remindedAt: null,
      expectsResponse: false,
    })
    // The delivery confirms it the way a running agent's history does.
    await o.store.messages.markDelivered(fixtureWriteScope(), 'msg_person_1', sessionId, at)
    await vi.waitFor(
      async () => {
        const conversation = (await o.reg.modules.concertmaster?.conversation(sessionId)) ?? []
        expect(conversation.map((entry) => [entry.kind, entry.body])).toEqual([
          ['user', 'explain the concertmaster thing'],
        ])
      },
      { timeout: 3000 },
    )
  })
})
