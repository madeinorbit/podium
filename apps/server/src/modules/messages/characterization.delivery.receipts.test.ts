/**
 * CHARACTERIZATION — agent-mail delivery WITH THE FLAG ON (POD-1761 W4, C1).
 *
 * The flag-on VARIANT of `characterization.delivery.test.ts`. That file stays
 * untouched and remains the oracle for the legacy path; this one pins what
 * changes when the session behind a send has a runtime driver, and — just as
 * importantly — what does not.
 *
 * The claim under test is "same decisions, new evidence", and it is falsifiable
 * here because both seams record into the SAME `pushes` array. Every test below
 * that asserts a receipt also asserts the bytes and the transport the legacy
 * path would have chosen, so a migration that quietly re-routed a send would
 * turn one of these red rather than merely changing which array it wrote to.
 *
 * The properties this file exists to hold down:
 *   - the urgency x lifecycle table still picks the transport. Receipts report
 *     what happened; they do not choose what to do.
 *   - every agent send is one durable row (POD-4795): the receipt is the
 *     queue's own `queued`, and the row's fate arrives later by id.
 *   - an unconfirmed row is `unknown`: ledger-visible, and never a resend. The
 *     retry storm it forbids is what a naive reading of "unconfirmed" would
 *     produce.
 *
 * No test here sleeps before an assertion (POD-757).
 */

import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { OPERATOR } from '../../test-support/capabilities'
import { mailHarness } from './characterization-support'

/** The receipt payloads recorded on the ledger, in order. */
const receipts = async (
  h: Awaited<ReturnType<typeof mailHarness>>,
): Promise<Record<string, unknown>[]> =>
  (await h.events(['message.receipt'])).map((e) => e.payload as Record<string, unknown>)

describe('flag-on delivery: the table still chooses, the receipt reports (R1)', () => {
  it('sends an idle target down the durable queue, and records its receipt', async () => {
    const h = await mailHarness({ receipts: {} })
    const iss = await h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: iss.id, phase: 'idle' })

    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'the body',
    })) as { id: string; ok: boolean }
    expect(r.ok).toBe(true)

    // Every live agent takes the durable queue, whatever its phase [POD-4661];
    // the bytes are the same — the half a receipt assertion alone would not catch.
    expect(h.pushes.map((p) => p.fn)).toEqual(['queueText'])
    expect(h.pushes[0]!.text).toContain('the body')

    // THE EVIDENCE IS NEW. Flag off, nothing on this row said whether the turn
    // opened; the ledger inferred delivery from the push returning ok.
    expect(await receipts(h)).toMatchObject([
      { messageId: r.id, outcome: 'queued', deliveredAs: 'queue', position: 1 },
    ])
  })

  it('routes an interrupt through interruptText, as the interrupt mode of a durable row', async () => {
    const h = await mailHarness({ receipts: {} })
    const iss = await h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: iss.id, phase: 'working' })

    await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'stop what you are doing',
      urgency: 'interrupt',
    })

    // A running target + interrupt urgency is the one mid-turn path, and the
    // flag does not move it. It is still one durable row (POD-4795): the
    // daemon cuts the turn and types it, and the receipt is the queue's.
    expect(h.pushes.map((p) => p.fn)).toEqual(['interruptText'])
    expect(await receipts(h)).toMatchObject([{ outcome: 'queued', deliveredAs: 'queue' }])
  })

  it('hands a busy live target the same push at once; its daemon holds it for the boundary', async () => {
    const h = await mailHarness({ receipts: {} })
    const iss = await h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: iss.id, phase: 'working' })

    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'next turn please',
      urgency: 'next-turn',
    })) as { id: string }

    // THE SERVER DOES NOT HOLD ON ITS VIEW OF THE AGENT [POD-4661]. The row goes
    // down the durable queue now, and the receipt reports what the queue did.
    expect(h.pushes.map((p) => p.fn)).toEqual(['queueText'])
    expect(await receipts(h)).toMatchObject([{ messageId: r.id, deliveredAs: 'queue' }])
  })
})

describe('flag-on delivery: an unconfirmed row is unknown, never a retry (R2)', () => {
  const unconfirmed = 'delivery could not be confirmed; check the transcript before retrying'

  it('does not resend when the sweep runs after the daemon could not confirm', async () => {
    const h = await mailHarness({ receipts: {} })
    const iss = await h.createIssue({ title: 'target' })
    const target = asSessionId('sTarget')
    h.put({ sessionId: target, issueId: iss.id, phase: 'idle' })

    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'once only',
    })) as { id: string }
    await h.svc.onQueuedInputUnknown(r.id, target, unconfirmed)
    const afterSend = h.pushes.length
    expect((await h.svc.message(r.id))!.deliveryStatus).toBe('unknown')

    // THE RETRY STORM THIS FORBIDS. If `unknown` were treated as a failure,
    // every sweep tick would re-push a message the agent may well have received
    // — worst on a slow agent, which is the likeliest producer of the outcome.
    await h.svc.sweep()
    await h.svc.sweep()
    expect(h.pushes).toHaveLength(afterSend)
  })

  it('still confirms on the transcript echo — unconfirmed did not close the question', async () => {
    const h = await mailHarness({ receipts: {} })
    const iss = await h.createIssue({ title: 'target' })
    const target = asSessionId('sTarget')
    h.put({ sessionId: target, issueId: iss.id, phase: 'idle' })

    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'echo me',
    })) as { id: string }
    await h.svc.onQueuedInputUnknown(r.id, target, unconfirmed)

    // Unproven, not failed — so the ordinary confirmation path is still open
    // and still the thing that settles the row.
    await h.svc.onTranscriptDelta(target, [{ role: 'user', text: `[podium message ${r.id} · from x]\necho me\n[end podium message ${r.id}]` }])
    const delivered = (await h.svc.message(r.id))!
    expect(delivered.deliveryStatus).toBe('confirmed')
    expect(
      (await h.events(['message.delivered'])).map(
        (e) => (e.payload as { confirmedVia: string }).confirmedVia,
      ),
    ).toEqual(['echo'])
  })
})

describe('flag-on delivery: a legacy-driven session is untouched (R4)', () => {
  it('produces no receipts for a session the daemon reports no driver for', async () => {
    // The mixed fleet, which is the reason the flag is per-session at all: one
    // daemon, one server, two sessions, only one of them driven.
    const h = await mailHarness({ receipts: { onContract: [asSessionId('sDriven')] } })
    const legacy = await h.createIssue({ title: 'legacy' })
    h.put({ sessionId: asSessionId('sLegacy'), issueId: legacy.id, phase: 'idle' })

    await h.gate.dispatch(OPERATOR, undefined, 'send', { to: `#${legacy.seq}`, body: 'no driver' })

    expect(h.pushes.map((p) => p.fn)).toEqual(['queueText'])
    expect(await receipts(h)).toEqual([])
  })
})

describe('flag-on delivery: attachment refusals notify the sender (R5)', () => {
  it('dead-letters the attachment mail and sends its typed refusal back once', async () => {
    const target = asSessionId('sAttachmentTarget')
    const sender = asSessionId('sAttachmentSender')
    const h = await mailHarness({
      receipts: {
        onContract: [target],
        answer: () => ({
          outcome: 'refused',
          refusal: {
            reason: 'unsupported',
            detail: 'this agent cannot accept file attachments',
          },
        }),
      },
    })
    const targetIssue = await h.createIssue({ title: 'target' })
    const senderIssue = await h.createIssue({ title: 'sender' })
    h.put({ sessionId: target, issueId: targetIssue.id, phase: 'idle' })
    h.put({ sessionId: sender, issueId: senderIssue.id, phase: 'idle' })

    const sent = await h.svc.send(
      { kind: 'agent', issueId: senderIssue.id, sessionId: sender },
      {
        to: { kind: 'session', id: target },
        body: 'inspect the file',
        attachments: [
          {
            id: 'att-1',
            path: `/state/uploads/${target}/att-1.png`,
            filename: 'shot.png',
            mediaType: 'image/png',
            kind: 'image',
          },
        ],
      },
    )

    expect(await h.svc.message(sent.message.id)).toMatchObject({ deliveryStatus: 'failed' })
    expect(h.pushes.filter((push) => push.sessionId === sender).map((push) => push.text)).toEqual([
      expect.stringContaining('this agent cannot accept file attachments'),
    ])
  })
})
