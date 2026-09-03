/**
 * THE PROTOCOL-ASK ROUND TRIP, ON THE SERVER SIDE (POD-1761 W5; POD-2023 review,
 * finding 2).
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS UNTESTED, AND WHY IT MATTERED
 * ---------------------------------------------------------------------------
 *
 * W5's headline claim is "permission/question events → W2 PendingInteractions
 * answered via REST". The DRIVER half is covered by the conformance corpus
 * against a real listener. The SERVER half — the seam W2 declared and W5 filled —
 * had no test at any level: `deliverStructured` and the `structuredDelivery`
 * capability appeared in zero test files, and the live e2e deliberately does not
 * answer anything. So the composition surface → `InteractionService.answer` →
 * the runtime gateway → the daemon → the driver → `POST /permission/{id}/reply`
 * had never executed, anywhere, ever.
 *
 * This is a SEAM test rather than another live lane, and deliberately so: what
 * was unproven is the WIRING — that an ask carries the driver's own identity into
 * the aggregate, that a structured ask stops being refused once a route exists,
 * and that the answer leaves through the structured door instead of being typed
 * at a terminal the session does not have. None of that needs a model.
 */

import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import type { InteractionAnswer, PendingInteraction } from '@podium/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBunStoreExecutor } from '../../store/executor'
import { InteractionsRepository } from '../../store/interactions'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { SYSTEM_INBOX_PRINCIPAL } from '../sessions/inbox'
import { InteractionService, unsupportedAnswerReason } from './service'

const SESSION = asSessionId('44444444-4444-4444-8444-444444444444')

/** The ask an opencode session's driver produces: its OWN request id, protocol
 *  source, structured answerability. Exactly what `runtimeInteractionAsked`
 *  carries. */
const protocolAsk = (id = 'per_live_1'): PendingInteraction & { sessionId: SessionId } => ({
  id,
  sessionId: SESSION,
  kind: 'permission',
  payload: { v: 1, toolName: 'bash', inputSummary: 'echo hello', canAlwaysAllow: true },
  askedAt: '2026-08-14T00:00:00.000Z',
  source: 'protocol',
  answerable: 'structured',
})

interface Harness {
  service: InteractionService
  delivered: { sessionId: SessionId; interactionId: string; answer: InteractionAnswer }[]
  keystrokes: { sessionId: SessionId; answer: string }[]
  published: string[]
}

function harness(
  opts: {
    structured?: boolean
    structuredFails?: boolean
    /** The driver's typed refusal, when the test is about which one it is. */
    refusal?: 'already-answered' | 'expired' | 'unknown-interaction' | 'not-yet-supported'
  } = {},
): Harness {
  const delivered: Harness['delivered'] = []
  const keystrokes: Harness['keystrokes'] = []
  const published: string[] = []
  const service = new InteractionService({
    // A REAL migrated database, like every sibling suite: the aggregate's
    // idempotence comes from the row's own `status = 'asked'` guard, and a fake
    // store would prove the test's guard rather than the aggregate's.
    store: new InteractionsRepository(
      createBunStoreExecutor({ database: openMigratedTestDatabase() }),
    ),
    now: () => '2026-08-14T00:00:01.000Z',
    publish: (row) => published.push(row.id),
    deliver: async (input) => {
      keystrokes.push({ sessionId: input.sessionId, answer: input.answer })
      // `choices` is REQUIRED on the menu arm of `AnswerDeliveryResult` — it is
      // what the digit path actually pressed, and the audit trail reads it. An
      // earlier version of this fake omitted it and took the epic's whole-graph
      // typecheck red (caught by POD-2059's review); a per-package run had gone
      // green because the fake's inferred type only meets the real one at this
      // seam.
      return { ok: true, via: 'menu', choices: [] }
    },
    readTranscript: async () => ({ items: [] }),
    policyPrincipal: () => SYSTEM_INBOX_PRINCIPAL,
    ...(opts.structured === false
      ? {}
      : {
          deliverStructured: async (input) => {
            delivered.push(input)
            if (opts.refusal) return { ok: false as const, reason: opts.refusal }
            return opts.structuredFails
              ? { ok: false as const, reason: 'delivery-failed' as const, detail: 'socket closed' }
              : { ok: true as const }
          },
        }),
  })
  return { service, delivered, keystrokes, published }
}

describe('a protocol ask entering the aggregate', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it("keeps the DRIVER's own id, source and answerability", async () => {
    const { row, inserted } = await h.service.ask({ interaction: protocolAsk() })
    expect(inserted).toBe(true)
    /**
     * THE THREE FIELDS THE WIRING COMMENTS PROMISE ARE "CARRIED RATHER THAN
     * RE-DERIVED", asserted rather than promised.
     *
     * The id in particular: it is opencode's `per_…`, which is the handle the
     * driver must reply against. An aggregate that minted its own would need a
     * private map from ours to theirs whose only failure mode is losing an entry
     * and stranding a blocked session.
     */
    expect(row.id).toBe('per_live_1')
    expect(row.source).toBe('protocol')
    expect(row.answerable).toBe('structured')
    expect(row.status).toBe('asked')
    expect(h.published).toContain('per_live_1')
  })

  it('does NOT fingerprint-merge two distinct asks that look alike', async () => {
    // A classifier-sourced ask has no identity of its own, so the aggregate
    // collapses look-alikes. A protocol ask HAS one, and merging two real asks
    // because their text matched would lose one of them permanently.
    await h.service.ask({ interaction: protocolAsk('per_a') })
    await h.service.ask({ interaction: protocolAsk('per_b') })
    expect(
      h.service
        .listOpen(SESSION)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['per_a', 'per_b'])
  })
})

describe('answering a structured ask', () => {
  it('LEAVES THROUGH THE STRUCTURED DOOR, never the keystroke one', async () => {
    const h = harness()
    await h.service.ask({ interaction: protocolAsk() })
    const outcome = await h.service.answer({
      id: 'per_live_1',
      answer: { kind: 'permission', decision: 'allow-once' },
      answeredBy: 'human',
      principal: SYSTEM_INBOX_PRINCIPAL,
    })
    expect(outcome.ok).toBe(true)
    // The whole point: this session has no PTY. Typing digits at it would be
    // answering a menu that does not exist, and `deliverAnswerToSession` would
    // have had nowhere to send them.
    expect(h.keystrokes).toHaveLength(0)
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]?.interactionId).toBe('per_live_1')
    expect(h.delivered[0]?.answer).toEqual({ kind: 'permission', decision: 'allow-once' })
    // …and the row records HOW it was delivered, which is the audit trail a
    // headless run is judged on.
    expect(h.service.get('per_live_1')?.deliveredVia).toBe('structured')
    expect(h.service.get('per_live_1')?.status).toBe('answered')
  })

  it('is REFUSED when no structured route is wired, with the true reason', async () => {
    const h = harness({ structured: false })
    await h.service.ask({ interaction: protocolAsk() })
    const outcome = await h.service.answer({
      id: 'per_live_1',
      answer: { kind: 'permission', decision: 'allow-once' },
      answeredBy: 'human',
      principal: SYSTEM_INBOX_PRINCIPAL,
    })
    // W2's blanket "structured answering needs a protocol driver" is gone — W5
    // shipped one. What remains is a refusal for a BUILD with no route to it,
    // which is a different and true statement.
    expect(outcome).toMatchObject({ ok: false, reason: 'not-yet-supported' })
    expect(h.keystrokes).toHaveLength(0)
    // The ask stays OPEN, which is what keeps the session visibly blocked
    // instead of falsely resolved.
    expect(h.service.get('per_live_1')?.status).toBe('asked')
  })

  it('hands a delivery-failed ask BACK, and does not fall back to keystrokes', async () => {
    const h = harness({ structuredFails: true })
    await h.service.ask({ interaction: protocolAsk() })
    const outcome = await h.service.answer({
      id: 'per_live_1',
      answer: { kind: 'permission', decision: 'deny' },
      answeredBy: 'human',
      principal: SYSTEM_INBOX_PRINCIPAL,
    })
    // REVERSED DELIBERATELY (POD-2414 re-verdict, P0/1). This pin used to
    // require `ok: true` with the row left answered/unverified. That reading is
    // the opposite of the contract it pins: `InteractionAnswerOutcome` says of
    // `delivery-failed` that "the capability is there and the REPLY failed to
    // reach the provider — a retry is exactly the right response. The ask stays
    // OPEN either way, which is what keeps a session visibly blocked instead of
    // falsely resolved." opencode, its first producer, likewise leaves the
    // request in its own interaction map when the REST reply throws.
    //
    // Resolving it instead removed the only surface a still-blocked
    // server-family session had — the exact bug this aggregate exists to
    // prevent, committed by the aggregate. Note the sibling test above already
    // holds this line for `not-yet-supported`; the two reasons differ in whether
    // a RETRY is worth it, not in whether the ask survives.
    expect(outcome).toMatchObject({ ok: false, reason: 'delivery-failed' })
    expect(h.service.get('per_live_1')?.status).toBe('asked')
    // NEVER a keystroke fallback: a session with no terminal cannot be typed at,
    // and degrading to it would report an answer that reached nothing.
    expect(h.keystrokes).toHaveLength(0)
  })

  /**
   * THE REFUSAL TABLE, ARM BY ARM (POD-2414 re-verdict, P0/1).
   *
   * These reasons are not degrees of confidence in one outcome — they are
   * different facts, and collapsing them to a boolean got the two dangerous
   * cases backwards at once. One test per arm so a future collapse cannot pass.
   */
  it('retires the row when the driver says the request is already answered', async () => {
    const h = harness({ refusal: 'already-answered' })
    await h.service.ask({ interaction: protocolAsk() })
    const outcome = await h.service.answer({
      id: 'per_live_1',
      answer: { kind: 'permission', decision: 'allow-once' },
      answeredBy: 'human',
      principal: SYSTEM_INBOX_PRINCIPAL,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'already-answered' })
    // SUPERSEDED, not expired: somebody reached it first, which is a different
    // fact from the session ending underneath it — and the one the operator
    // needs, because their answer was late rather than wasted.
    expect(h.service.get('per_live_1')?.status).toBe('superseded')
  })

  it('retires the row as expired when the driver says the request expired', async () => {
    const h = harness({ refusal: 'expired' })
    await h.service.ask({ interaction: protocolAsk() })
    const outcome = await h.service.answer({
      id: 'per_live_1',
      answer: { kind: 'permission', decision: 'allow-once' },
      answeredBy: 'human',
      principal: SYSTEM_INBOX_PRINCIPAL,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'expired' })
    expect(h.service.get('per_live_1')?.status).toBe('expired')
  })

  it('does NOT manufacture an open ask from unknown-interaction', async () => {
    const h = harness({ refusal: 'unknown-interaction' })
    await h.service.ask({ interaction: protocolAsk() })
    const outcome = await h.service.answer({
      id: 'per_live_1',
      answer: { kind: 'permission', decision: 'allow-once' },
      answeredBy: 'human',
      principal: SYSTEM_INBOX_PRINCIPAL,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'unknown-interaction' })
    // THE ROW STAYS CLAIMED. The driver does not have the request, which is
    // equally consistent with never having had it and with having retired it a
    // moment ago. Reopening on that can resurrect a card after a session exit
    // has already failed to close its answered form — a permanently open ask
    // with nothing able to accept it. Answered/unverified is the one statement
    // true either way.
    expect(h.service.get('per_live_1')?.status).toBe('answered')
    expect(h.service.get('per_live_1')?.deliveredVia).toBe('unverified')
  })

  it('is idempotent — a second answer is refused, not re-delivered', async () => {
    const h = harness()
    await h.service.ask({ interaction: protocolAsk() })
    const input = {
      id: 'per_live_1',
      answer: { kind: 'permission', decision: 'allow-once' } as InteractionAnswer,
      answeredBy: 'human' as const,
      principal: SYSTEM_INBOX_PRINCIPAL,
    }
    expect((await h.service.answer(input)).ok).toBe(true)
    expect(await h.service.answer(input)).toMatchObject({ ok: false, reason: 'already-answered' })
    // One decision, one REST reply. A second would answer a request opencode has
    // already closed.
    expect(h.delivered).toHaveLength(1)
  })
})

describe('the refusal predicate', () => {
  it('refuses a structured ask only where nothing can deliver one', () => {
    const row = { kind: 'permission', answerable: 'structured' } as const
    expect(unsupportedAnswerReason(row, { structuredDelivery: true })).toBeNull()
    expect(unsupportedAnswerReason(row, { structuredDelivery: false })).toContain(
      'no structured delivery route',
    )
  })

  it('still refuses a keystroke-emulated PERMISSION, which POD-707 never shipped', () => {
    // Unchanged by W5, and it must stay that way: the native menu's ordinals vary
    // per ask, so a denial can approve. A structured route for opencode does not
    // make a terminal menu safe to type at.
    expect(
      unsupportedAnswerReason(
        { kind: 'permission', answerable: 'keystroke-emulated' },
        { structuredDelivery: true },
      ),
    ).toContain('POD-707')
  })
})
