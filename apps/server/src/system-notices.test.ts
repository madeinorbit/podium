import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { mailHarness } from './modules/messages/characterization-support'
import { systemIssueNotice } from './system-notices'

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
