/**
 * CHARACTERIZATION — what a REFUSED receipt does to the row it answers [POD-2298].
 *
 * The third file in the flag-on set, and the one that pins the exception its
 * sibling establishes. `characterization.delivery.receipts.test.ts` holds down
 * "a receipt records, it never resends", which is right for three of the four
 * outcomes and was wrong for the fourth: a `refused` receipt is not evidence
 * about an unknown, it is the driver saying it never took the text. Recording
 * that and nothing else left an operator's chat line reading `delivered` with
 * nothing delivered — off `countPending`, off the sweep, out of the sender's
 * `waitFor`, and impossible to notice.
 *
 * The three properties this file exists to hold down:
 *   - a refusal whose cause CLEARS ON ITS OWN hands the row to the session's
 *     durable queue, which types it when the session can take it. The status
 *     stays `dispatched`: it never walks back (POD-4765).
 *   - a refusal whose cause does NOT clear goes terminal and tells the sender
 *     once, in the SAME words the drain-abandonment route uses for the same news.
 *   - a refusal still never moves a row the echo, a read or a cancellation
 *     already settled, and never corrects a push its caller has not recorded yet.
 *
 * `receipts.defer` + `settleReceipts()` is how every test here models the
 * verification window, and it is load-bearing rather than stylistic: on the real
 * seam a `now`/`interrupt` receipt resolves from a promise and therefore lands
 * AFTER its caller recorded, while only the durable-queue path answers inside the
 * call. Deferring is that ordering, without a wall-clock sleep (POD-757).
 */

import { asSessionId } from '@podium/model'
import type { TurnReceipt } from '@podium/protocol/daemon'
import { RefusalReason } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { OPERATOR } from '../../test-support/capabilities'
import { mailHarness } from './characterization-support'

const TARGET = asSessionId('sTarget')

const refused = (reason: RefusalReason, detail?: string): TurnReceipt => ({
  outcome: 'refused',
  refusal: { reason, ...(detail ? { detail } : {}) },
})

/** A staged attachment ref, minted by runtime staging rather than typed. */
const SHOT = {
  id: 'att_1',
  path: '/staged/shot.png',
  filename: 'shot.png',
  mediaType: 'image/png',
  kind: 'image' as const,
}

/** The issue's own case: an operator chat line into a live session. It is
 *  UNWRAPPED — no envelope, so no id can ever echo — so only the driver's receipt
 *  (or a turn boundary) can confirm it, and a refusal has nobody else to correct
 *  it. The durable queue a clearing refusal hands the row to accepts it. */
const chatHarness = async (answer: () => TurnReceipt, opts?: { defer?: boolean }) => {
  const h = await mailHarness({
    receipts: { defer: opts?.defer ?? true, answer: (via) => (via === 'queue' ? QUEUED : answer()) },
  })
  const iss = await h.createIssue({ title: 'target' })
  h.put({ sessionId: TARGET, issueId: iss.id, phase: 'idle' })
  return h
}

/** An operator INTERRUPT line: since every other send rides the durable queue
 *  to the daemon [POD-4661], the interrupt is the push that reaches the driver
 *  directly, and so the one whose optimistic record a refusal can disprove. */
const chat = async (h: Awaited<ReturnType<typeof mailHarness>>, body: string): Promise<string> => {
  const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
    to: TARGET,
    body,
    urgency: 'interrupt',
  })) as {
    id: string
  }
  return r.id
}

/** Every undelivered-notice the sender was actually handed. */
const notices = async (h: Awaited<ReturnType<typeof mailHarness>>): Promise<string[]> =>
  (await h.store.messages.listMessagesFor({ kind: 'operator' }))
    .filter((m) => m.kind === 'notification' && m.fromKind === 'system')
    .map((m) => m.body)

const transitions = async (
  h: Awaited<ReturnType<typeof mailHarness>>,
  kind: string,
  id: string,
) => (await h.events([kind])).filter((e) => e.subject === id)

describe('a refusal that will clear hands the row to the durable queue (F1)', () => {
  it('queues a chat line the driver refused as busy, and never walks its status back', async () => {
    const h = await chatHarness(() =>
      refused('busy', 'a turn was still open when the ready window closed'),
    )
    const id = await chat(h, 'are you there?')

    // HANDED ON, NOT DELIVERED. A receipt is coming, so the push is only
    // dispatched until it answers — a confirmed row could never move again.
    expect(await h.svc.message(id)).toMatchObject({ deliveryStatus: 'dispatched', deliveredTo: TARGET })
    expect(h.pushes.map((p) => p.fn)).toEqual(['interruptText'])

    await h.settleReceipts()

    // `busy` means a turn was open — it ends on its own — so the row goes to the
    // session's durable queue, which types it when the session can take it. The
    // status stays where it was: dispatched to the same session.
    expect(h.pushes.map((p) => p.fn)).toEqual(['interruptText', 'queueText'])
    expect(await h.svc.message(id)).toMatchObject({ deliveryStatus: 'dispatched', deliveredTo: TARGET })
    expect(await transitions(h, 'message.requeued', id)).toHaveLength(1)
    expect(await notices(h)).toEqual([])
  })

  it('treats needs_user and a held control lease the same way', async () => {
    for (const reason of ['needs_user', 'lease_held'] as const) {
      const h = await chatHarness(() => refused(reason))
      const id = await chat(h, `when you are free (${reason})`)

      await h.settleReceipts()

      expect((await h.svc.message(id))!.deliveryStatus).toBe('dispatched')
      expect(h.pushes.map((p) => p.fn)).toEqual(['interruptText', 'queueText'])
      // Queued is NOT failed, so the sender is told nothing: the message is
      // still on its way and a notice would be a lie in the other direction.
      expect(await notices(h)).toEqual([])
    }
  })

  it('fails the row when the queue refuses it too, instead of stranding it', async () => {
    const h = await mailHarness({
      receipts: {
        defer: true,
        answer: (via) => (via === 'queue' ? refused('session_ended') : refused('busy')),
      },
    })
    const iss = await h.createIssue({ title: 'target' })
    h.put({ sessionId: TARGET, issueId: iss.id, phase: 'idle' })
    const id = await chat(h, 'nowhere to wait')

    await h.settleReceipts()
    await h.settleReceipts()

    expect((await h.svc.message(id))!.deliveryStatus).toBe('failed')
    expect(await transitions(h, 'message.dead_letter', id)).toHaveLength(1)
    expect(await notices(h)).toHaveLength(1)
  })

  it('never records a reader receipt for a push that was only handed on', async () => {
    const h = await chatHarness(() => refused('busy'))
    const id = await chat(h, 'unread, actually')

    // A per-reader receipt says this session saw it; a push the driver has not
    // answered yet has not been seen by anyone [POD-1379].
    expect((await h.store.messages.readReceipts(TARGET, [id])).has(id)).toBe(false)
    await h.settleReceipts()
    expect((await h.store.messages.readReceipts(TARGET, [id])).has(id)).toBe(false)
  })
})

describe('the receipt, not the push, confirms a direct send (POD-4765)', () => {
  it('confirms the chat line when the driver accepts it, once', async () => {
    const h = await chatHarness(() => ACCEPTED)
    const id = await chat(h, 'take it')
    expect((await h.svc.message(id))!.deliveryStatus).toBe('dispatched')

    await h.settleReceipts()
    await h.replayReceipts()

    expect(await h.svc.message(id)).toMatchObject({ deliveryStatus: 'confirmed', deliveredTo: TARGET })
    // A repeated acceptance is already there: one transition, not two.
    expect(await transitions(h, 'message.delivered', id)).toHaveLength(1)
  })

  it('never answers an interrupt send `delivered` before the driver does (POD-4775)', async () => {
    // An unwrapped operator line has no id to echo, which is why it used to be
    // "confirmed on injection" — and the sender was told `delivered` while the
    // receipt was still out. The answer is `queued` (handed on) until it lands.
    const h = await chatHarness(() => ACCEPTED)
    const r = await h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: TARGET }, body: 'stop and read this', urgency: 'interrupt' },
    )
    expect(r.disposition).toBe('queued')
    expect((await h.svc.message(r.message.id))!.deliveryStatus).toBe('dispatched')

    await h.settleReceipts()
    expect((await h.svc.message(r.message.id))!.deliveryStatus).toBe('confirmed')
  })
})

describe('a refusal that will not clear goes terminal, and says so once (F2)', () => {
  it('dead-letters a chat line the driver refused as not_running, and tells the sender', async () => {
    const h = await chatHarness(() => refused('not_running', 'the daemon dropped the handle'))
    const id = await chat(h, 'anyone home?')
    expect((await h.svc.message(id))!.deliveryStatus).toBe('dispatched')

    await h.settleReceipts()

    // TERMINAL, with the same stamps the drain-abandonment route writes — one
    // undelivered turn reads the same way whichever route reported it.
    expect(await h.svc.message(id)).toMatchObject({
      deliveryStatus: 'failed',
      deadLetteredAt: h.now(),
      deliveryDeferredAt: h.now(),
      deliveryDeferredReason: 'delivery-failed',
    })
    // Off the pending set is what takes it off the sweep and out of a blocked
    // sender's wait — the row stops pretending to be in flight.
    expect(await h.store.messages.countPending({ kind: 'session', id: TARGET })).toBe(0)

    // AND THE SENDER FINDS OUT, in POD-2297's words rather than a second set:
    // a refused send and an abandoned drain are the same news to whoever is
    // holding the receipt.
    expect(await notices(h)).toHaveLength(1)
    expect((await notices(h))[0]).toContain('failed to hand it to the agent')
  })

  it('dead-letters a session that ended with the teardown wording', async () => {
    const h = await chatHarness(() => refused('session_ended'))
    const id = await chat(h, 'too late')

    await h.settleReceipts()

    expect(await h.svc.message(id)).toMatchObject({
      deliveryStatus: 'failed',
      deliveryDeferredReason: 'teardown',
    })
    expect((await notices(h))[0]).toContain('torn down before it could be typed into')
  })

  it('dead-letters a send whose attachment bytes the machine could not persist', async () => {
    // `staging_failed` is the driver saying the machine, not the session, is the
    // problem: it supports staging and the write failed anyway. A disk that lost
    // the bytes this turn is not talked round by the next sweep tick, so this is
    // terminal and visible rather than a silent re-queue that spins.
    const h = await chatHarness(() => refused('staging_failed', 'ENOSPC'))
    const id = await chat(h, 'here is the screenshot')

    await h.settleReceipts()

    expect(await h.svc.message(id)).toMatchObject({
      deliveryStatus: 'failed',
      deliveryDeferredReason: 'delivery-failed',
    })
    expect((await notices(h))[0]).toContain('failed to hand it to the agent')
  })

  it('tells the sender once when a LATE unsupported refusal answers an attachment send', async () => {
    // WHERE THIS ISSUE AND POD-2574 MEET. That change ends an attachment send the
    // seam refuses synchronously; this one answers the refusals that arrive after
    // the row was already stamped delivered — a driver that takes the turn and
    // then rejects the raw bytes. Both end the row; only one of them has a sender
    // still waiting on a claim that turned out to be false, so only one notifies,
    // and the row is dead-lettered exactly once either way.
    const h = await chatHarness(() => refused('unsupported', 'raw attachments need a first turn'))
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: TARGET,
      body: 'here is the screenshot',
      attachments: [SHOT],
    })) as { id: string }
    expect(await h.svc.message(r.id)).toMatchObject({ deliveryStatus: 'dispatched' })

    await h.settleReceipts()

    expect(await h.svc.message(r.id)).toMatchObject({
      deliveryStatus: 'failed',
      deliveryDeferredReason: 'delivery-failed',
    })
    expect(await transitions(h, 'message.dead_letter', r.id)).toHaveLength(1)
    expect(await notices(h)).toHaveLength(1)
  })

  it('leaves no refusal reason able to strand a dispatched row', async () => {
    // THE GUARD FOR THE NEXT ARM. `staging_failed` was added to the protocol
    // after this table was written, and only the exhaustive Record caught it.
    // This is the runtime half of that: every reason the enum can carry must
    // either fail the row or hand it to the durable queue. `no_resume_ref` is the one
    // documented exception — it is answered synchronously by injectAndMark's own
    // spawn-on-wake branch, which is about to deliver the row this path would
    // otherwise kill. A future arm that belongs in that exception has to be
    // added here deliberately, which is the point.
    const answeredElsewhere: RefusalReason[] = ['no_resume_ref']

    for (const reason of RefusalReason.options) {
      if (answeredElsewhere.includes(reason)) continue
      const h = await chatHarness(() => refused(reason))
      const id = await chat(h, `refuse me as ${reason}`)
      expect(await h.svc.message(id)).toMatchObject({ deliveryStatus: 'dispatched' })
      const before = h.pushes.length

      await h.settleReceipts()

      const after = (await h.svc.message(id))!
      const queued = h.pushes.slice(before).some((p) => p.fn === 'queueText')
      expect(
        after.deliveryStatus === 'failed' || (after.deliveryStatus === 'dispatched' && queued),
        `'${reason}' stranded the row — it must fail or go to the durable queue`,
      ).toBe(true)
    }
  })

  it('keeps the precise refusal on the receipt event, which is why the enum need not grow', async () => {
    const h = await chatHarness(() => refused('not_running', 'ECONNRESET'))
    const id = await chat(h, 'diagnose me')

    await h.settleReceipts()

    // The ledger stamp reuses the three-arm abandonment vocabulary (widening that
    // wire enum is a rolling-upgrade event, POD-2297) and loses nothing: the
    // driver's own word for it rides the receipt event recorded beside it.
    expect((await transitions(h, 'message.receipt', id)).map((e) => e.payload)).toMatchObject([
      { messageId: id, outcome: 'refused', refusedFor: 'not_running', refusalDetail: 'ECONNRESET' },
    ])
    expect(await transitions(h, 'message.dead_letter', id)).toMatchObject([
      { payload: { reason: 'delivery-failed', refusedFor: 'not_running', retryable: false } },
    ])
  })
})

describe('a refusal corrects the push it answers, and nothing else (F3)', () => {
  it('does not walk back a row the transcript echo already confirmed', async () => {
    // Enveloped agent-style mail: an issue-addressed operator body carries an id,
    // so it is INJECTED and still owed an echo — the case where a real
    // confirmation can beat the driver's verdict.
    const h = await mailHarness({ receipts: { defer: true, answer: () => refused('not_running') } })
    const iss = await h.createIssue({ title: 'target' })
    h.put({ sessionId: TARGET, issueId: iss.id, phase: 'idle' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'raced',
    })) as { id: string }

    await h.svc.onTranscriptDelta(TARGET, [{ role: 'user', text: `[podium message ${r.id} · from x]` }])
    expect((await h.svc.message(r.id))!.deliveryStatus).toBe('confirmed')

    await h.settleReceipts()

    // THE AGENT DEMONSTRABLY HAS IT. Its own transcript shows the envelope, and a
    // driver that could not prove what the transcript already showed must not
    // dead-letter it — that would be this issue's defect in the mirror.
    expect((await h.svc.message(r.id))!.deliveryStatus).toBe('confirmed')
    expect(await notices(h)).toEqual([])
  })

  it('makes exactly one transition and one notice when the same refusal repeats', async () => {
    const h = await chatHarness(() => refused('not_running'))
    const id = await chat(h, 'say it once')

    await h.settleReceipts()
    // The write path is at-least-once and its consumer must be idempotent under
    // repeats. Nothing here dedupes by hand: the second verdict finds a row that
    // is no longer resting on the push it answers, and the guarded write is what
    // makes it silent. A sender nagged twice about one message stops trusting the
    // notice.
    await h.replayReceipts()
    await h.replayReceipts()

    expect(await transitions(h, 'message.dead_letter', id)).toHaveLength(1)
    expect(await notices(h)).toHaveLength(1)
  })

  it('hands the row to the queue once when a clearing refusal repeats', async () => {
    const h = await chatHarness(() => refused('busy'))
    const id = await chat(h, 'again, then')

    await h.settleReceipts()
    const afterFirst = h.pushes.length
    await h.replayReceipts()

    expect((await h.svc.message(id))!.deliveryStatus).toBe('dispatched')
    expect(await transitions(h, 'message.requeued', id)).toHaveLength(1)
    expect(h.pushes).toHaveLength(afterFirst)
  })

  it('records a receipt that arrives BEFORE its caller recorded, but does not settle on it', async () => {
    // The durable-queue path answers inside `receiptSend` itself, so its verdict
    // reaches the reconciler while the caller's own `ok: false` — the branch that
    // routes a wake to spawn-on-wake and everything else to the sweep — is still
    // on its way. Correcting there would settle the row against the PREVIOUS
    // push's stamps. `defer: false` is that ordering.
    const h = await mailHarness({
      receipts: { defer: false, answer: () => refused('not_running') },
    })
    const iss = await h.createIssue({ title: 'target' })
    // A `starting` session has no turn in flight and nothing on screen, so a
    // next-turn body rides the durable boot queue rather than being typed.
    h.put({ sessionId: TARGET, issueId: iss.id, status: 'starting' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: TARGET,
      body: 'ride the boot queue',
      urgency: 'next-turn',
    })) as { id: string }
    expect(h.pushes.map((p) => p.fn)).toEqual(['queueText'])

    // The evidence is on the ledger either way — that half is unconditional.
    expect((await transitions(h, 'message.receipt', r.id)).map((e) => e.payload)).toMatchObject([
      { messageId: r.id, outcome: 'refused' },
    ])
    // But the row is where the durable queue put it, still deliverable, because
    // the caller owns a synchronous answer.
    expect((await h.svc.message(r.id))!.deliveryStatus).toBe('dispatched')
    expect(await notices(h)).toEqual([])
  })

  it('ends an attachment send refused before anything was stamped [POD-2574]', async () => {
    // THE ONE SYNCHRONOUS REFUSAL THAT MUST NOT STAY QUEUED. `receiptSend` turns
    // attachments away from inside the call `injectAndMark` is still making, so
    // the latch above correctly declines to correct a row with no stamps on it —
    // and leaving it queued would hand the sweep a row it can only refuse again,
    // for the same reason, forever. `unsupported` is a capability, not a moment.
    const h = await mailHarness({
      receipts: {
        defer: false,
        answer: () => refused('unsupported', 'this agent cannot accept file attachments'),
      },
    })
    const iss = await h.createIssue({ title: 'target' })
    h.put({ sessionId: TARGET, issueId: iss.id, status: 'starting' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: TARGET,
      body: 'here is the screenshot',
      attachments: [SHOT],
      urgency: 'next-turn',
    })) as { id: string }

    expect((await h.svc.message(r.id))!.deliveryStatus).toBe('failed')
    // No steward notice: the sender was already told, synchronously, by the
    // `ok: false` their own send returned. Two notices for one refusal is the
    // same disrespect as none, from the other side.
    expect(await notices(h)).toEqual([])
    // AND IT SAYS WHY [POD-2574]. Asserting the status alone is what let this row
    // reach both readers as an unexplained dead letter, and a null reason falls
    // through to "target gone" — a claim about the SESSION, which is fine and
    // still running. The stamp is what separates "the driver refused" from "the
    // target vanished". The rendered wording is pinned on the web side, in
    // message-ledger.test.ts; what belongs here is that the row carries a cause.
    expect((await h.svc.message(r.id))!.deliveryDeferredReason).toBe('delivery-failed')
    expect((await h.svc.message(r.id))!.deliveryDeferredAt).toBeTruthy()
  })

  it('leaves a synchronous refusal that WILL clear where the durable queue put it', async () => {
    // The companion to the case above, and the reason it is scoped to
    // `unsupported` rather than to refusals in general: `busy` clears on its own,
    // so the sweep is exactly the retry this row wants.
    const h = await mailHarness({
      receipts: { defer: false, answer: () => refused('busy') },
    })
    const iss = await h.createIssue({ title: 'target' })
    h.put({ sessionId: TARGET, issueId: iss.id, status: 'starting' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: TARGET,
      body: 'here is the screenshot',
      attachments: [SHOT],
      urgency: 'next-turn',
    })) as { id: string }

    expect((await h.svc.message(r.id))!.deliveryStatus).toBe('dispatched')
    expect(await notices(h)).toEqual([])
  })

  it('records unverified as unknown — never failed, never a resend (POD-4775)', async () => {
    const h = await chatHarness(() => ({
      outcome: 'unverified',
      deliveredAs: 'when-ready',
      verificationWindowMs: 4000,
      at: '2026-07-20T12:00:00.000Z',
    }))
    const id = await chat(h, 'unproven, not failed')

    await h.settleReceipts()

    // `unverified` means nobody could prove whether the keystrokes landed.
    // Correcting on it would turn the one honest outcome in the contract into a
    // duplicate turn or a false failure. The row says exactly that — `unknown`
    // — and nothing is pushed again and nobody is told it failed.
    expect((await h.svc.message(id))!.deliveryStatus).toBe('unknown')
    expect(h.pushes.map((p) => p.fn)).toEqual(['interruptText'])
    expect(await notices(h)).toEqual([])
    await h.svc.sweep()
    expect(h.pushes).toHaveLength(1)

    // A later settlement still lands on it.
    await h.svc.onQueuedInputApplied(id, TARGET)
    expect((await h.svc.message(id))!.deliveryStatus).toBe('confirmed')
  })
})

const QUEUED: TurnReceipt = {
  outcome: 'queued',
  position: 1,
  deliveredAs: 'queue',
  at: '2026-07-20T12:00:00.000Z',
}

const ACCEPTED: TurnReceipt = {
  outcome: 'accepted',
  turnEpoch: 1,
  deliveredAs: 'when-ready',
  provenBy: 'hook',
  at: '2026-07-20T12:00:00.000Z',
}
