import { asSessionId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { automationPromptMessageId, failureNoticeId } from '../../message-ids'
import { mailHarness } from '../messages/characterization-support'
import { automationPromptSender } from './prompt'

/**
 * AN AUTOMATION'S PROMPT IS A MESSAGE FROM ITS OWNER (POD-4846).
 *
 * A person wrote the words, so they are typed as that person's own — no
 * envelope, shown as the owner's bubble — but a schedule delivered them: the
 * row is attributed to the automation, it does not count as the person acting
 * on a standing offer, and a failure is the run's to record, not mail.
 */
describe('an automation prompt', () => {
  const owner = firstAdminMemberId()
  const prompt = (over: Partial<Parameters<ReturnType<typeof automationPromptSender>>[0]> = {}) => ({
    automationId: 'aut_nightly',
    ownerUserId: owner,
    runId: 'run_1',
    sessionId: asSessionId('s1'),
    text: 'Summarise what changed overnight.',
    resume: false,
    ...over,
  })
  const sender = (h: Awaited<ReturnType<typeof mailHarness>>) =>
    automationPromptSender({
      messages: h.svc,
      sessionById: async (id) => h.sessions.find((s) => s.sessionId === id),
    })

  it("is stored as the owner's words, attributed to the automation, and typed without a frame", async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'nightly' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'starting' })

    const r = await sender(h)(prompt())

    expect(r).toMatchObject({ ok: true })
    const id = automationPromptMessageId('run_1', asSessionId('s1'))
    expect(await h.svc.message(id)).toMatchObject({
      fromKind: 'operator',
      toKind: 'session',
      toId: 's1',
      kind: 'message',
      body: 'Summarise what changed overnight.',
      attribution: { actor: { kind: 'system', job: 'automation:aut_nightly' }, onBehalfOf: owner },
      deliveryStatus: 'dispatched',
    })
    const [push, ...more] = h.pushes
    expect(more).toHaveLength(0)
    // The words exactly as the person wrote them, and not a person typing now:
    // `system`, so a standing offer survives the scheduled prompt.
    expect(push).toMatchObject({
      fn: 'queueText',
      sessionId: 's1',
      text: 'Summarise what changed overnight.',
      inputOrigin: 'system',
    })
  })

  it('a repeated run stores one message and types it once', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'nightly' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'starting' })

    await sender(h)(prompt())
    await sender(h)(prompt())

    expect(await h.store.messages.listLedger({ sessionId: asSessionId('s1') })).toHaveLength(1)
    expect(h.pushes).toHaveLength(1)
  })

  it("resume wakes the previous run's parked session", async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'nightly' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'hibernated', resumable: true })

    const r = await sender(h)(prompt({ resume: true }))

    expect(r).toMatchObject({ ok: true })
    expect(
      await h.svc.message(automationPromptMessageId('run_1', asSessionId('s1'))),
    ).toMatchObject({ lifecycle: 'wake', deliveryStatus: 'dispatched' })
    expect(h.pushes.map((p) => [p.fn, p.sessionId])).toEqual([['queueText', 's1']])
  })

  // The automation's own fallback — a fresh automation issue and session — is
  // what a resume that cannot happen leads to. Nothing is stored, and the mail
  // wake rule (spawn on the old session's issue) never takes its place.
  it('resume to a session that is gone, or cannot resume, answers why and stores nothing', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'nightly' })
    h.put({ sessionId: asSessionId('parked'), issueId: iss.id, status: 'exited', resumable: false })

    const gone = await sender(h)(prompt({ resume: true, sessionId: asSessionId('gone') }))
    const parked = await sender(h)(prompt({ resume: true, sessionId: asSessionId('parked') }))

    expect(gone).toEqual({ ok: false, reason: 'unknown session' })
    expect(parked).toEqual({ ok: false, reason: 'no resume ref' })
    expect(await h.svc.message(automationPromptMessageId('run_1', asSessionId('gone')))).toBeNull()
    expect(await h.svc.message(automationPromptMessageId('run_1', asSessionId('parked')))).toBeNull()
    expect(h.pushes).toHaveLength(0)
    expect(h.wakeSpawns).toHaveLength(0)
  })

  it('a prompt whose session goes away fails on its own row and sends the owner no mail', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'nightly' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'hibernated', resumable: true })
    // The transport refuses the wake, so the row is still stored when the
    // session is removed and the sweep finds it undeliverable.
    h.transport.ok = false

    await sender(h)(prompt({ resume: true }))
    h.sessions.splice(0, h.sessions.length)
    h.transport.ok = true
    await h.svc.sweep()

    const id = automationPromptMessageId('run_1', asSessionId('s1'))
    expect((await h.svc.message(id))?.deliveryStatus).toBe('failed')
    expect(await h.svc.message(failureNoticeId(id))).toBeNull()
  })
})
