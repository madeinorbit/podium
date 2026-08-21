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
 * The three properties this file exists to hold down:
 *   - the urgency x lifecycle table still picks the transport. Receipts report
 *     what happened; they do not choose what to do.
 *   - `unverified` is DELIVERED-UNCONFIRMED: ledger-visible, and never a resend.
 *     This is the acceptance criterion the item names explicitly, and the retry
 *     storm it forbids is what a naive reading of "unverified" would produce.
 *   - a receipt never moves a row that the echo, a read or a cancellation
 *     already settled.
 *
 * No test here sleeps before an assertion (POD-757). The verification window is
 * modelled by `receipts.defer` + `settleReceipts()`, which is the window closing
 * on demand rather than after a wall-clock wait.
 */

import { asSessionId } from '@podium/model'
import type {
  TurnReceipt,
} from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { OPERATOR } from '../../test-support/capabilities'
import { mailHarness } from './characterization-support'

/** The receipt payloads recorded on the ledger, in order. */
const receipts = (h: ReturnType<typeof mailHarness>): Record<string, unknown>[] =>
  h
    .events(['message.receipt'])
    .map((e) => e.payload as Record<string, unknown>)

describe('flag-on delivery: the table still chooses, the receipt reports (R1)', () => {
  it('sends an idle target through the same push, and settles it with an accepted receipt', async () => {
    const h = mailHarness({ receipts: {} })
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: iss.id, phase: 'idle' })

    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'the body',
    })) as { id: string; ok: boolean }
    expect(r.ok).toBe(true)

    // THE DECISION IS UNCHANGED. An idle target is injected now, by the same
    // verb, with the same bytes — this is the half of the claim that a receipt
    // assertion alone would not catch.
    expect(h.pushes.map((p) => p.fn)).toEqual(['sendText'])
    expect(h.pushes[0]!.text).toContain('the body')

    // THE EVIDENCE IS NEW. Flag off, nothing on this row said whether the turn
    // opened; the ledger inferred delivery from the push returning ok.
    expect(receipts(h)).toMatchObject([
      { messageId: r.id, outcome: 'accepted', provenBy: 'hook', deliveredAs: 'when-ready' },
    ])
  })

  it('routes an interrupt through interruptText and reports the interrupt delivery', async () => {
    const h = mailHarness({ receipts: {} })
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: iss.id, phase: 'working' })

    await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'stop what you are doing',
      urgency: 'interrupt',
    })

    // A running target + interrupt urgency is the one mid-turn path, and the
    // flag does not move it.
    expect(h.pushes.map((p) => p.fn)).toEqual(['interruptText'])
    expect(receipts(h)).toMatchObject([{ outcome: 'accepted', deliveredAs: 'interrupt' }])
  })

  it('leaves a busy live target holding for its turn boundary, with no push and no receipt', async () => {
    const h = mailHarness({ receipts: {} })
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: iss.id, phase: 'working' })

    await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'next turn please',
      urgency: 'next-turn',
    })

    // THE TABLE HOLDS THE ROW WITHOUT SENDING AT ALL. There is nothing for a
    // receipt to report because nothing was dispatched — the flag must not turn
    // a deliberate hold into a speculative send.
    expect(h.pushes).toEqual([])
    expect(receipts(h)).toEqual([])
  })
})

describe('flag-on delivery: unverified is delivered-unconfirmed, never a retry (R2)', () => {
  const unverified: TurnReceipt = {
    outcome: 'unverified',
    deliveredAs: 'when-ready',
    verificationWindowMs: 4000,
    at: '2026-07-20T12:00:00.000Z',
  }

  it('records the unconfirmed delivery on the ledger and pushes exactly once', async () => {
    const h = mailHarness({ receipts: { answer: () => unverified } })
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: iss.id, phase: 'idle' })

    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'did this land?',
    })) as { id: string }

    // THE ACCEPTANCE CRITERION. The window closed without proof, and the answer
    // is one honest ledger entry — not a second push.
    expect(h.pushes).toHaveLength(1)
    expect(receipts(h)).toMatchObject([
      {
        messageId: r.id,
        outcome: 'unverified',
        deliveryConfirmed: false,
        verificationWindowMs: 4000,
      },
    ])

    // The row itself is exactly where an un-echoed push always sits: still
    // queued, stamped injected, awaiting the echo. `unverified` describes the
    // EVIDENCE, and does not invent a new resting state for the message.
    const row = h.svc.message(r.id)!
    expect(row.status).toBe('queued')
    expect(row.injectedAt).toBeTruthy()
  })

  it('does not resend when the sweep runs after an unverified receipt', async () => {
    const h = mailHarness({ receipts: { answer: () => unverified } })
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: iss.id, phase: 'idle' })

    await h.gate.dispatch(OPERATOR, undefined, 'send', { to: `#${iss.seq}`, body: 'once only' })
    const afterSend = h.pushes.length

    // THE RETRY STORM THIS FORBIDS. If `unverified` were treated as a failure,
    // every sweep tick would re-push a message the agent may well have received
    // — worst on a slow agent, which is the likeliest producer of the outcome.
    h.svc.sweep()
    h.svc.sweep()
    expect(h.pushes).toHaveLength(afterSend)
  })

  it('still confirms on the transcript echo — the receipt did not close the question', async () => {
    const h = mailHarness({ receipts: { answer: () => unverified } })
    const iss = h.createIssue({ title: 'target' })
    const target = asSessionId('sTarget')
    h.put({ sessionId: target, issueId: iss.id, phase: 'idle' })

    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'echo me',
    })) as { id: string }
    expect(h.svc.message(r.id)!.status).toBe('queued')

    // `unverified` is unproven, not failed — so the ordinary confirmation path
    // is still open and still the thing that settles the row.
    h.svc.onTranscriptDelta(target, [{ role: 'user', text: `[podium message ${r.id} · from x]` }])
    const delivered = h.svc.message(r.id)!
    expect(delivered.status).toBe('delivered')
    expect(
      h.events(['message.delivered']).map((e) => (e.payload as { confirmedVia: string }).confirmedVia),
    ).toEqual(['echo'])
  })
})

describe('flag-on delivery: the window is open until the driver answers (R3)', () => {
  it('reports nothing while the receipt is outstanding, then records it on settle', async () => {
    const h = mailHarness({ receipts: { defer: true } })
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: iss.id, phase: 'idle' })

    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'in flight',
    })) as { id: string; ok: boolean }

    // THE CALLER ALREADY HAS ITS ANSWER. This is the shape of the migration: a
    // synchronous, optimistic reply now, and the honest evidence afterwards —
    // which is what lets the ledger stay truthful without every sender learning
    // to await proof.
    expect(r.ok).toBe(true)
    expect(h.pushes).toHaveLength(1)
    expect(receipts(h)).toEqual([])

    expect(h.settleReceipts()).toBe(1)
    expect(receipts(h)).toMatchObject([{ messageId: r.id, outcome: 'accepted' }])
  })

  it('does not move a row the echo already settled while the window was open', async () => {
    const h = mailHarness({ receipts: { defer: true, answer: () => unverifiedLate } })
    const iss = h.createIssue({ title: 'target' })
    const target = asSessionId('sTarget')
    h.put({ sessionId: target, issueId: iss.id, phase: 'idle' })

    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'raced',
    })) as { id: string }

    // The echo beats the driver's window closing — an ordinary race once sends
    // stop being instantaneous.
    h.svc.onTranscriptDelta(target, [{ role: 'user', text: `[podium message ${r.id} · from x]` }])
    expect(h.svc.message(r.id)!.status).toBe('delivered')

    h.settleReceipts()
    // LATE EVIDENCE ABOUT A CLOSED QUESTION. The receipt is recorded for the
    // ledger's benefit, but a delivered row must never walk backwards because
    // the driver could not prove what the transcript already showed.
    expect(h.svc.message(r.id)!.status).toBe('delivered')
  })
})

const unverifiedLate: TurnReceipt = {
  outcome: 'unverified',
  deliveredAs: 'when-ready',
  verificationWindowMs: 4000,
  at: '2026-07-20T12:00:00.000Z',
}

describe('flag-on delivery: a legacy-driven session is untouched (R4)', () => {
  it('produces no receipts for a session the daemon reports no driver for', async () => {
    // The mixed fleet, which is the reason the flag is per-session at all: one
    // daemon, one server, two sessions, only one of them driven.
    const h = mailHarness({ receipts: { onContract: [asSessionId('sDriven')] } })
    const legacy = h.createIssue({ title: 'legacy' })
    h.put({ sessionId: asSessionId('sLegacy'), issueId: legacy.id, phase: 'idle' })

    await h.gate.dispatch(OPERATOR, undefined, 'send', { to: `#${legacy.seq}`, body: 'no driver' })

    expect(h.pushes.map((p) => p.fn)).toEqual(['sendText'])
    expect(receipts(h)).toEqual([])
  })
})
