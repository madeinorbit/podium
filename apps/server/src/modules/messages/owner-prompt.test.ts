import { actorSystem, actorUser, asSessionId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { failureNoticeId, spawnPromptMessageId } from '../../message-ids'
import { messageRecordOf } from '../message-feed/feed'
import { mailHarness } from './characterization-support'

/**
 * THE TASK A PERSON STARTED A SESSION WITH IS THEIR MESSAGE (POD-4846).
 *
 * A session spawned by another session already stores its task as the
 * parent's message (POD-4778). One a person started had no row: no id, no
 * status, and nothing for the chat to show as theirs. It is now the owner's
 * message under the session's spawn-prompt id, typed as their own words, and a
 * failure is reported the way it always was — the inbox's prompt-failed
 * attention — not by mail.
 */
describe("a person's initial prompt", () => {
  const owner = firstAdminMemberId()
  const person = { actor: actorUser(owner), onBehalfOf: owner }

  it("is the owner's message, already handed to the new session, and on their chat feed", async () => {
    const h = await mailHarness()
    const iss = await h.createIssue({ title: 'work' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'starting' })

    const id = await h.svc.recordOwnerPrompt({
      sessionId: asSessionId('s1'),
      text: 'Fix the flaky login test.',
      attribution: person,
    })

    expect(id).toBe(spawnPromptMessageId(asSessionId('s1')))
    const row = await h.svc.message(id)
    expect(row).toMatchObject({
      fromKind: 'operator',
      attribution: person,
      toKind: 'session',
      toId: 's1',
      kind: 'message',
      body: 'Fix the flaky login test.',
      deliveryStatus: 'dispatched',
      deliveredTo: 's1',
    })
    // The person's own bubble on the chat feed.
    expect(row && messageRecordOf(row)).toMatchObject({ id, senderUserId: owner })
    // The start path queues the prompt itself; the sweep never pushes it again.
    await h.svc.sweep()
    expect(h.pushes).toHaveLength(0)
  })

  it('a retried start stores nothing new', async () => {
    const h = await mailHarness()
    h.put({ sessionId: asSessionId('s1'), status: 'starting' })
    const input = { sessionId: asSessionId('s1'), text: 'go', attribution: person }

    const first = await h.svc.recordOwnerPrompt(input)
    expect(await h.svc.recordOwnerPrompt(input)).toBe(first)
    expect(await h.store.messages.listLedger({ sessionId: asSessionId('s1') })).toHaveLength(1)
  })

  it('a prompt that fails is the inbox attention’s to report: no failure notice', async () => {
    const h = await mailHarness()
    h.put({ sessionId: asSessionId('s1'), status: 'starting' })
    const id = await h.svc.recordOwnerPrompt({
      sessionId: asSessionId('s1'),
      text: 'go',
      attribution: person,
    })

    await h.svc.rejectQueuedInput(id, 'could not deliver', 'delivery-failed')

    expect((await h.svc.message(id))?.deliveryStatus).toBe('failed')
    expect(await h.svc.message(failureNoticeId(id))).toBeNull()
  })

  it("a session a job started carries the job's attribution and is no person's bubble", async () => {
    const h = await mailHarness()
    h.put({ sessionId: asSessionId('s1'), status: 'starting' })
    const job = { actor: actorSystem('issue-start'), onBehalfOf: null }

    const id = await h.svc.recordOwnerPrompt({ sessionId: asSessionId('s1'), text: 'go', attribution: job })

    const row = await h.svc.message(id)
    expect(row).toMatchObject({ fromKind: 'operator', attribution: job })
    expect(row && messageRecordOf(row)).toBeNull()
  })
})
