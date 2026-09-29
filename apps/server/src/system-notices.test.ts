import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { autoContinueMessageId } from './message-ids'
import { messageRecordOf } from './modules/message-feed/feed'
import { mailHarness } from './modules/messages/characterization-support'
import { autoContinueSender, systemIssueNotice } from './system-notices'

/**
 * THE SERVER'S NOTICES TO AN ISSUE ARE MESSAGES (POD-4846).
 *
 * Lock grants and steals, approval decisions and machine diagnostics used to be
 * written straight into the legacy issue mailbox, and a separate nudge typed a
 * pointer line ("You have mail on issue #N …") into one live session — no id,
 * no status, and a pointer instead of the words. They now take the one path
 * every issue message takes.
 */
describe('a system notice to an issue', () => {
  const body = "Lock 'build' granted to you (TTL 2m). Release with `podium lock release build` when done."

  it('is a message from the named system sender, typed in full inside the envelope', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'holder' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })

    const id = await systemIssueNotice(h.svc, 'lock-manager')(iss.id, body)

    expect(await h.svc.message(id)).toMatchObject({
      fromKind: 'system',
      fromName: 'lock-manager',
      toKind: 'issue',
      toId: iss.id,
      kind: 'notification',
      urgency: 'next-turn',
      lifecycle: 'wait',
      body,
      clampedFrom: null,
      deliveryStatus: 'dispatched',
      deliveredTo: 's1',
    })
    const [push, ...more] = h.pushes
    expect(more).toHaveLength(0)
    expect(push).toMatchObject({ fn: 'queueText', sessionId: 's1', inputOrigin: 'mail' })
    // The words themselves, not a pointer to the inbox.
    const text = push?.text ?? ''
    expect(text.startsWith(`[podium message ${id} · from system:lock-manager`)).toBe(true)
    expect(text).toContain(body)
    expect(text).not.toContain('You have mail')
  })

  it("stays in the issue's mailbox under the same id, from the same author as before", async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'holder' })

    const id = await systemIssueNotice(h.svc, 'machine-diagnostic')(iss.id, 'integration disabled')

    // No session: held for the issue's next one, and readable from its inbox.
    expect((await h.svc.message(id))?.deliveryStatus).toBe('stored')
    expect(h.pushes).toHaveLength(0)
    expect(await h.issues.mailInbox(iss.id)).toMatchObject([
      { id, fromAuthor: 'machine-diagnostic', body: 'integration disabled' },
    ])
  })
})

/**
 * AUTO-CONTINUE IS A MESSAGE, WRAPPED IN A SHORT FRAME (POD-4846, POD-4868).
 *
 * The 'continue' the server types into an errored agent is a row with an id
 * and a status, one per errored turn however often the retry loop fires, and
 * it is not a person's chat bubble. It carries its id in the text like every
 * other message that is not a person's own words, so the agent's history names
 * it exactly. The frame is the short one: the id line and the end line, with
 * none of the rules for mail an agent answers.
 */
const shortFrame = (id: string, from: string, body: string): string =>
  `[podium message ${id} · from ${from} · to your session]\n${body}\n[end podium message ${id}]`

describe('an auto-continue', () => {
  it("is a row from system:auto-continue, typed inside the short frame with the auto-continue origin", async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'work' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'errored' })

    const r = await autoContinueSender(h.svc)({ sessionId: asSessionId('s1'), erroredTurn: 'epoch:3' })

    expect(r).toEqual({ ok: true })
    const id = autoContinueMessageId(asSessionId('s1'), 'epoch:3')
    const row = await h.svc.message(id)
    expect(row).toMatchObject({
      fromKind: 'system',
      fromName: 'auto-continue',
      toKind: 'session',
      toId: 's1',
      body: 'continue',
      lifecycle: 'wait',
      deliveryStatus: 'dispatched',
    })
    expect(h.pushes).toEqual([
      expect.objectContaining({
        fn: 'queueText',
        sessionId: 's1',
        text: shortFrame(id, 'system:auto-continue', 'continue'),
        inputOrigin: 'auto_continue',
      }),
    ])
    // Not a person's chat message: no bubble on the chat feed.
    expect(row && messageRecordOf(row)).toBeNull()
  })

  it("is confirmed by its id when the agent's history shows the typed turn", async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'work' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'errored' })
    await autoContinueSender(h.svc)({ sessionId: asSessionId('s1'), erroredTurn: 'epoch:3' })
    const id = autoContinueMessageId(asSessionId('s1'), 'epoch:3')

    await h.svc.onTranscriptDelta(asSessionId('s1'), [{ role: 'user', text: h.pushes[0]?.text ?? '' }])

    expect((await h.svc.message(id))?.deliveryStatus).toBe('confirmed')
  })

  it('the retry loop firing again inside one errored turn stores and types it once', async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'work' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'errored' })
    const send = autoContinueSender(h.svc)

    await send({ sessionId: asSessionId('s1'), erroredTurn: 'epoch:3' })
    await send({ sessionId: asSessionId('s1'), erroredTurn: 'epoch:3' })
    await send({ sessionId: asSessionId('s1'), erroredTurn: 'epoch:4' })

    expect(await h.store.messages.listLedger({ sessionId: asSessionId('s1') })).toHaveLength(2)
    expect(h.pushes.map((p) => p.text)).toEqual(
      ['epoch:3', 'epoch:4'].map((turn) =>
        shortFrame(autoContinueMessageId(asSessionId('s1'), turn), 'system:auto-continue', 'continue'),
      ),
    )
  })
})
