/**
 * POD-371: ordering partitions under multi-user, D10's retry and age limits, and
 * D11's dedupe horizon.
 *
 * Structured around this issue's acceptance criteria rather than around the API,
 * and every test delivers the thing it is named after: the blocked-partition
 * tests contain an aggregate that COULD have been blocked and is not, the
 * long-offline tests genuinely advance forty days over a durable store and reopen
 * it, and the watermark test drives the REAL Replica with the outbox wired as its
 * overlay, positive control first.
 *
 * The suite POD-370 left (`outbox.test.ts`) covers the D9 lifecycle and the D12
 * single-principal partition rules. What is new here is everything that only
 * exists once there are two principals against one authority, a clock that
 * matters, and a receipt horizon on the other side of the wire.
 */

import { actorUser, asSessionId, asUserId, type MutationId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { InMemoryReplicaStore } from '../replica/memory-store'
import type { OptimisticOverlayPort } from '../replica/overlay'
import { Replica } from '../replica/replica'
import {
  cursorAt,
  deltaFrame,
  FakeAuthority,
  upsertChange,
  watermark,
} from '../replica/test-support'
import {
  backoffDelayMs,
  failureClassOf,
  isDefinitiveFailure,
  OUTBOX_MAX_AGE_MS,
  OutboxAgeOverrideError,
  resolveMaxAgeMs,
  SKEW_MARGIN_MS,
  TRANSIENT_BACKOFF,
} from './limits'
import { type EnqueueRequest, Outbox } from './outbox'
import type { OutboxEvent, OutboxSubmitOutcome } from './ports'
import type { AuthorityRefusal } from './reasons'
import type { OutboxAttribution, OutboxCommand, OutboxRecord } from './records'
import { agentActorOfSession } from './records'
import {
  InMemoryOutboxStore,
  ManualClock,
  ScriptedAuthority,
  sequentialMutationIds,
} from './test-doubles'

const DAY = 24 * 60 * 60 * 1000

const CLOSE: OutboxCommand = { name: 'issues.close', version: 1, delivery: 'offline-eligible' }
const LOCK: OutboxCommand = { name: 'locks.acquire', version: 1, delivery: 'offline-eligible' }

const ADA: OutboxAttribution = {
  actor: actorUser(asUserId('u-ada')),
  onBehalfOf: asUserId('u-ada'),
}
const GRACE: OutboxAttribution = {
  actor: actorUser(asUserId('u-grace')),
  onBehalfOf: asUserId('u-grace'),
}
/** An agent acting for Ada — the delegated case (readiness §3.1.3 A3). */
const ADAS_AGENT: OutboxAttribution = {
  actor: agentActorOfSession(asSessionId('sess-7')),
  onBehalfOf: asUserId('u-ada'),
}

const applied: OutboxSubmitOutcome = { kind: 'applied' }
const accepted: OutboxSubmitOutcome = { kind: 'accepted' }
const unreachable: OutboxSubmitOutcome = { kind: 'unreachable' }
const denied: OutboxSubmitOutcome = { kind: 'rejected', refusal: { kind: 'unauthorized' } }
const notFound: OutboxSubmitOutcome = { kind: 'rejected', refusal: { kind: 'target-not-found' } }
const poison: OutboxSubmitOutcome = {
  kind: 'rejected',
  refusal: { kind: 'invalid', details: ['input.comment'] },
}

type Responder = (
  envelope: { readonly mutationId: MutationId; readonly input: unknown },
  attempt: number,
) => OutboxSubmitOutcome | Promise<OutboxSubmitOutcome>

interface Harness {
  readonly outbox: Outbox
  readonly store: InMemoryOutboxStore
  readonly authority: ScriptedAuthority
  readonly clock: ManualClock
  readonly events: OutboxEvent[]
}

async function harness(
  respond: Responder = () => applied,
  init: {
    store?: InMemoryOutboxStore
    clock?: ManualClock
    authority?: ScriptedAuthority
    principal?: string
    idPrefix?: string
    maxAgeMs?: number
    commandMaxAgeMs?: Readonly<Record<string, number>>
  } = {},
): Promise<Harness> {
  const store = init.store ?? new InMemoryOutboxStore()
  const clock = init.clock ?? new ManualClock()
  const authority = init.authority ?? new ScriptedAuthority(respond)
  const events: OutboxEvent[] = []
  const outbox = await Outbox.open({
    store,
    submit: authority,
    principal: init.principal ?? 'u-ada',
    now: clock.now,
    maxAgeMs: init.maxAgeMs ?? OUTBOX_MAX_AGE_MS,
    ...(init.commandMaxAgeMs ? { commandMaxAgeMs: init.commandMaxAgeMs } : {}),
    newMutationId: sequentialMutationIds(init.idPrefix ?? 'm'),
    onStoreUnreadable: (error) => {
      throw error
    },
    onEvent: (event) => events.push(event),
  })
  outbox.subscribe((event) => events.push(event))
  return { outbox, store, authority, clock, events }
}

const close = (issue: string, extra: Partial<EnqueueRequest> = {}): EnqueueRequest => ({
  command: CLOSE,
  input: { issueId: issue, comment: `closing ${issue}` },
  attribution: ADA,
  partitionKey: `issue:${issue}`,
  ...extra,
})

const stateOf = (outbox: Outbox, id: MutationId): string | undefined => outbox.find(id)?.state

// ───────────────────────────────────────────────────────────────────────────────
describe('D12 — a blocked aggregate never stalls another, and never stalls another PRINCIPAL', () => {
  it('drains every other aggregate past an entry the authority has accepted but not applied', async () => {
    // `accepted` is the blocking state that is nobody's fault: the Authority has
    // the envelope and has not applied it, so FIFO forbids sending anything behind
    // it in THAT partition and requires sending everything in the others.
    const { outbox, authority } = await harness((envelope) =>
      (envelope.input as { issueId: string }).issueId === 'BLOCKED' ? accepted : applied,
    )
    const head = await outbox.enqueue(close('BLOCKED'))
    const behind = await outbox.enqueue(close('BLOCKED'))
    const other = await outbox.enqueue(close('OTHER'))
    const third = await outbox.enqueue(close('THIRD'))

    await outbox.drain()

    expect(stateOf(outbox, head.mutationId)).toBe('accepted')
    // The counterfactual this test needs: `behind` sits in the blocked partition
    // and is held, while `other` and `third` — which could equally have been held
    // by a global queue — went through.
    expect(stateOf(outbox, behind.mutationId)).toBe('queued')
    expect(authority.attempts(behind.mutationId)).toBe(0)
    expect(stateOf(outbox, other.mutationId)).toBe('applied')
    expect(stateOf(outbox, third.mutationId)).toBe('applied')
  })

  it("keeps a second principal's unrelated aggregates draining while the first is blocked", async () => {
    // Multi-user's new hazard: an aggregate is now something several people may
    // write, so a wedged partition can hurt somebody who did not create the wedge.
    // One physical store, one authority, two principal-bound instances.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const authority = new ScriptedAuthority((envelope) =>
      (envelope.input as { issueId: string }).issueId === 'BLOCKED' ? accepted : applied,
    )
    const ada = await harness(() => applied, { store, clock, authority, idPrefix: 'a' })
    const grace = await harness(() => applied, {
      store,
      clock,
      authority,
      principal: 'u-grace',
      idPrefix: 'g',
    })

    const adaBlocked = await ada.outbox.enqueue(close('BLOCKED'))
    const adaBehind = await ada.outbox.enqueue(close('BLOCKED'))
    const adaOther = await ada.outbox.enqueue(close('OTHER'))
    const graceWrite = await grace.outbox.enqueue(
      close('GRACE-1', { attribution: GRACE, partitionKey: 'issue:GRACE-1' }),
    )
    // Grace also writes to the aggregate Ada has blocked. Her entry is in the same
    // PARTITION KEY but a different instance, so what must hold is FIFO per
    // aggregate per queue — not that Grace inherits Ada's block on her other work.
    const graceShared = await grace.outbox.enqueue(
      close('BLOCKED', { attribution: GRACE, partitionKey: 'issue:BLOCKED' }),
    )

    await Promise.all([ada.outbox.drain(), grace.outbox.drain()])

    expect(stateOf(ada.outbox, adaBlocked.mutationId)).toBe('accepted')
    expect(stateOf(ada.outbox, adaBehind.mutationId)).toBe('queued')
    expect(stateOf(ada.outbox, adaOther.mutationId)).toBe('applied')
    // Grace's unrelated aggregate drained past somebody else's block.
    expect(stateOf(grace.outbox, graceWrite.mutationId)).toBe('applied')
    // And her own entry for the contended aggregate was attempted on its own
    // merits: the Authority accepted it too. What must NOT happen is Ada's
    // in-flight entry silencing Grace's queue.
    expect(stateOf(grace.outbox, graceShared.mutationId)).toBe('accepted')
  })

  it('keeps a delegated agent draining while its human has a blocked aggregate', async () => {
    // One human, two actors: Ada and her agent share the on-behalf-of principal,
    // so they share an outbox — and the agent's unrelated work must still move.
    const { outbox } = await harness((envelope) =>
      (envelope.input as { issueId: string }).issueId === 'BLOCKED' ? accepted : applied,
    )
    const blocked = await outbox.enqueue(close('BLOCKED'))
    const agentWork = await outbox.enqueue(close('AGENT-1', { attribution: ADAS_AGENT }))

    await outbox.drain()

    expect(stateOf(outbox, blocked.mutationId)).toBe('accepted')
    expect(stateOf(outbox, agentWork.mutationId)).toBe('applied')
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D10 — an entry that can never succeed dead-letters without wedging its partition', () => {
  it('dead-letters an AUTHORIZATION denial on the first attempt, burning no retries and no age', async () => {
    // The multi-user case: a share was revoked, and D8 resolves the delegation
    // chain LIVE, so the denial is permanent. Retrying it would hold the head of
    // this partition for fourteen days and then expire it with the wrong reason.
    const { outbox, authority, clock } = await harness((envelope) =>
      (envelope.input as { issueId: string }).issueId === 'REVOKED' ? denied : applied,
    )
    const head = await outbox.enqueue(close('REVOKED'))
    const behind = await outbox.enqueue(close('REVOKED'))
    const elsewhere = await outbox.enqueue(close('ELSEWHERE'))

    await outbox.drain()
    // Zero automatic retries (D10), and the record still has thirteen-plus days of
    // life left — the age limit was not spent on an attempt that cannot succeed.
    expect(authority.attempts(head.mutationId)).toBe(1)
    expect(stateOf(outbox, head.mutationId)).toBe('dead-letter')
    expect(outbox.deadLetters()[0]?.reason).toEqual({ code: 'unauthorized' })
    expect(outbox.deadLetters()[0]?.recovery.retry).toBe('rights-fix')
    expect(clock.now() - head.queuedAt).toBeLessThan(OUTBOX_MAX_AGE_MS)
    // Its partition is held (D12) — but by a RESOLVED entry with a user
    // affordance, not by an entry still trying.
    expect(stateOf(outbox, behind.mutationId)).toBe('queued')
    expect(stateOf(outbox, elsewhere.mutationId)).toBe('applied')

    // And the wedge is undone by the user action D9 invariant 3 offers, with no
    // further drains needed to notice it.
    await outbox.discard(head.mutationId)
    await outbox.drain()
    expect(stateOf(outbox, behind.mutationId)).toBe('dead-letter')
    expect(outbox.deadLetters().map((d) => d.reason.code)).toEqual(['unauthorized'])
  })

  it('dead-letters VALIDATION POISON the same way, and never retries it', async () => {
    const { outbox, authority } = await harness((envelope) =>
      (envelope.input as { issueId: string }).issueId === 'POISON' ? poison : applied,
    )
    const bad = await outbox.enqueue(close('POISON'))
    const good = await outbox.enqueue(close('FINE'))

    await outbox.drain()
    await outbox.drain()
    await outbox.drain()

    expect(authority.attempts(bad.mutationId)).toBe(1)
    expect(stateOf(outbox, bad.mutationId)).toBe('dead-letter')
    const [parked] = outbox.deadLetters()
    // Nothing can make this input succeed; only an edit can.
    expect(parked?.recovery.retry).toBe('never')
    expect(parked?.recovery.edit).toBe(true)
    // Details survive for `invalid` alone — they are paths in the author's OWN
    // input, so they disclose nothing about the target.
    expect(parked?.reason).toEqual({ code: 'invalid', details: ['input.comment'] })
    expect(stateOf(outbox, good.mutationId)).toBe('applied')
  })

  it('classifies every authority refusal as DEFINITIVE and only transport as transient', () => {
    // The classifier is the code the drain branches on, so this table is not a
    // restatement of it — it is the enumeration D10 asks for, including the arm
    // multi-user adds (`unauthorized`, permanent because D8 resolves live).
    const refusals: AuthorityRefusal[] = [
      { kind: 'unauthorized' },
      { kind: 'target-not-found' },
      { kind: 'conflict' },
      { kind: 'invalid' },
      { kind: 'confirmation-required' },
    ]
    for (const refusal of refusals) {
      const outcome: OutboxSubmitOutcome = { kind: 'rejected', refusal }
      expect(failureClassOf(outcome)).toBe('definitive')
      expect(isDefinitiveFailure(outcome)).toBe(true)
    }
    // It can say the other thing too, which is what makes the answers above mean
    // something.
    expect(failureClassOf(unreachable)).toBe('transient')
    expect(isDefinitiveFailure(unreachable)).toBe(false)
    expect(failureClassOf(applied)).toBe('progress')
    expect(failureClassOf(accepted)).toBe('progress')
  })

  it.each([
    ['unauthorized', { kind: 'unauthorized' } as AuthorityRefusal],
    ['target-not-found', { kind: 'target-not-found' } as AuthorityRefusal],
    ['conflict', { kind: 'conflict' } as AuthorityRefusal],
    ['invalid', { kind: 'invalid' } as AuthorityRefusal],
    ['confirmation-required', { kind: 'confirmation-required' } as AuthorityRefusal],
  ])('drains a %s refusal to dead-letter in ONE attempt', async (_name, refusal) => {
    const { outbox, authority, clock } = await harness(() => ({ kind: 'rejected', refusal }))
    const record = await outbox.enqueue(close('POD-1'))

    await outbox.drain()
    clock.advance(60_000)
    await outbox.drain()

    expect(authority.attempts(record.mutationId)).toBe(1)
    expect(stateOf(outbox, record.mutationId)).toBe('dead-letter')
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D10 — transient backoff: exponential, capped, and with no attempt ceiling', () => {
  it('spaces attempts 1s, 2s, 4s … capped at 60s', () => {
    expect(backoffDelayMs(0)).toBe(0)
    expect(backoffDelayMs(1)).toBe(1_000)
    expect(backoffDelayMs(2)).toBe(2_000)
    expect(backoffDelayMs(3)).toBe(4_000)
    expect(backoffDelayMs(4)).toBe(8_000)
    expect(backoffDelayMs(7)).toBe(60_000)
    // The clamp is on the GROWTH, not on the attempt count — including the arm
    // where the exponential overflows to Infinity.
    expect(backoffDelayMs(1_000)).toBe(60_000)
    expect(TRANSIENT_BACKOFF).toEqual({ startMs: 1_000, factor: 2, capMs: 60_000 })
  })

  it('will not re-attempt before the delay has elapsed, and does the moment it has', async () => {
    const { outbox, authority, clock } = await harness(() => unreachable)
    const record = await outbox.enqueue(close('POD-1'))

    await outbox.drain()
    expect(authority.attempts(record.mutationId)).toBe(1)
    expect(outbox.find(record.mutationId)?.nextAttemptAt).toBe(clock.now() + 1_000)

    clock.advance(999)
    await outbox.drain()
    expect(authority.attempts(record.mutationId)).toBe(1) // still spaced out
    clock.advance(1)
    await outbox.drain()
    expect(authority.attempts(record.mutationId)).toBe(2)
    // The second failure doubles it.
    expect(outbox.find(record.mutationId)?.nextAttemptAt).toBe(clock.now() + 2_000)
  })

  it('holds only its OWN partition while backing off', async () => {
    const { outbox, clock } = await harness((envelope) =>
      (envelope.input as { issueId: string }).issueId === 'FLAKY' ? unreachable : applied,
    )
    const flaky = await outbox.enqueue(close('FLAKY'))
    await outbox.drain()
    expect(stateOf(outbox, flaky.mutationId)).toBe('queued')

    // Enqueued DURING the backoff window, into another aggregate: it must go now,
    // not when the unrelated flaky partition next becomes due.
    const other = await outbox.enqueue(close('OTHER'))
    clock.advance(10)
    await outbox.drain()

    expect(stateOf(outbox, other.mutationId)).toBe('applied')
    expect(stateOf(outbox, flaky.mutationId)).toBe('queued')
  })

  it('retries without any ceiling until the age limit — 200 failures, then it applies', async () => {
    const { outbox, authority, clock } = await harness(() => unreachable)
    const record = await outbox.enqueue(close('POD-1'))

    for (let i = 0; i < 200; i += 1) {
      await outbox.drain()
      clock.advance(60_000)
    }
    // No global attempt ceiling: D10 forbids one, because a ceiling turns user
    // work into silent failure. Still queued, still recoverable, still nobody's
    // dead letter.
    expect(authority.attempts(record.mutationId)).toBe(200)
    expect(stateOf(outbox, record.mutationId)).toBe('queued')
    expect(outbox.deadLetters()).toEqual([])
    // Well inside the horizon: 200 minutes against fourteen days.
    expect(clock.now() - record.queuedAt).toBeLessThan(OUTBOX_MAX_AGE_MS)

    authority.reprogram(() => applied)
    await outbox.drain()
    expect(stateOf(outbox, record.mutationId)).toBe('applied')
    // The same id throughout, so the receipt dedupes every replay (D11.7).
    expect(new Set(authority.envelopes.map((e) => e.mutationId)).size).toBe(1)
  })

  it('expires instead of sleeping when the backoff would outlive the horizon', async () => {
    const { outbox, authority, clock } = await harness(() => unreachable)
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()
    expect(outbox.find(record.mutationId)?.nextAttemptAt).toBeGreaterThan(clock.now())

    // The age check runs BEFORE the due check, so a pending backoff cannot carry an
    // entry past its horizon unnoticed.
    clock.advance(OUTBOX_MAX_AGE_MS + 1)
    await outbox.drain()

    expect(stateOf(outbox, record.mutationId)).toBe('dead-letter')
    expect(outbox.deadLetters()[0]?.reason).toEqual({ code: 'max-age' })
    // And nothing was sent on that pass: expiry is how the aged send is REFUSED.
    expect(authority.attempts(record.mutationId)).toBe(1)
  })

  it('keeps the backoff schedule across a restart, so a crash loop cannot reset the spacing', async () => {
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const first = await harness(() => unreachable, { store, clock })
    const record = await first.outbox.enqueue(close('POD-1'))
    await first.outbox.drain()
    const scheduled = first.outbox.find(record.mutationId)?.nextAttemptAt

    const reopened = await harness(() => applied, { store, clock })
    expect(reopened.outbox.find(record.mutationId)?.nextAttemptAt).toBe(scheduled)
    await reopened.outbox.drain()
    expect(stateOf(reopened.outbox, record.mutationId)).toBe('queued')

    clock.advance(1_000)
    await reopened.outbox.drain()
    expect(stateOf(reopened.outbox, record.mutationId)).toBe('applied')
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D10 — the age limit, and a per-command override that may only shorten', () => {
  it('carries D10s numbers and D11s inequality shape', () => {
    expect(OUTBOX_MAX_AGE_MS).toBe(14 * DAY)
    expect(SKEW_MARGIN_MS).toBeGreaterThanOrEqual(2 * DAY)
  })

  it('expires a shortened command while an ordinary one queued at the same moment survives', async () => {
    const { outbox, clock } = await harness(() => unreachable, {
      commandMaxAgeMs: { 'locks.acquire': 60_000 },
    })
    const lock = await outbox.enqueue({
      command: LOCK,
      input: { resource: 'test-lane' },
      attribution: ADA,
      partitionKey: 'lock:test-lane',
    })
    const issue = await outbox.enqueue(close('POD-1'))

    clock.advance(60_001)
    expect(await outbox.sweepExpired()).toEqual([lock.mutationId])

    expect(stateOf(outbox, lock.mutationId)).toBe('dead-letter')
    // The counterfactual: an entry of the SAME age under the base horizon lives.
    expect(stateOf(outbox, issue.mutationId)).toBe('queued')
    expect(outbox.deadLetters().map((d) => d.command.name)).toEqual(['locks.acquire'])
  })

  it('refuses a LENGTHENING override at open, rather than clamping it silently', async () => {
    await expect(
      harness(() => applied, { commandMaxAgeMs: { 'issues.close': OUTBOX_MAX_AGE_MS + 1 } }),
    ).rejects.toThrow(OutboxAgeOverrideError)
    // The rule itself, both directions: shortening resolves, lengthening throws.
    expect(resolveMaxAgeMs(OUTBOX_MAX_AGE_MS, 'locks.acquire', 60_000)).toBe(60_000)
    expect(resolveMaxAgeMs(OUTBOX_MAX_AGE_MS, 'issues.close', undefined)).toBe(OUTBOX_MAX_AGE_MS)
    expect(() => resolveMaxAgeMs(1_000, 'x', 1_001)).toThrow(OutboxAgeOverrideError)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D11.5 — the client that comes back after forty days', () => {
  it('finds its aged work already in dead-letter recovery, and sends none of it', async () => {
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const before = await harness(() => unreachable, { store, clock })
    const first = await before.outbox.enqueue(close('POD-1'))
    const second = await before.outbox.enqueue(close('POD-2'))

    // Forty days offline: past the fourteen-day age limit, and past the point
    // where the Authority may still hold a receipt for these ids.
    clock.advance(40 * DAY)
    const { outbox, authority, events } = await harness(() => applied, { store, clock })

    // Nothing was sent. That refusal is the whole mechanism: past the dedupe
    // horizon a replay is a FRESH command, and `sessions.sendText` double-types
    // into a live PTY.
    expect(authority.envelopes).toEqual([])
    expect(outbox.all().map((r) => r.state)).toEqual(['dead-letter', 'dead-letter'])
    const parked = outbox.deadLetters()
    expect(parked.map((d) => d.reason)).toEqual([{ code: 'max-age' }, { code: 'max-age' }])
    expect(parked.map((d) => d.parkedFrom)).toEqual(['expired', 'expired'])
    // Nothing was DROPPED: the author's own input is intact and recoverable, which
    // is what D9 invariant 1 protects and what re-authoring depends on.
    expect(parked.map((d) => d.input)).toEqual([
      { issueId: 'POD-1', comment: 'closing POD-1' },
      { issueId: 'POD-2', comment: 'closing POD-2' },
    ])
    expect(events.filter((e) => e.type === 'dead-lettered')).toHaveLength(2)

    // Recovery is a REBASE onto a new identity (D11.4): the old id may still carry
    // a receipt, so re-issuing under it could return the stored result instead of
    // running the re-authored intent.
    expect(parked[0]?.recovery.retry).toBe('new-mutation-id')
    await expect(outbox.retry(first.mutationId, { rightsFixed: true })).rejects.toThrow(
      /requires new-mutation-id/,
    )
    const reissued = await outbox.retry(first.mutationId, { mutationId: 'fresh-1' })
    expect(reissued.mutationId).toBe('fresh-1')
    expect(reissued.queuedAt).toBe(clock.now())
    expect(reissued.input).toEqual({ issueId: 'POD-1', comment: 'closing POD-1' })

    await outbox.drain()
    expect(stateOf(outbox, reissued.mutationId)).toBe('applied')
    // The aged id never reached the wire; only the fresh one did.
    expect(authority.envelopes.map((e) => e.mutationId)).toEqual(['fresh-1'])
    expect(stateOf(outbox, second.mutationId)).toBe('dead-letter')
  })

  it('resolves an expiry AND a revocation coherently, with no existence oracle', async () => {
    // The multi-user variant: the client returns past the dedupe horizon AND past
    // a revocation it never saw. Both facts have to produce one coherent outcome.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const before = await harness(() => unreachable, { store, clock })
    const shared = await before.outbox.enqueue(close('SHARED'))
    const mine = await before.outbox.enqueue(close('MINE'))
    const ghost = await before.outbox.enqueue(close('NEVER-EXISTED'))

    clock.advance(40 * DAY)
    // While Ada was away her access to SHARED was revoked. The Authority resolves
    // the delegation chain live at drain time, so the denial arrives now — the
    // replica must not have pre-empted it by dropping the entry itself.
    const { outbox, authority } = await harness(
      (envelope) => {
        const issueId = (envelope.input as { issueId: string }).issueId
        if (issueId === 'SHARED') return denied
        if (issueId === 'NEVER-EXISTED') return notFound
        return applied
      },
      { store, clock },
    )

    // Fact one — age: all three expired, none was sent.
    expect(outbox.all().map((r) => r.state)).toEqual(['dead-letter', 'dead-letter', 'dead-letter'])
    expect(authority.envelopes).toEqual([])

    // Fact two — the user re-authors, and only NOW does the revocation surface.
    const freshShared = await outbox.retry(shared.mutationId, { mutationId: 'fresh-shared' })
    const freshMine = await outbox.retry(mine.mutationId, { mutationId: 'fresh-mine' })
    const freshGhost = await outbox.retry(ghost.mutationId, { mutationId: 'fresh-ghost' })
    await outbox.drain()

    expect(stateOf(outbox, freshMine.mutationId)).toBe('applied')
    expect(stateOf(outbox, freshShared.mutationId)).toBe('dead-letter')

    const revoked = outbox.deadLetters().find((d) => d.mutationId === freshShared.mutationId)
    const nonexistent = outbox.deadLetters().find((d) => d.mutationId === freshGhost.mutationId)
    // No existence oracle (§3.1.5): the revoked target and the id that never
    // existed produce BYTE-IDENTICAL explanations and identical affordances, so the
    // failure cannot be read as "this thing exists and is not yours".
    expect(revoked?.reason).toEqual({ code: 'unauthorized' })
    expect(JSON.stringify(revoked?.reason)).toBe(JSON.stringify(nonexistent?.reason))
    expect(revoked?.recovery).toEqual(nonexistent?.recovery)
    // And the user's authored work is SURFACED rather than silently dropped: their
    // own text is still there to re-author or take elsewhere.
    expect(revoked?.input).toEqual({ issueId: 'SHARED', comment: 'closing SHARED' })
    expect(revoked?.attribution).toEqual(ADA)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('a retry re-authorizes LIVE: nothing in the retry path caches a capability', () => {
  it('denies again after a rights-fix retry the authority does not honour', async () => {
    const { outbox, authority } = await harness(() => denied)
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()
    expect(stateOf(outbox, record.mutationId)).toBe('dead-letter')

    // The user believes they fixed their rights. They did not — or it was revoked
    // again in between. The retry re-executes under the principal's rights AT
    // RETRY TIME, resolved by the Authority, so it is refused a second time.
    await outbox.retry(record.mutationId, { rightsFixed: true })
    await outbox.drain()

    expect(stateOf(outbox, record.mutationId)).toBe('dead-letter')
    expect(authority.attempts(record.mutationId)).toBe(2)
    expect(outbox.deadLetters()[0]?.reason).toEqual({ code: 'unauthorized' })

    // And it applies the moment the Authority genuinely allows it — with no change
    // to the entry, because the entry never carried the decision.
    authority.reprogram(() => applied)
    await outbox.retry(record.mutationId, { rightsFixed: true })
    await outbox.drain()
    expect(stateOf(outbox, record.mutationId)).toBe('applied')
  })

  it('adds no rights-shaped field to the durable record anywhere on the retry path', async () => {
    // A structural guard rather than a review promise: the durable key set is
    // enumerated, so an edit that stashed a capability, an "allow" bit or a scope
    // on the record to save a round-trip would fail here. `retry` is the path that
    // would be tempted to do it, so the assertion is taken AFTER one.
    const permitted = new Set([
      'mutationId',
      'command',
      'input',
      'expectedRevision',
      'partitionKey',
      'attribution',
      'confirmed',
      'state',
      'queuedAt',
      'attempts',
      'lastAttemptAt',
      'nextAttemptAt',
      'acceptedAt',
      'appliedAt',
      'reason',
      'deadLetteredAt',
      'cancelledAt',
      'parkedFrom',
    ])
    const { outbox, store } = await harness(() => denied)
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()
    await outbox.retry(record.mutationId, { rightsFixed: true })
    await outbox.drain()

    const durable = store.durable()
    expect(durable).toHaveLength(1)
    for (const row of durable) {
      const unexpected = Object.keys(row).filter((key) => !permitted.has(key))
      expect(unexpected).toEqual([])
    }
    // The attribution the record DOES carry is identity, not rights: it says who
    // authored the work, and the Authority still resolves what they may do.
    expect((durable[0] as OutboxRecord).attribution).toEqual(ADA)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D11 — the dedupe horizon holds over a feed range that was watermark-suppressed', () => {
  /**
   * A watermarked gap is not a missing receipt. Under POD-1077's per-principal
   * feed, the range a client replays over may have been SUPPRESSED for it, and the
   * only correct reading of that is "nothing you may see happened here" — never
   * "your write did not apply", and never "your receipt is gone, re-issue it".
   *
   * So this drives the REAL Replica with the REAL Outbox wired in as its overlay,
   * because the claim is about what the two do together. The positive control runs
   * FIRST: a certified frame carrying the write's provenance DOES retire the entry,
   * which is how we know the instrument can say yes before its no means anything.
   */
  interface Wired {
    readonly outbox: Outbox
    readonly replica: Replica
    readonly clock: ManualClock
    readonly authority: ScriptedAuthority
    /**
     * EMPTY by construction now, and kept deliberately: the `await Promise.all(...)`
     * calls below read as the harness waiting for retirement, and the honest answer is
     * that `replica.settled()` is what waits for it since the retirement is enrolled in
     * the replica's transaction. Deleting the field would have meant touching every
     * case; leaving it named for what it now is says the same thing in one place.
     */
    readonly retirements: Promise<void>[]
  }

  async function wired(respond: Responder = () => accepted): Promise<Wired> {
    const clock = new ManualClock()
    const h = await harness(respond, { clock })
    const retirements: Promise<void>[] = []
    const overlay: OptimisticOverlayPort = {
      pending: (entity, entityId) =>
        h.outbox
          .pending()
          .filter((r) => r.partitionKey === `${entity}:${entityId}`)
          .map((r) => ({
            mutationId: r.mutationId,
            entity,
            entityId,
            command: r.command,
          })),
      // Identity passthrough. POD-372 widened this port from bare `unknown` to the
      // closed OptimisticEffect while POD-371 was in flight, so the faithful
      // translation of the old `(base) => base` is a `value` effect carrying the
      // unchanged base — not `no-reducer`, which would change what this fixture
      // exercises. Nothing here tests the overlay; the reducer is incidental to the
      // dedupe-horizon assertions below.
      reduce: (base) => ({ kind: 'value', value: base }) as const,
      retire: (matches, span) => {
        // The Replica reports the facts; what the outbox does with them is the
        // outbox's own lifecycle — note the apply, then retire after covering truth.
        //
        // POD-1158: this used to push the work onto a side array and call
        // `retireAllApplied(ids)` with NO SPAN, because the Replica committed its own
        // span synchronously and an async participant could not enrol in it. That
        // sidestep was correct for a fixture and is the D10 non-compliance as
        // production wiring, so with the seam fixed it is now the REAL wiring: the
        // promise is RETURNED, the Replica awaits it inside `transact`'s body, and the
        // retirement lands in the same transaction as the cache write and the cursor.
        const ids = matches
          .map((m) => m.mutationId)
          .filter((id): id is string => id !== undefined) as MutationId[]
        return (async () => {
          for (const id of ids) {
            if (h.outbox.find(id)?.state === 'accepted') await h.outbox.noteApplied(id)
          }
          await h.outbox.retireAllApplied(ids, span)
        })()
      },
    }
    const store = new InMemoryReplicaStore()
    const feed = new FakeAuthority()
    feed.slice = { snapshotSeq: 0, rows: [] }
    const replica = new Replica({
      store: store.cache,
      authority: feed,
      overlay,
      // The transaction boundary, owned by the store rather than by the Replica.
      unitOfWork: store.unitOfWork,
    })
    replica.connect()
    await replica.settled()
    return { outbox: h.outbox, replica, clock: h.clock, authority: h.authority, retirements }
  }

  it('POSITIVE CONTROL: a certified frame carrying the provenance DOES retire the entry', async () => {
    const w = await wired()
    const record = await w.outbox.enqueue(close('POD-1', { partitionKey: 'issue:POD-1' }))
    await w.outbox.drain()
    expect(stateOf(w.outbox, record.mutationId)).toBe('accepted')

    w.replica.receive(
      deltaFrame(0, 1, [
        upsertChange(1, 'issue', 'POD-1', { closed: true }, { mutationId: record.mutationId }),
      ]),
    )
    await w.replica.settled()
    await Promise.all(w.retirements)

    expect(w.outbox.find(record.mutationId)).toBeUndefined()
    expect(w.outbox.pending()).toEqual([])
  })

  it('a suppressed range advances the cursor and retires, expires and drops NOTHING', async () => {
    const w = await wired()
    const record = await w.outbox.enqueue(close('POD-1', { partitionKey: 'issue:POD-1' }))
    await w.outbox.drain()

    // 500 watermarks: under private-by-default this is the NORMAL frame, and it is
    // exactly the shape a range suppressed for this principal takes.
    for (let seq = 1; seq <= 500; seq += 1) w.replica.receive(watermark(seq - 1, seq))
    await w.replica.settled()
    await Promise.all(w.retirements)

    // Contiguity held — no heal, no re-bootstrap: the gap was certified, so it is
    // not a gap.
    expect(w.replica.cursor).toEqual(cursorAt(500))
    expect(w.replica.posture).toBe('live')
    expect(w.replica.stats().watermarksApplied).toBe(500)
    // And the outbox read NOTHING into it. The entry is still awaiting its apply:
    // not retired (no covering truth arrived), not expired (the horizon is measured
    // from queuedAt, which no feed activity moves), not re-issued under a new id.
    expect(stateOf(w.outbox, record.mutationId)).toBe('accepted')
    expect(w.outbox.pending().map((r) => r.mutationId)).toEqual([record.mutationId])
    expect(w.outbox.deadLetters()).toEqual([])
    expect(w.outbox.find(record.mutationId)?.queuedAt).toBe(record.queuedAt)
  })

  it('measures the horizon from queuedAt alone, even across a long suppressed stretch', async () => {
    const w = await wired()
    const record = await w.outbox.enqueue(close('POD-1', { partitionKey: 'issue:POD-1' }))
    await w.outbox.drain()

    // Thirteen days of suppressed feed. A watermarked stretch must not shorten the
    // horizon (it is not evidence the receipt is gone) and must not extend it
    // (feed liveness is not the entry's age).
    for (let seq = 1; seq <= 13; seq += 1) {
      w.clock.advance(DAY)
      w.replica.receive(watermark(seq - 1, seq))
    }
    await w.replica.settled()
    await Promise.all(w.retirements)
    expect(await w.outbox.sweepExpired()).toEqual([])
    expect(stateOf(w.outbox, record.mutationId)).toBe('accepted')

    // Day fifteen. An `accepted` entry is still NOT the client's to expire — D10
    // lists `queued`/`sending`, and the Authority may apply it at any moment, so
    // expiring it locally would resolve a command that is still live.
    w.clock.advance(2 * DAY)
    expect(await w.outbox.sweepExpired()).toEqual([])
    expect(stateOf(w.outbox, record.mutationId)).toBe('accepted')

    // The liveness backstop is what ends the wait: the apply notification never
    // came, so the entry returns to `queued` — and THEN the age limit decides it,
    // with the reason being its age and never a conclusion drawn from the
    // suppressed range. Parking in `accepted` is not a way around the horizon.
    expect(await w.outbox.requeueStalled({ stalledForMs: DAY })).toEqual([record.mutationId])
    expect(await w.outbox.sweepExpired()).toEqual([record.mutationId])
    expect(w.outbox.deadLetters()[0]?.reason).toEqual({ code: 'max-age' })
  })
})
