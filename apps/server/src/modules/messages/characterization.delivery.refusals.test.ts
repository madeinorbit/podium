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
 *   - a refusal whose cause CLEARS ON ITS OWN puts the row back in the queue,
 *     un-pushed, and the machinery that was already going to retry it does. This
 *     path pushes nothing itself.
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
 *  UNWRAPPED — no envelope, so no id can ever echo — which is exactly why
 *  `injectAndMark` marks it delivered outright and why a refusal afterwards has
 *  nobody else to correct it. */
const chatHarness = async (answer: () => TurnReceipt, opts?: { defer?: boolean }) => {
  const h = await mailHarness({ receipts: { defer: opts?.defer ?? true, answer } })
  const iss = h.createIssue({ title: 'target' })
  h.put({ sessionId: TARGET, issueId: iss.id, phase: 'idle' })
  return h
}

const chat = async (h: ReturnType<typeof mailHarness>, body: string): Promise<string> => {
  const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', { to: TARGET, body })) as {
    id: string
  }
  return r.id
}

describe('contract-backed blocking sends return receipt refusals (POD-3044)', () => {
  it('waits for a not-running receipt and returns the typed dead letter', async () => {
    let h!: ReturnType<typeof mailHarness>
    h = await mailHarness({
      receipts: { defer: true, answer: () => refused('not_running') },
      runtimeContractActive: () => true,
      awaitPollMs: 1,
      onPoll: (poll) => {
        if (poll === 1) h.settleReceipts()
      },
    })
    const issue = h.createIssue({ title: 'target' })
    h.put({ sessionId: TARGET, issueId: issue.id, phase: 'idle' })

    const result = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: TARGET,
      body: 'anyone there?',
      urgency: 'next-turn',
    })) as { id: string; ok: boolean; reason?: string; disposition: string }

    expect(result).toMatchObject({
      ok: false,
      reason: 'dead-lettered: delivery-failed',
      disposition: 'dead_letter',
    })
    expect(h.svc.message(result.id)).toMatchObject({
      status: 'dead_letter',
      deliveryDeferredReason: 'delivery-failed',
    })
  })
})

/** Every undelivered-notice the sender was actually handed. */
const notices = async (h: ReturnType<typeof mailHarness>): Promise<string[]> =>
  (await h.store.messages.listMessagesFor({ kind: 'operator' }))
    .filter((m) => m.kind === 'notification' && m.fromKind === 'system')
    .map((m) => m.body)

const transitions = (h: ReturnType<typeof mailHarness>, kind: string, id: string) =>
  h.events([kind]).filter((e) => e.subject === id)

describe('a refusal that will clear puts the row back in the queue (F1)', () => {
  it('retracts the optimistic delivery of a chat line the driver refused as busy', async () => {
    const h = await chatHarness(() =>
      refused('busy', 'a turn was still open when the ready window closed'),
    )
    const id = await chat(h, 'are you there?')

    // THE OPTIMISTIC HALF, which is not itself the bug: the bytes are on their
    // way and the operator's bubble says so.
    expect(h.svc.message(id)).toMatchObject({ status: 'delivered', deliveredTo: TARGET })

    h.settleReceipts()

    // THE DEFECT, CLOSED. `busy` means a turn was open — it ends on its own — so
    // the honest correction is to undo the claim and let the row wait its turn.
    // `injectedAt` cleared is what makes the retry machinery see an un-pushed row
    // rather than one still inside its echo window.
    expect(h.svc.message(id)).toMatchObject({
      status: 'queued',
      deliveredAt: null,
      injectedAt: null,
      // The last place it was aimed SURVIVES. It is the only evidence of which
      // session refused, and the sweep re-resolves the target rather than
      // trusting it.
      deliveredTo: TARGET,
    })
    expect(transitions(h, 'message.requeued', id)).toHaveLength(1)
  })

  it('re-queues rather than re-pushing — the retry is the sweep, not this path', async () => {
    let sends = 0
    const h = await chatHarness(() => {
      sends += 1
      return sends === 1 ? refused('needs_user', 'a native prompt is open') : ACCEPTED
    })
    const id = await chat(h, 'answer me when you can')
    const afterSend = h.pushes.length

    h.settleReceipts()
    // NOTHING WAS SENT BY THE CORRECTION ITSELF. A refusal that pushed would be
    // the retry storm the `unverified` policy forbids, wearing a different name.
    expect(h.pushes).toHaveLength(afterSend)

    // The ordinary backstop finds an un-pushed queued row and carries it, which
    // is the whole reason re-queueing is a sufficient answer.
    h.svc.sweep()
    h.settleReceipts()
    expect(h.pushes.length).toBe(afterSend + 1)
    expect(h.svc.message(id)!.status).toBe('delivered')
  })

  it('treats a held control lease the same way — the human lets go eventually', async () => {
    const h = await chatHarness(() => refused('lease_held', 'held by a human-controller'))
    const id = await chat(h, 'when you are free')

    h.settleReceipts()

    expect(h.svc.message(id)!.status).toBe('queued')
    // A re-queue is NOT a dead-letter, so the sender is told nothing: the message
    // is still on its way and a notice would be a lie in the other direction.
    expect(await notices(h)).toEqual([])
  })

  it('clears the read receipt the optimistic delivery recorded', async () => {
    const h = await chatHarness(() => refused('busy'))
    const id = await chat(h, 'unread, actually')

    // `markDelivered` records a per-reader receipt [POD-1379]. Left standing, it
    // says this session saw a message it never got — the same lie one table over,
    // and the one that hides the row from that session's own pending set.
    expect((await h.store.messages.readReceipts(TARGET, [id])).has(id)).toBe(true)

    h.settleReceipts()

    expect((await h.store.messages.readReceipts(TARGET, [id])).has(id)).toBe(false)
  })
})

describe('a refusal that will not clear goes terminal, and says so once (F2)', () => {
  it('dead-letters a chat line the driver refused as not_running, and tells the sender', async () => {
    const h = await chatHarness(() => refused('not_running', 'the daemon dropped the handle'))
    const id = await chat(h, 'anyone home?')
    expect(h.svc.message(id)!.status).toBe('delivered')

    h.settleReceipts()

    // TERMINAL, with the same stamps the drain-abandonment route writes — one
    // undelivered turn reads the same way whichever route reported it.
    expect(h.svc.message(id)).toMatchObject({
      status: 'dead_letter',
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

    h.settleReceipts()

    expect(h.svc.message(id)).toMatchObject({
      status: 'dead_letter',
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

    h.settleReceipts()

    expect(h.svc.message(id)).toMatchObject({
      status: 'dead_letter',
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
    expect(h.svc.message(r.id)).toMatchObject({ status: 'delivered', injectedAt: null })

    h.settleReceipts()

    expect(h.svc.message(r.id)).toMatchObject({
      status: 'dead_letter',
      deliveryDeferredReason: 'delivery-failed',
    })
    expect(transitions(h, 'message.dead_letter', r.id)).toHaveLength(1)
    expect(await notices(h)).toHaveLength(1)
  })

  it('leaves no refusal reason able to keep an optimistic delivery standing', async () => {
    // THE GUARD FOR THE NEXT ARM. `staging_failed` was added to the protocol
    // after this table was written, and only the exhaustive Record caught it.
    // This is the runtime half of that: every reason the enum can carry must
    // move the row OFF optimistic-delivered. `no_resume_ref` is the one
    // documented exception — it is answered synchronously by injectAndMark's own
    // spawn-on-wake branch, which is about to deliver the row this path would
    // otherwise kill. A future arm that belongs in that exception has to be
    // added here deliberately, which is the point.
    const answeredElsewhere: RefusalReason[] = ['no_resume_ref']

    for (const reason of RefusalReason.options) {
      if (answeredElsewhere.includes(reason)) continue
      const h = await chatHarness(() => refused(reason))
      const id = await chat(h, `refuse me as ${reason}`)
      // The optimism this issue is about: delivered before the driver answered.
      expect(h.svc.message(id)).toMatchObject({ status: 'delivered', injectedAt: null })

      h.settleReceipts()

      const after = h.svc.message(id)!
      expect(
        after.status === 'delivered' && after.injectedAt === null,
        `'${reason}' left the row optimistically delivered — it must re-queue or dead-letter`,
      ).toBe(false)
    }
  })

  it('keeps the precise refusal on the receipt event, which is why the enum need not grow', async () => {
    const h = await chatHarness(() => refused('not_running', 'ECONNRESET'))
    const id = await chat(h, 'diagnose me')

    h.settleReceipts()

    // The ledger stamp reuses the three-arm abandonment vocabulary (widening that
    // wire enum is a rolling-upgrade event, POD-2297) and loses nothing: the
    // driver's own word for it rides the receipt event recorded beside it.
    expect(transitions(h, 'message.receipt', id).map((e) => e.payload)).toMatchObject([
      { messageId: id, outcome: 'refused', refusedFor: 'not_running', refusalDetail: 'ECONNRESET' },
    ])
    expect(transitions(h, 'message.dead_letter', id)).toMatchObject([
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
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: TARGET, issueId: iss.id, phase: 'idle' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'raced',
    })) as { id: string }

    h.svc.onTranscriptDelta(TARGET, [{ role: 'user', text: `[podium message ${r.id} · from x]` }])
    expect(h.svc.message(r.id)!.status).toBe('delivered')

    h.settleReceipts()

    // THE AGENT DEMONSTRABLY HAS IT. Its own transcript shows the envelope, and a
    // driver that could not prove what the transcript already showed must not
    // dead-letter it — that would be this issue's defect in the mirror.
    expect(h.svc.message(r.id)!.status).toBe('delivered')
    expect(await notices(h)).toEqual([])
  })

  it('makes exactly one transition and one notice when the same refusal repeats', async () => {
    const h = await chatHarness(() => refused('not_running'))
    const id = await chat(h, 'say it once')

    h.settleReceipts()
    // The write path is at-least-once and its consumer must be idempotent under
    // repeats. Nothing here dedupes by hand: the second verdict finds a row that
    // is no longer resting on the push it answers, and the guarded write is what
    // makes it silent. A sender nagged twice about one message stops trusting the
    // notice.
    h.replayReceipts()
    h.replayReceipts()

    expect(transitions(h, 'message.dead_letter', id)).toHaveLength(1)
    expect(await notices(h)).toHaveLength(1)
  })

  it('makes exactly one re-queue when a clearing refusal repeats', async () => {
    const h = await chatHarness(() => refused('busy'))
    const id = await chat(h, 'again, then')

    h.settleReceipts()
    h.replayReceipts()

    expect(h.svc.message(id)!.status).toBe('queued')
    expect(transitions(h, 'message.requeued', id)).toHaveLength(1)
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
    const iss = h.createIssue({ title: 'target' })
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
    expect(transitions(h, 'message.receipt', r.id).map((e) => e.payload)).toMatchObject([
      { messageId: r.id, outcome: 'refused' },
    ])
    // But the row is where the durable queue put it, still deliverable, because
    // the caller owns a synchronous answer.
    expect(h.svc.message(r.id)!.status).toBe('queued')
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
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: TARGET, issueId: iss.id, status: 'starting' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: TARGET,
      body: 'here is the screenshot',
      attachments: [SHOT],
      urgency: 'next-turn',
    })) as { id: string }

    expect(h.svc.message(r.id)!.status).toBe('dead_letter')
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
    expect(h.svc.message(r.id)!.deliveryDeferredReason).toBe('delivery-failed')
    expect(h.svc.message(r.id)!.deliveryDeferredAt).toBeTruthy()
  })

  it('leaves a synchronous refusal that WILL clear where the durable queue put it', async () => {
    // The companion to the case above, and the reason it is scoped to
    // `unsupported` rather than to refusals in general: `busy` clears on its own,
    // so the sweep is exactly the retry this row wants.
    const h = await mailHarness({
      receipts: { defer: false, answer: () => refused('busy') },
    })
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: TARGET, issueId: iss.id, status: 'starting' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: TARGET,
      body: 'here is the screenshot',
      attachments: [SHOT],
      urgency: 'next-turn',
    })) as { id: string }

    expect(h.svc.message(r.id)!.status).toBe('queued')
    expect(await notices(h)).toEqual([])
  })

  it('still does nothing at all for unverified — the policy the sibling file pins', async () => {
    const h = await chatHarness(() => ({
      outcome: 'unverified',
      deliveredAs: 'when-ready',
      verificationWindowMs: 4000,
      at: '2026-07-20T12:00:00.000Z',
    }))
    const id = await chat(h, 'unproven, not failed')

    h.settleReceipts()

    // `unverified` means the keystrokes WERE delivered and acceptance could not be
    // proven. Correcting on it would turn the one honest outcome in the contract
    // into a duplicate turn — the exact reading this issue must not widen into.
    expect(h.svc.message(id)!.status).toBe('delivered')
    expect(await notices(h)).toEqual([])
  })
})

const ACCEPTED: TurnReceipt = {
  outcome: 'accepted',
  turnEpoch: 1,
  deliveredAs: 'when-ready',
  provenBy: 'hook',
  at: '2026-07-20T12:00:00.000Z',
}
