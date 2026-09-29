import { asSessionId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { automationPromptMessageId, failureNoticeId } from '../../message-ids'
import { mailHarness } from '../messages/characterization-support'
import { automationPromptSender } from './prompt'

/**
 * AN AUTOMATION'S PROMPT IS A MESSAGE FROM ITS OWNER (POD-4846).
 *
 * The row is the owner's, attributed to the automation that delivered it. A
 * schedule typed it, not the person, so it is wrapped in the short frame — its
 * id in the text, no mail rules around it (POD-4868) — it does not count as the
 * person acting on a standing offer, and a failure is the run's to record, not
 * mail.
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

  it("is stored as the owner's words, attributed to the automation, and typed inside the short frame", async () => {
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
    // The words as the person wrote them, inside the short frame that names the
    // automation — and not a person typing now: `system`, so a standing offer
    // survives the scheduled prompt.
    expect(push).toMatchObject({
      fn: 'queueText',
      sessionId: 's1',
      text:
        `[podium message ${id} · from automation:aut_nightly · to your session]\n` +
        `Summarise what changed overnight.\n` +
        `[end podium message ${id}]`,
      inputOrigin: 'system',
    })
  })

  it("is confirmed by its id when the agent's history shows the typed turn", async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'nightly' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'starting' })
    await sender(h)(prompt())
    const id = automationPromptMessageId('run_1', asSessionId('s1'))

    await h.svc.onTranscriptDelta(asSessionId('s1'), [{ role: 'user', text: h.pushes[0]?.text ?? '' }])

    expect((await h.svc.message(id))?.deliveryStatus).toBe('confirmed')
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
