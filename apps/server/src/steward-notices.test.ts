import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { failureNoticeId } from './message-ids'
import { mailHarness } from './modules/messages/characterization-support'
import { noticeMessageId, stewardNoticeSender } from './steward'

/**
 * A STEWARD NOTICE IS A MESSAGE (POD-4846).
 *
 * The steward's nudges used to be typed through the session queue with no
 * `messages` row: no envelope, no id in the transcript, no delivery status, and
 * a queue row deleted on delivery, so a crash between typing and the steward's
 * claim typed the nudge again. These pin the production sender the steward is
 * wired with against the real delivery service.
 */
describe('steward notices travel as messages', () => {
  const body =
    'Blocker #3 closed — you are unblocked. See the steward comment on your issue, or run: podium issue prime'

  it('stores the notice under its id, from the steward, and types its words inside the envelope', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'dependent' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    const id = noticeMessageId(`unblock:${iss.id}:3`, asSessionId('s1'), 7)

    await stewardNoticeSender(h.svc)(asSessionId('s1'), body, id, 'wait')

    expect(await h.svc.message(id)).toMatchObject({
      id,
      fromKind: 'system',
      fromName: 'steward',
      toKind: 'session',
      toId: 's1',
      kind: 'notification',
      urgency: 'next-turn',
      lifecycle: 'wait',
      body,
      clampedFrom: null,
      deliveryStatus: 'dispatched',
    })
    const [push, ...more] = h.pushes
    expect(more).toHaveLength(0)
    expect(push).toMatchObject({ fn: 'queueText', sessionId: 's1', inputOrigin: 'mail' })
    // The words are the steward's, unchanged; only the frame is added.
    const text = push?.text ?? ''
    expect(text.startsWith(`[podium message ${id} · from system:steward · to your session`)).toBe(true)
    expect(text).toContain(`\n${body}\n`)
    expect(text.endsWith(`[end podium message ${id}]`)).toBe(true)
  })

  it('a repeat under the same id stores one message and types it once', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'dependent' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    const id = noticeMessageId(`unblock:${iss.id}:3`, asSessionId('s1'), 7)
    const send = stewardNoticeSender(h.svc)

    await send(asSessionId('s1'), body, id, 'wait')
    await send(asSessionId('s1'), body, id, 'wait')

    expect(await h.store.messages.listLedger({ sessionId: asSessionId('s1') })).toHaveLength(1)
    expect(h.pushes).toHaveLength(1)
  })

  it('a wake notice resurrects a parked session, and the next one inside the wake cooldown still wakes', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'parent' })
    h.put({ sessionId: asSessionId('parent'), issueId: iss.id, status: 'hibernated' })
    const send = stewardNoticeSender(h.svc)
    const first = noticeMessageId('sessionparentnudge:phase-reported:c1', asSessionId('parent'), 7)
    const second = noticeMessageId('sessionparentnudge:phase-reported:c2', asSessionId('parent'), 9)

    await send(asSessionId('parent'), 'Child session c1 finished.', first, 'wake')
    await send(asSessionId('parent'), 'Child session c2 finished.', second, 'wake')

    // A clamp to wait would hold the second wake until the parent's next run —
    // a parent that parked again inside the cooldown would never hear of c2.
    for (const id of [first, second]) {
      expect(await h.svc.message(id)).toMatchObject({
        lifecycle: 'wake',
        clampedFrom: null,
        deliveryStatus: 'dispatched',
      })
    }
    expect(h.pushes.map((p) => [p.fn, p.sessionId])).toEqual([
      ['queueText', 'parent'],
      ['queueText', 'parent'],
    ])
  })

  it('a wait notice to a parked session is held for its next run, not typed', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'dependent' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'hibernated' })
    const id = noticeMessageId(`unblock:${iss.id}:3`, asSessionId('s1'), 7)

    await stewardNoticeSender(h.svc)(asSessionId('s1'), body, id, 'wait')

    expect((await h.svc.message(id))?.deliveryStatus).toBe('stored')
    expect(h.pushes).toHaveLength(0)
  })

  it('a notice whose session goes away fails on its own row and tells nobody', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'dependent' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'hibernated' })
    const id = noticeMessageId(`unblock:${iss.id}:3`, asSessionId('s1'), 7)
    // Held for the parked session's next run; stored is the steward's answer.
    await stewardNoticeSender(h.svc)(asSessionId('s1'), body, id, 'wait')
    expect((await h.svc.message(id))?.deliveryStatus).toBe('stored')

    // The session is removed before it runs again. The sweep finds the notice
    // undeliverable: a failure found after the send is the one that tells a
    // sender — and a system sender has nobody to tell (POD-4778).
    h.sessions.splice(0, h.sessions.length)
    await h.svc.sweep()

    expect((await h.svc.message(id))?.deliveryStatus).toBe('failed')
    expect(await h.svc.message(failureNoticeId(id))).toBeNull()
    expect(h.pushes).toHaveLength(0)
  })
})
