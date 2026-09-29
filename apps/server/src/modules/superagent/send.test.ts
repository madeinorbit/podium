import { asSessionId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { failureNoticeId, spawnPromptMessageId } from '../../message-ids'
import { mailHarness } from '../messages/characterization-support'
import { superagentSender } from './send'

/**
 * WHAT THE SUPERAGENT TYPES INTO A SESSION IS ITS MESSAGE (POD-4846).
 *
 * `start_agent`'s first message and `send_to_agent` used to push raw text into
 * the session queue: no row, no id, no status, and a transcript that showed it
 * as if the person had typed it. The superagent is "you, automated", not you,
 * so its words arrive inside the envelope, from `superagent`, on behalf of the
 * thread's owner.
 */
describe('a superagent send', () => {
  const owner = firstAdminMemberId()

  it('is stored from the superagent on behalf of its owner, and typed inside the envelope', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'work' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })

    const r = await superagentSender(h.svc, owner)({
      sessionId: asSessionId('s1'),
      text: 'Rebase onto main and rerun the tests.',
    })

    expect(r.ok).toBe(true)
    const [row] = await h.store.messages.listLedger({ sessionId: asSessionId('s1') })
    expect(row).toMatchObject({
      fromKind: 'superagent',
      toKind: 'session',
      toId: 's1',
      kind: 'message',
      lifecycle: 'wake',
      body: 'Rebase onto main and rerun the tests.',
      attribution: { actor: { kind: 'agent', id: 'superagent' }, onBehalfOf: owner },
      deliveryStatus: 'dispatched',
    })
    const [push, ...more] = h.pushes
    expect(more).toHaveLength(0)
    expect(push).toMatchObject({ fn: 'queueText', sessionId: 's1', inputOrigin: 'mail' })
    const text = push?.text ?? ''
    expect(text.startsWith(`[podium message ${row?.id} · from superagent · to your session`)).toBe(true)
    expect(text).toContain('Rebase onto main and rerun the tests.')
  })

  it("a new session's first message is its spawn prompt, stored once", async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'work' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'starting' })
    const send = superagentSender(h.svc, owner)
    const first = { sessionId: asSessionId('s1'), text: 'Start on the parser.', messageId: spawnPromptMessageId(asSessionId('s1')) }

    await send(first)
    await send(first)

    expect(await h.svc.message(spawnPromptMessageId(asSessionId('s1')))).toMatchObject({
      fromKind: 'superagent',
      body: 'Start on the parser.',
    })
    expect(h.pushes).toHaveLength(1)
  })

  it('wakes a parked session', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'work' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'hibernated', resumable: true })

    const r = await superagentSender(h.svc, owner)({ sessionId: asSessionId('s1'), text: 'wake up' })

    expect(r.ok).toBe(true)
    expect(h.pushes.map((p) => [p.fn, p.sessionId])).toEqual([['queueText', 's1']])
  })

  it('a send to a session that is gone answers the tool that it failed', async () => {
    const h = await mailHarness()

    const r = await superagentSender(h.svc, owner)({ sessionId: asSessionId('gone'), text: 'hello?' })

    expect(r).toMatchObject({ ok: false })
    const [row] = await h.store.messages.listLedger({ sessionId: asSessionId('gone') })
    expect(row?.deliveryStatus).toBe('failed')
    // Found at send time: the answer is the tool's reply, not a notice
    // (a failure found later tells the operator, per POD-4778).
    expect(await h.svc.message(failureNoticeId(row?.id ?? ''))).toBeNull()
  })
})
