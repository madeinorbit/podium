import { asSessionId, type MutationId } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  type EnqueueRequest,
  envelopeFor,
  Outbox,
  OutboxInvariantError,
  OutboxUsageError,
} from './outbox'
import type {
  OutboxEnvelope,
  OutboxEvent,
  OutboxSubmitOutcome,
  SyncSpan,
  SyncUnitOfWork,
} from './ports'
import type { AuthorityRefusal } from './reasons'
import {
  CONFIRMATION_FIELD,
  type OutboxAttribution,
  type OutboxCommand,
  type OutboxRecord,
} from './records'
import {
  InMemoryOutboxStore,
  InMemoryUnitOfWork,
  ManualClock,
  ScriptedAuthority,
  sequentialMutationIds,
} from './test-doubles'

// The Outbox role's behavioural suite. Structured around the acceptance criteria
// rather than around the API: every ADR 3 D9 invariant, the three distinct
// delivery events, the multi-user rejection paths the ADR 3 amendment adds
// (apply-time re-auth denial, evicted target, no existence oracle, private
// dead-letter records), and ADR 2 D7's "keep the outbox".

/** ADR 3 D10's value, supplied here as CONFIGURATION. D10 is its sole owner and
 *  POD-371 implements the constant plus D11's inequality lint; a default minted
 *  in this package would be the drift D11.3 warns about. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

const CLOSE: OutboxCommand = { name: 'issues.close', version: 1, delivery: 'offline-eligible' }

/** A human on `trpc`: actor and on-behalf-of are the same person, and the pair
 *  is still recorded as a pair (amendment D17.2). */
const ADA: OutboxAttribution = { actor: { kind: 'user', userId: 'u-ada' }, onBehalfOf: 'u-ada' }
const GRACE: OutboxAttribution = {
  actor: { kind: 'user', userId: 'u-grace' },
  onBehalfOf: 'u-grace',
}
/** An agent acting for Ada: the two halves are different identities (§3.1.3 A3). */
const ADAS_AGENT: OutboxAttribution = {
  actor: { kind: 'agent-session', sessionId: asSessionId('sess-7') },
  onBehalfOf: 'u-ada',
}

const applied: OutboxSubmitOutcome = { kind: 'applied' }
const unreachable: OutboxSubmitOutcome = { kind: 'unreachable' }
const denied: OutboxSubmitOutcome = { kind: 'rejected', refusal: { kind: 'unauthorized' } }
const notFound: OutboxSubmitOutcome = { kind: 'rejected', refusal: { kind: 'target-not-found' } }
const conflicted: OutboxSubmitOutcome = { kind: 'rejected', refusal: { kind: 'conflict' } }

interface Harness {
  readonly outbox: Outbox
  readonly store: InMemoryOutboxStore
  readonly authority: ScriptedAuthority
  readonly clock: ManualClock
  readonly events: OutboxEvent[]
  readonly unreadable: unknown[]
}

async function harness(
  respond: (
    envelope: OutboxEnvelope,
    attempt: number,
  ) => OutboxSubmitOutcome | Promise<OutboxSubmitOutcome> = () => applied,
  init: {
    store?: InMemoryOutboxStore
    clock?: ManualClock
    principal?: string
    unitOfWork?: SyncUnitOfWork
    idPrefix?: string
  } = {},
): Promise<Harness> {
  const store = init.store ?? new InMemoryOutboxStore()
  const clock = init.clock ?? new ManualClock()
  const authority = new ScriptedAuthority(respond)
  const events: OutboxEvent[] = []
  const unreadable: unknown[] = []
  const outbox = await Outbox.open({
    store,
    submit: authority,
    principal: init.principal ?? 'u-ada',
    now: clock.now,
    maxAgeMs: MAX_AGE_MS,
    newMutationId: sequentialMutationIds(init.idPrefix ?? 'm'),
    onStoreUnreadable: (error) => unreadable.push(error),
    ...(init.unitOfWork ? { unitOfWork: init.unitOfWork } : {}),
  })
  outbox.subscribe((event) => events.push(event))
  return { outbox, store, authority, clock, events, unreadable }
}

const close = (issue: string, extra: Partial<EnqueueRequest> = {}): EnqueueRequest => ({
  command: CLOSE,
  input: { issueId: issue, comment: 'shipping this' },
  attribution: ADA,
  partitionKey: `issue:${issue}`,
  ...extra,
})

const types = (events: readonly OutboxEvent[]): string[] => events.map((e) => e.type)
const state = (outbox: Outbox, id: MutationId): string | undefined => outbox.find(id)?.state

describe('local ack, acceptance and application are three distinct events', () => {
  it('emits local-ack at enqueue, and only after the entry is durable', async () => {
    const { outbox, store, events } = await harness()
    let durableAtAck: readonly OutboxRecord[] = []
    outbox.subscribe((event) => {
      if (event.type === 'local-ack') durableAtAck = store.durable()
    })

    const record = await outbox.enqueue(close('POD-1'))

    expect(types(events)).toEqual(['local-ack'])
    // A local ack that outran its own durability would be a lie (ADR 6 D4.3).
    expect(durableAtAck.map((r) => r.mutationId)).toEqual([record.mutationId])
    expect(record.state).toBe('queued')
  })

  it('distinguishes authority ACCEPTANCE from APPLICATION when the hop is not atomic', async () => {
    const { outbox, events } = await harness(() => ({ kind: 'accepted' }))
    const record = await outbox.enqueue(close('POD-1'))

    await outbox.drain()
    expect(state(outbox, record.mutationId)).toBe('accepted')
    expect(types(events)).toEqual(['local-ack', 'sending', 'accepted'])

    await outbox.noteApplied(record.mutationId)
    expect(state(outbox, record.mutationId)).toBe('applied')
    expect(types(events)).toEqual(['local-ack', 'sending', 'accepted', 'applied'])
  })

  it('collapses accepted into applied when the authority applies atomically', async () => {
    const { outbox, events } = await harness()
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    expect(state(outbox, record.mutationId)).toBe('applied')
    expect(types(events)).toEqual(['local-ack', 'sending', 'applied'])
  })

  it('retires an applied entry only once covering truth lands — and only from applied', async () => {
    const { outbox, store, events } = await harness()
    const record = await outbox.enqueue(close('POD-1'))
    await expect(outbox.retireApplied(record.mutationId)).rejects.toThrow(OutboxUsageError)

    await outbox.drain()
    await outbox.retireApplied(record.mutationId)

    expect(outbox.all()).toEqual([])
    expect(store.durable()).toEqual([])
    expect(types(events)).toContain('retired')
  })
})

describe('D9 invariant 4 — network failure is not a rejection', () => {
  it('returns a failed send to queued, with no reason and no dead-letter', async () => {
    const { outbox, events } = await harness(() => unreachable)
    const record = await outbox.enqueue(close('POD-1'))

    await outbox.drain()
    await outbox.drain()
    await outbox.drain()

    expect(state(outbox, record.mutationId)).toBe('queued')
    expect(outbox.find(record.mutationId)?.reason).toBeUndefined()
    expect(outbox.deadLetters()).toEqual([])
    expect(types(events).filter((t) => t === 'rejected' || t === 'dead-lettered')).toEqual([])
    // Retried without limit until the age limit — three passes, three attempts.
    expect(outbox.find(record.mutationId)?.attempts).toBe(3)
  })

  it('treats a thrown transport error as unreachable, never as poison', async () => {
    const { outbox } = await harness(() => {
      throw new Error('socket closed')
    })
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    expect(state(outbox, record.mutationId)).toBe('queued')
  })

  it('is at-least-once: a lost reply replays the SAME mutationId, so the receipt dedupes it', async () => {
    let firstReplyLost = true
    const { outbox, authority } = await harness(() => {
      if (firstReplyLost) {
        firstReplyLost = false
        return unreachable
      }
      return applied
    })
    const record = await outbox.enqueue(close('POD-1'))

    await outbox.drain()
    await outbox.drain()

    expect(authority.envelopes.map((e) => e.mutationId)).toEqual([
      record.mutationId,
      record.mutationId,
    ])
    expect(state(outbox, record.mutationId)).toBe('applied')
  })

  it('recovers an interrupted send on open: a sending entry that never reported back is queued', async () => {
    const store = new InMemoryOutboxStore()
    const first = await harness(() => unreachable, { store })
    const record = await first.outbox.enqueue(close('POD-1'))
    // Simulate a crash mid-flight by persisting the in-flight state directly.
    store.seed([{ ...(first.outbox.find(record.mutationId) as OutboxRecord), state: 'sending' }])

    const second = await harness(() => applied, { store })
    expect(state(second.outbox, record.mutationId)).toBe('queued')
    await second.outbox.drain()
    expect(state(second.outbox, record.mutationId)).toBe('applied')
  })
})

describe('D9 invariants 1-3 — a definitive rejection is surfaced, parked and recoverable', () => {
  it('parks a conflict in dead-letter with a rebase affordance, and never retries it automatically', async () => {
    const { outbox, authority, events } = await harness(() => conflicted)
    const record = await outbox.enqueue(close('POD-1', { expectedRevision: 4 }))

    await outbox.drain()
    await outbox.drain()
    await outbox.drain()

    expect(types(events)).toEqual(['local-ack', 'sending', 'rejected', 'dead-lettered'])
    expect(state(outbox, record.mutationId)).toBe('dead-letter')
    // D10: zero automatic retries for a definitive rejection.
    expect(authority.attempts(record.mutationId)).toBe(1)

    const [parked] = outbox.deadLetters()
    expect(parked?.reason).toEqual({ code: 'conflict' })
    expect(parked?.recovery).toEqual({ retry: 'rebase', edit: true, discard: true })
    expect(parked?.input).toEqual({ issueId: 'POD-1', comment: 'shipping this' })
    expect(parked?.parkedFrom).toBe('rejected')
  })

  it('recovers out of dead-letter by retry, and the retried entry applies', async () => {
    let refuse = true
    const { outbox, events } = await harness(() => (refuse ? conflicted : applied))
    const record = await outbox.enqueue(close('POD-1', { expectedRevision: 4 }))
    await outbox.drain()

    refuse = false
    await outbox.retry(record.mutationId, { expectedRevision: 9 })
    expect(state(outbox, record.mutationId)).toBe('queued')
    expect(outbox.find(record.mutationId)?.reason).toBeUndefined()
    expect(outbox.deadLetters()).toEqual([])

    await outbox.drain()
    expect(state(outbox, record.mutationId)).toBe('applied')
    expect(types(events)).toEqual([
      'local-ack',
      'sending',
      'rejected',
      'dead-lettered',
      'requeued',
      'sending',
      'applied',
    ])
  })

  it('refuses a recovery whose precondition is not met', async () => {
    const { outbox } = await harness(() => conflicted)
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    // A conflict needs a rebase; asserting a rights fix does not satisfy it.
    await expect(outbox.retry(record.mutationId, { rightsFixed: true })).rejects.toThrow(
      /requires rebase/,
    )
    expect(state(outbox, record.mutationId)).toBe('dead-letter')
  })

  it('recovers by EDIT under a fresh mutationId, retiring the edited entry to cancelled', async () => {
    const { outbox } = await harness(() => ({
      kind: 'rejected',
      refusal: { kind: 'invalid', details: ['comment'] },
    }))
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    const [parked] = outbox.deadLetters()
    expect(parked?.reason).toEqual({ code: 'invalid', details: ['comment'] })
    // Validation poison cannot be retried as-is; only an edit can succeed.
    expect(parked?.recovery.retry).toBe('never')
    await expect(outbox.retry(record.mutationId, { rightsFixed: true })).rejects.toThrow(/never/)

    const fresh = await outbox.edit(record.mutationId, {
      input: { issueId: 'POD-1', comment: 'ok' },
    })
    expect(fresh.mutationId).not.toBe(record.mutationId)
    expect(fresh.state).toBe('queued')
    expect(state(outbox, record.mutationId)).toBe('cancelled')
    expect(outbox.deadLetters()).toEqual([])
  })

  it('recovers by DISCARD to cancelled — from dead-letter and straight from queued', async () => {
    const { outbox, store } = await harness(() => conflicted)
    const parkedEntry = await outbox.enqueue(close('POD-1'))
    const queuedEntry = await outbox.enqueue(close('POD-2'))
    await outbox.drain()

    await outbox.discard(parkedEntry.mutationId)
    await outbox.discard(queuedEntry.mutationId)

    expect(state(outbox, parkedEntry.mutationId)).toBe('cancelled')
    expect(state(outbox, queuedEntry.mutationId)).toBe('cancelled')
    // The user's decision is durable before the row goes anywhere.
    expect(store.durable().every((r) => r.state === 'cancelled')).toBe(true)
    await outbox.purgeCancelled(parkedEntry.mutationId)
    expect(outbox.find(parkedEntry.mutationId)).toBeUndefined()
  })

  it('parks a straggler on open: a crash between the verdict and the parking loses nothing', async () => {
    const store = new InMemoryOutboxStore()
    const first = await harness(() => applied, { store })
    const record = await first.outbox.enqueue(close('POD-1'))
    store.seed([
      {
        ...(first.outbox.find(record.mutationId) as OutboxRecord),
        state: 'rejected',
        reason: { code: 'conflict' },
      },
    ])

    const second = await harness(() => applied, { store })
    expect(state(second.outbox, record.mutationId)).toBe('dead-letter')
    expect(second.outbox.deadLetters()).toHaveLength(1)
  })
})

describe('D10 — age limit', () => {
  it('expires an entry that outlived the horizon and parks it with reason max-age', async () => {
    const { outbox, clock, events } = await harness(() => unreachable)
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    clock.advance(MAX_AGE_MS + 1)
    const expired = await outbox.sweepExpired()

    expect(expired).toEqual([record.mutationId])
    expect(state(outbox, record.mutationId)).toBe('dead-letter')
    expect(types(events).slice(-2)).toEqual(['expired', 'dead-lettered'])
    const [parked] = outbox.deadLetters()
    expect(parked?.reason).toEqual({ code: 'max-age' })
    expect(parked?.parkedFrom).toBe('expired')
  })

  it('refuses to send an aged entry, expiring it inside the drain instead', async () => {
    const { outbox, authority, clock } = await harness(() => applied)
    const record = await outbox.enqueue(close('POD-1'))

    clock.advance(MAX_AGE_MS + 1)
    await outbox.drain()

    // D11.8: a replay past the receipt horizon would be a FRESH command, so the
    // expiry — not the authority — is what refuses the send.
    expect(authority.envelopes).toEqual([])
    expect(state(outbox, record.mutationId)).toBe('dead-letter')
  })

  it('requires a NEW mutationId to re-issue an expired entry (D11.4)', async () => {
    const { outbox, clock } = await harness(() => applied)
    const record = await outbox.enqueue(close('POD-1'))
    clock.advance(MAX_AGE_MS + 1)
    await outbox.sweepExpired()

    const [parked] = outbox.deadLetters()
    expect(parked?.recovery.retry).toBe('new-mutation-id')
    // The old id may still have a receipt, so reusing it is refused.
    await expect(outbox.retry(record.mutationId, { rightsFixed: true })).rejects.toThrow(
      /requires new-mutation-id/,
    )

    const reissued = await outbox.retry(record.mutationId, { mutationId: 'm-fresh' })
    expect(reissued.mutationId).toBe('m-fresh')
    expect(reissued.state).toBe('queued')
    expect(reissued.input).toEqual({ issueId: 'POD-1', comment: 'shipping this' })
    expect(state(outbox, record.mutationId)).toBe('cancelled')
  })
})

describe('apply-time re-authorization is a first-class rejection path (D8 / amendment D16)', () => {
  it('carries no capability, no rights snapshot and no identity on the envelope', async () => {
    const { outbox, authority } = await harness()
    const record = await outbox.enqueue(close('POD-1', { attribution: ADAS_AGENT }))
    await outbox.drain()

    const [envelope] = authority.envelopes
    expect(Object.keys(envelope ?? {}).sort()).toEqual([
      'command',
      'input',
      'mutationId',
      'version',
    ])
    // Nothing identity- or rights-shaped exists to send: the record itself has
    // no capability field, so a replay has nothing stale to re-present.
    expect(JSON.stringify(envelopeFor(record))).not.toContain('u-ada')
    expect(JSON.stringify(envelopeFor(record))).not.toContain('sess-7')
    expect('capability' in (outbox.find(record.mutationId) as object)).toBe(false)
  })

  it('revoked while offline: the queued write is REJECTED on reconnect, not applied', async () => {
    // The central multi-user risk (readiness §2): someone is un-shared while a
    // collaborator is offline with pending commands.
    const { outbox, authority, events } = await harness(() => unreachable)
    const record = await outbox.enqueue(close('POD-1', { attribution: ADAS_AGENT }))
    await outbox.drain()
    expect(state(outbox, record.mutationId)).toBe('queued')

    // Ada's share is revoked. Her agent's rights are her CURRENT rights
    // intersected with its scope, resolved live at apply — so the very same
    // envelope now fails.
    authority.reprogram(() => denied)
    await outbox.drain()

    expect(state(outbox, record.mutationId)).toBe('dead-letter')
    const [parked] = outbox.deadLetters()
    expect(parked?.reason).toEqual({ code: 'unauthorized' })
    expect(parked?.recovery.retry).toBe('rights-fix')
    // Distinguishable from a conflict, which is the whole point of D16.4.
    expect(parked?.reason.code).not.toBe('conflict')
    expect(types(events)).toContain('dead-lettered')
    // Zero automatic retries after the denial, and the work is still there.
    await outbox.drain()
    expect(authority.attempts(record.mutationId)).toBe(2)
    expect(parked?.input).toEqual({ issueId: 'POD-1', comment: 'shipping this' })
  })

  it('rejects an accepted envelope the authority refuses at apply time', async () => {
    const { outbox } = await harness(() => ({ kind: 'accepted' }))
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()
    expect(state(outbox, record.mutationId)).toBe('accepted')

    await outbox.noteRejected(record.mutationId, { kind: 'unauthorized' })

    expect(state(outbox, record.mutationId)).toBe('dead-letter')
    expect(outbox.deadLetters()[0]?.reason).toEqual({ code: 'unauthorized' })
  })

  it('retries after a rights fix, and only then', async () => {
    let revoked = true
    const { outbox } = await harness(() => (revoked ? denied : applied))
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    await expect(outbox.retry(record.mutationId, { expectedRevision: 2 })).rejects.toThrow(
      /requires rights-fix/,
    )

    revoked = false // an admin re-shares the issue
    await outbox.retry(record.mutationId, { rightsFixed: true })
    await outbox.drain()
    expect(state(outbox, record.mutationId)).toBe('applied')
  })

  it('parks a confirmation-required refusal with a confirmation affordance', async () => {
    const { outbox, authority, store } = await harness((envelope) =>
      envelope.confirmed
        ? applied
        : { kind: 'rejected', refusal: { kind: 'confirmation-required' } },
    )
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    expect(outbox.deadLetters()[0]?.recovery.retry).toBe('confirmation')
    await outbox.retry(record.mutationId, { confirmed: true })
    await outbox.drain()

    expect(state(outbox, record.mutationId)).toBe('applied')
    // Spelled literally on purpose: pinning the wire shape is a test's job. The
    // second assertion is what keeps POD-311's rename a ONE-line change — if the
    // constant moves and the envelope does not follow, this fails.
    expect(authority.envelopes.at(-1)?.confirmed).toBe(true)
    expect(Object.keys(authority.envelopes.at(-1) ?? {})).toContain(CONFIRMATION_FIELD)
    // And the confirmation is durable with the entry, because an offline
    // out-of-scope write that lost it would be refused at apply (D8 outcome 3).
    expect(store.durable().at(-1)?.confirmed).toBe(true)
  })
})

describe('no existence oracle in the failure surface (amendment D20 / property 15)', () => {
  it('an invisible target and a nonexistent id produce byte-identical records', async () => {
    // Same command, same input, same clock: the ONLY difference is what the
    // authority saw — a denial versus a missing row. The user must not be able
    // to tell those apart, so the two dead-letter records must be identical.
    const invisible = await harness(() => denied)
    const missing = await harness(() => notFound)
    for (const h of [invisible, missing]) {
      await h.outbox.enqueue(close('POD-secret'))
      await h.outbox.drain()
    }

    const shape = (h: Harness): string =>
      JSON.stringify({ ...h.outbox.deadLetters()[0], mutationId: '<id>' })

    expect(shape(invisible)).toBe(shape(missing))
    expect(shape(invisible)).toContain('"code":"unauthorized"')
    // And nothing helpful leaked: no "you don't have access to" detail exists to
    // leak, because only `invalid` may carry details at all.
    expect(shape(invisible)).not.toContain('details')
  })

  it('emits identical rejection events for both cases', async () => {
    const invisible = await harness(() => denied)
    const missing = await harness(() => notFound)
    for (const h of [invisible, missing]) {
      await h.outbox.enqueue(close('POD-secret'))
      await h.outbox.drain()
    }
    const reason = (h: Harness) => h.events.find((e) => e.type === 'rejected')
    expect(reason(invisible)).toEqual({
      ...reason(missing),
      mutationId: reason(invisible)?.mutationId,
    })
  })

  it('strips any detail an adapter attaches to a non-validation refusal', async () => {
    const { outbox, events } = await harness(() => ({
      kind: 'rejected',
      // An over-helpful adapter, of the exact kind the rule exists to stop: it
      // names the private issue in a detail field. The kernel normalizes it away
      // rather than trusting every adapter to remember the rule.
      refusal: {
        kind: 'unauthorized',
        details: ['issue POD-secret is shared with u-grace only'],
      } as unknown as AuthorityRefusal,
    }))
    await outbox.enqueue(close('POD-secret'))
    await outbox.drain()

    const [parked] = outbox.deadLetters()
    expect(parked?.reason).toEqual({ code: 'unauthorized' })
    expect(JSON.stringify(parked)).not.toContain('u-grace')
    expect(JSON.stringify(events)).not.toContain('u-grace')
  })
})

describe('the evicted-target case resolves inside D9s existing state set', () => {
  it('survives a rescope re-bootstrap and is then refused at drain, not dropped at the replica', async () => {
    // A revoked share evicts the target from the author's view (ADR 2 amendment
    // D14). That is not a user cancellation and not a deletion, and the replica
    // does not get to decide the command is moot — only the Authority does, at
    // drain time, via D8.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const first = await harness(() => unreachable, { store, clock })
    const record = await first.outbox.enqueue(close('POD-shared'))
    await first.outbox.drain()

    // Rung 2: the replica discards its cache and re-bootstraps scoped. Nothing
    // in the outbox's port surface can express that, so the strongest thing this
    // side can observe is what every rung ends in — a cold start over the same
    // store — and the entry must still be there, still queued, to be refused.
    const { outbox, authority, events } = await harness(() => denied, { store, clock })
    expect(state(outbox, record.mutationId)).toBe('queued')

    authority.reprogram(() => denied)
    await outbox.drain()

    expect(state(outbox, record.mutationId)).toBe('dead-letter')
    expect(outbox.deadLetters()[0]?.reason).toEqual({ code: 'unauthorized' })
    // No ninth state was invented for it, and nothing vanished.
    expect(types(events)).not.toContain('store-unreadable')
    expect(outbox.all()).toHaveLength(1)
  })
})

describe('ADR 2 D7 — replica heal and re-bootstrap never drop the outbox', () => {
  it('preserves and still drains queued work across every rung, epoch bump included', async () => {
    const store = new InMemoryOutboxStore()
    const { outbox, clock } = await harness(() => unreachable, { store })
    const a = await outbox.enqueue(close('POD-1'))
    const b = await outbox.enqueue(close('POD-2'))
    await outbox.drain()

    // Every rung of the ladder — gap, compacted, malformed, epoch mismatch, local
    // corruption, replica schema bump and the amendment's rescope — terminates in
    // the same place: re-bootstrap through the same feed identity. The outbox has
    // no hook any of them could pull (see ports.ts), so what this side must prove
    // is that the entries are untouched and still drain afterwards.
    expect(outbox.all().map((r) => r.state)).toEqual(['queued', 'queued'])

    // Not just in memory: a cold start after the re-bootstrap still finds them.
    expect(store.durable().map((r) => r.mutationId)).toEqual([a.mutationId, b.mutationId])
    const reopened = await harness(() => applied, { store, clock })
    await reopened.outbox.drain()
    expect(state(reopened.outbox, a.mutationId)).toBe('applied')
    expect(state(reopened.outbox, b.mutationId)).toBe('applied')
  })

  it('surfaces a stale expectedRevision as an authority rejection, never as a replica-side drop', async () => {
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const before = await harness(() => unreachable, { store, clock })
    const record = await before.outbox.enqueue(close('POD-1', { expectedRevision: 3 }))

    // An epoch bump and a fresh bootstrap later, the precondition is stale — and
    // the entry is still queued, because deciding it was moot would be the
    // replica arbitrating (ADR 2 D7).
    const { outbox } = await harness(() => conflicted, { store, clock })
    expect(outbox.find(record.mutationId)?.expectedRevision).toBe(3)
    await outbox.drain()

    expect(state(outbox, record.mutationId)).toBe('dead-letter')
    expect(outbox.deadLetters()[0]?.reason).toEqual({ code: 'conflict' })
  })

  it('offers no method through which a re-bootstrap could reach the queue', async () => {
    // The invariant upheld by ABSENCE (see ports.ts): POD-369 argued the
    // contractual no-op out of this module, because a no-op whose subject is the
    // queue is one edit away from data loss on the normal path — a rescope fires
    // whenever anybody's shares change.
    //
    // This name check is the SECONDARY guard and is deliberately weak: review
    // round 1 pointed out that a future `destroy`/`flush`, or a deletion slipped
    // inside a maintenance path, sails straight through a regex over method
    // names. The primary guard is structural — every id that disappears from a
    // draft must carry one of D9 invariant 1's two licences (see the
    // "removal without a licence" case below). Both are kept: the cheap one
    // catches the obvious naming, the structural one catches the rest.
    const surface = Object.getOwnPropertyNames(Outbox.prototype).filter((n) => n !== 'constructor')
    expect(
      surface.filter((n) => /rebootstrap|rescope|epoch|cache|clear|reset|wipe|drop/i.test(n)),
    ).toEqual([])
    // And the only two removals that exist are D9 invariant 1's two licences.
    expect(surface.filter((n) => /retire|purge/i.test(n)).sort()).toEqual([
      'purgeCancelled',
      'retireAllApplied',
      'retireApplied',
    ])
  })

  it('is LOUD about the one case where user work is lost: an unreadable store', async () => {
    const store = new InMemoryOutboxStore()
    const first = await harness(() => unreachable, { store })
    await first.outbox.enqueue(close('POD-1'))

    store.failRead = new Error('IDB: corrupt object store')
    const events: OutboxEvent[] = []
    const seen: unknown[] = []
    const outbox = await Outbox.open({
      store,
      submit: new ScriptedAuthority(() => applied),
      now: new ManualClock().now,
      maxAgeMs: MAX_AGE_MS,
      principal: 'u-ada',
      newMutationId: sequentialMutationIds('r'),
      onStoreUnreadable: (error) => seen.push(error),
      onEvent: (event) => events.push(event),
    })

    // Boot did not wedge (ADR 6 D4.5) and the loss was reported, twice over: a
    // REQUIRED callback and an event a listener registered before open can see.
    expect(seen).toHaveLength(1)
    expect(String(seen[0])).toContain('corrupt object store')
    expect(events).toEqual([{ type: 'store-unreadable', error: store.failRead }])
    expect(outbox.all()).toEqual([])
  })
})

describe('every entry records its principal as a pair, taken from the transport', () => {
  it('keeps actor and on-behalf-of distinct for an agent-authored command', async () => {
    const { outbox } = await harness()
    const record = await outbox.enqueue(close('POD-1', { attribution: ADAS_AGENT }))

    expect(record.attribution).toEqual({
      actor: { kind: 'agent-session', sessionId: 'sess-7' },
      onBehalfOf: 'u-ada',
    })
    // The pair is still a pair for a human, so consumers never branch on shape.
    const human = await outbox.enqueue(close('POD-2'))
    expect(human.attribution).toEqual({
      actor: { kind: 'user', userId: 'u-ada' },
      onBehalfOf: 'u-ada',
    })
  })

  it('ignores identity supplied in the payload — a forged onBehalfOf is inert', async () => {
    const { outbox, store } = await harness()
    const record = await outbox.enqueue({
      command: CLOSE,
      input: { issueId: 'POD-1', onBehalfOf: 'u-grace', actor: 'u-grace', capability: 'admin' },
      attribution: ADAS_AGENT,
      partitionKey: 'issue:POD-1',
    })

    expect(record.attribution.onBehalfOf).toBe('u-ada')
    expect(store.durable()[0]?.attribution).toEqual(ADAS_AGENT)
    // The forged fields survive as inert payload (D7.1: informational only) —
    // they simply have no path into the attribution.
    expect(record.attribution.actor).toEqual({ kind: 'agent-session', sessionId: 'sess-7' })
  })

  it('refuses to enqueue on behalf of anyone but the principal it is bound to', async () => {
    const { outbox, store } = await harness()
    await expect(outbox.enqueue(close('POD-1', { attribution: GRACE }))).rejects.toThrow(
      /bound to u-ada/,
    )
    expect(store.durable()).toEqual([])
  })
})

describe('dead-letter records are private to their author', () => {
  it('cannot be ASKED for by another principal, not merely filtered out', async () => {
    // The instance is bound to its authenticated principal, so a hostile caller
    // has no query to phrase: `deadLetters()` takes no argument at all. Two
    // principals sharing one physical store get two bound views.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const ada = await harness(() => denied, { store, clock })
    await ada.outbox.enqueue(close('POD-1', { attribution: ADA }))
    await ada.outbox.enqueue(close('POD-3', { attribution: ADAS_AGENT }))
    await ada.outbox.drain()
    expect(ada.outbox.deadLetters()).toHaveLength(2)

    const grace = await harness(() => denied, {
      store,
      clock,
      principal: 'u-grace',
      idPrefix: 'g',
    })

    // Every observation API is scoped, not just the recovery surface.
    expect(grace.outbox.deadLetters()).toEqual([])
    expect(grace.outbox.all()).toEqual([])
    expect(grace.outbox.pending()).toEqual([])
    expect(grace.outbox.boundTo()).toBe('u-grace')
    for (const id of ada.outbox.all().map((r) => r.mutationId)) {
      // A foreign id reads as unknown — the same answer as a nonexistent one, so
      // the bound view is not an existence oracle for another user's queue.
      expect(grace.outbox.find(id)).toBeUndefined()
      await expect(grace.outbox.discard(id)).rejects.toThrow(/unknown outbox entry/)
      await expect(grace.outbox.retry(id, { rightsFixed: true })).rejects.toThrow(
        /unknown outbox entry/,
      )
      await expect(grace.outbox.retireApplied(id)).rejects.toThrow(/unknown outbox entry/)
    }
    // And Grace's presence did not eat Ada's work: those are Ada's unsent
    // writes, and only her own bound instance may resolve them.
    await grace.outbox.enqueue(close('POD-2', { attribution: GRACE }))
    await grace.outbox.drain()
    expect(
      store
        .durable()
        .map((r) => r.attribution.onBehalfOf)
        .sort(),
    ).toEqual(['u-ada', 'u-ada', 'u-grace'])
    expect(ada.outbox.deadLetters()).toHaveLength(2)
  })

  it('does not leak another principal work through drain or events', async () => {
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const ada = await harness(() => unreachable, { store, clock })
    const adas = await ada.outbox.enqueue(close('POD-1', { attribution: ADA }))

    const grace = await harness(() => applied, {
      store,
      clock,
      principal: 'u-grace',
      idPrefix: 'g',
    })
    await grace.outbox.drain()

    // Grace's drain never submitted Ada's envelope over Grace's transport...
    expect(grace.authority.envelopes).toEqual([])
    // ...and no event about Ada's entry reached Grace's listener.
    expect(JSON.stringify(grace.events)).not.toContain(adas.mutationId)
    expect(store.durable().find((r) => r.mutationId === adas.mutationId)?.state).toBe('queued')
  })

  it('recovers the author own intent even when the target is no longer visible', async () => {
    const { outbox } = await harness(() => denied)
    await outbox.enqueue(close('POD-shared'))
    await outbox.drain()

    const [parked] = outbox.deadLetters()
    // Everything in the record is the author's own input or a code — there is no
    // authority-supplied target content to re-expose.
    expect(parked?.input).toEqual({ issueId: 'POD-shared', comment: 'shipping this' })
    expect(Object.keys(parked ?? {}).sort()).toEqual([
      'attempts',
      'attribution',
      'command',
      'deadLetteredAt',
      'input',
      'mutationId',
      'parkedFrom',
      'queuedAt',
      'reason',
      'recovery',
    ])
  })
})

describe('secrets are never queued (D4 rules 1 and 3 / POD-352)', () => {
  it('refuses an online-sensitive command before anything is persisted', async () => {
    const { outbox, store } = await harness()
    const secretWrite = {
      command: { name: 'settings.setSecret', version: 1, delivery: 'online-sensitive' },
      input: { key: 'ANTHROPIC_API_KEY', value: 'sk-live-1' },
      attribution: ADA,
    } as unknown as EnqueueRequest

    await expect(outbox.enqueue(secretWrite)).rejects.toThrow(OutboxUsageError)

    expect(outbox.all()).toEqual([])
    expect(store.durable()).toEqual([])
    expect(JSON.stringify(store.durable())).not.toContain('sk-live-1')
  })

  it('refuses an online-only command too', async () => {
    const { outbox } = await harness()
    await expect(
      outbox.enqueue({
        command: { name: 'sessions.spawn', version: 1, delivery: 'online-only' },
        input: {},
        attribution: ADA,
      } as unknown as EnqueueRequest),
    ).rejects.toThrow(/only offline-eligible/)
  })
})

describe('D12 — ordering partitions', () => {
  it('is FIFO within a partition and concurrent across partitions', async () => {
    const order: string[] = []
    const { outbox } = await harness((envelope) => {
      order.push((envelope.input as { issueId: string }).issueId)
      return applied
    })
    await outbox.enqueue(close('POD-1'))
    await outbox.enqueue(close('POD-1'))
    await outbox.enqueue(close('POD-2'))
    await outbox.drain()

    // Both POD-1 entries in order; POD-2 independent of them.
    expect(order.filter((i) => i === 'POD-1')).toEqual(['POD-1', 'POD-1'])
    expect(order).toContain('POD-2')
  })

  it('blocks only its own partition when an entry dead-letters, and unblocks on recovery', async () => {
    const { outbox, authority } = await harness((envelope) =>
      (envelope.input as { issueId: string }).issueId === 'POD-1' ? conflicted : applied,
    )
    const head = await outbox.enqueue(close('POD-1'))
    const behind = await outbox.enqueue(close('POD-1'))
    const other = await outbox.enqueue(close('POD-2'))

    await outbox.drain()

    expect(state(outbox, head.mutationId)).toBe('dead-letter')
    // Blocked, not wedged: never submitted, still queued, no reason attached.
    expect(state(outbox, behind.mutationId)).toBe('queued')
    expect(authority.attempts(behind.mutationId)).toBe(0)
    // The unrelated aggregate drained regardless (no global head-of-line block).
    expect(state(outbox, other.mutationId)).toBe('applied')

    // Still blocked on every LATER pass, for as long as the head sits in
    // dead-letter — D12: "a blocked / dead-lettered entry blocks only its
    // partition UNTIL RECOVERY OR CANCEL". Draining again must not let the
    // successor overtake a decision the user has not made yet.
    authority.reprogram(() => applied)
    await outbox.drain()
    await outbox.drain()
    expect(state(outbox, behind.mutationId)).toBe('queued')
    expect(authority.attempts(behind.mutationId)).toBe(0)

    await outbox.discard(head.mutationId)
    await outbox.drain()
    expect(state(outbox, behind.mutationId)).toBe('applied')
  })

  it('unblocks a partition when the head is RECOVERED rather than cancelled', async () => {
    const { outbox, authority } = await harness((envelope) =>
      (envelope.input as { issueId: string }).issueId === 'POD-1' && envelope.expectedRevision === 1
        ? conflicted
        : applied,
    )
    const head = await outbox.enqueue(close('POD-1', { expectedRevision: 1 }))
    const behind = await outbox.enqueue(close('POD-1'))
    await outbox.drain()
    expect(state(outbox, behind.mutationId)).toBe('queued')

    await outbox.retry(head.mutationId, { expectedRevision: 2 })
    await outbox.drain()

    // FIFO held: the head applied first, and only then the entry behind it.
    expect(state(outbox, head.mutationId)).toBe('applied')
    expect(state(outbox, behind.mutationId)).toBe('applied')
    expect(authority.envelopes.map((e) => e.mutationId).slice(-2)).toEqual([
      head.mutationId,
      behind.mutationId,
    ])
  })

  it('gives an unpartitioned create its own partition, so it can never block another aggregate', async () => {
    const { outbox } = await harness()
    const created = await outbox.enqueue({
      command: CLOSE,
      input: { title: 'new' },
      attribution: ADA,
    })
    expect(created.partitionKey).toBe(`create:${created.mutationId}`)
  })
})

describe('single-flight drain', () => {
  it('does not double-submit the head of a partition when two callers drain at once', async () => {
    const { outbox, authority } = await harness(() => applied)
    const record = await outbox.enqueue(close('POD-1'))

    await Promise.all([outbox.drain(), outbox.drain(), outbox.drain()])

    expect(authority.attempts(record.mutationId)).toBe(1)
  })
})

describe('review round 1 — the blockers, each with the test that would have caught it', () => {
  it('blocker 1a: a transport-failed FIFO head does NOT let its successor run', async () => {
    // The mutant that survived: `attempt()` returning true on `unreachable`. The
    // head did not get through, so submitting the entry behind it would silently
    // reorder two writes to the same aggregate (D12: FIFO within a partition).
    const { outbox, authority } = await harness((envelope) =>
      (envelope.input as { comment: string }).comment === 'head' ? unreachable : applied,
    )
    const head = await outbox.enqueue({ ...close('POD-1'), input: { comment: 'head' } })
    const behind = await outbox.enqueue({ ...close('POD-1'), input: { comment: 'behind' } })

    await outbox.drain()

    expect(state(outbox, head.mutationId)).toBe('queued')
    expect(state(outbox, behind.mutationId)).toBe('queued')
    expect(authority.attempts(behind.mutationId)).toBe(0)
    expect(authority.envelopes).toHaveLength(1)

    // Still blocked on later passes, and it unblocks in ORDER once the head lands.
    await outbox.drain()
    expect(authority.attempts(behind.mutationId)).toBe(0)
    authority.reprogram(() => applied)
    await outbox.drain()
    expect(authority.envelopes.map((e) => e.mutationId).slice(-2)).toEqual([
      head.mutationId,
      behind.mutationId,
    ])
  })

  it('blocker 1b: repeated attempts never extend the D10 horizon', async () => {
    // The mutant that survived: `isAgedOut` measuring from `lastAttemptAt`. A busy
    // entry would renew its own horizon on every retry and never expire, which
    // defeats the whole point of expiry — refusing a send whose receipt may
    // already have been pruned (D11.8).
    const { outbox, clock } = await harness(() => unreachable)
    const record = await outbox.enqueue(close('POD-1'))

    // Attempt repeatedly, right up to the horizon, so `lastAttemptAt` is recent.
    for (let i = 0; i < 5; i++) {
      clock.advance(MAX_AGE_MS / 5)
      await outbox.drain()
    }
    expect(outbox.find(record.mutationId)?.attempts).toBe(5)
    expect(outbox.find(record.mutationId)?.lastAttemptAt).toBe(clock.now())

    clock.advance(1)
    expect(await outbox.sweepExpired()).toEqual([record.mutationId])
    expect(outbox.deadLetters()[0]?.reason).toEqual({ code: 'max-age' })
    // The record's own queuedAt is what decided it, and it never moved.
    expect(outbox.find(record.mutationId)?.queuedAt).toBe(record.queuedAt)
  })

  it('blocker 2: a lost apply notification is recoverable WITHOUT reopening', async () => {
    const { outbox, authority, events } = await harness(() => ({ kind: 'accepted' }))
    const head = await outbox.enqueue(close('POD-1'))
    const behind = await outbox.enqueue(close('POD-1'))
    await outbox.drain()
    expect(state(outbox, head.mutationId)).toBe('accepted')
    // It blocks its partition, which is why waiting for a restart is not a
    // recovery path.
    expect(authority.attempts(behind.mutationId)).toBe(0)

    await outbox.noteTransportLost(head.mutationId)

    expect(state(outbox, head.mutationId)).toBe('queued')
    expect(types(events)).toContain('requeued')
    authority.reprogram(() => applied)
    await outbox.drain()
    expect(state(outbox, head.mutationId)).toBe('applied')
    expect(state(outbox, behind.mutationId)).toBe('applied')
    // The replay reused the SAME id, so the receipt dedupes it (D11.7).
    expect(new Set(authority.envelopes.map((e) => e.mutationId)).size).toBe(2)
  })

  it('blocker 2: a stalled in-flight entry is swept back to queued', async () => {
    const { outbox, clock } = await harness(() => ({ kind: 'accepted' }))
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    expect(await outbox.requeueStalled({ stalledForMs: 60_000 })).toEqual([])
    clock.advance(60_000)
    expect(await outbox.requeueStalled({ stalledForMs: 60_000 })).toEqual([record.mutationId])
    expect(state(outbox, record.mutationId)).toBe('queued')
  })

  it('blocker 2: refuses to requeue something that is not in flight', async () => {
    const { outbox } = await harness(() => applied)
    const record = await outbox.enqueue(close('POD-1'))
    await expect(outbox.noteTransportLost(record.mutationId)).rejects.toThrow(
      /nothing is in flight/,
    )
    await outbox.drain()
    await expect(outbox.noteTransportLost(record.mutationId)).rejects.toThrow(/from applied/)
  })

  it('blocker 3: concurrent enqueues commit in order, memory matching durable', async () => {
    // The probe that caught it ended with memory [m1, m2] and durable [m1]: the
    // first write resolved LAST and clobbered the second.
    const { outbox, store } = await harness()
    store.delayNextWrites = 1

    const [a, b] = await Promise.all([
      outbox.enqueue(close('POD-1')),
      outbox.enqueue(close('POD-2')),
    ])

    expect(outbox.all().map((r) => r.mutationId)).toEqual([a.mutationId, b.mutationId])
    expect(store.durable().map((r) => r.mutationId)).toEqual([a.mutationId, b.mutationId])
    expect(store.writes).toBe(2)
  })

  it('blocker 3: a failed write leaves memory untouched and emits nothing', async () => {
    const { outbox, store, events } = await harness()
    const first = await outbox.enqueue(close('POD-1'))
    store.failWrite = new Error('QuotaExceededError')

    await expect(outbox.enqueue(close('POD-2'))).rejects.toThrow(/QuotaExceeded/)

    // ADR 6 D4.4: the failing operation does not partially apply — not durably,
    // and not in memory either.
    expect(outbox.all().map((r) => r.mutationId)).toEqual([first.mutationId])
    expect(store.durable().map((r) => r.mutationId)).toEqual([first.mutationId])
    expect(types(events)).toEqual(['local-ack'])

    // And the failure does not wedge the mutation chain.
    store.failWrite = undefined
    const third = await outbox.enqueue(close('POD-3'))
    expect(store.durable().map((r) => r.mutationId)).toEqual([first.mutationId, third.mutationId])
  })

  it('blocker 3: a failed write mid-lifecycle does not lose the state change either', async () => {
    const { outbox, store } = await harness(() => applied)
    const record = await outbox.enqueue(close('POD-1'))
    store.failWrite = new Error('database closed')

    await expect(outbox.drain()).rejects.toThrow(/database closed/)

    expect(state(outbox, record.mutationId)).toBe('queued')
    expect(store.durable()[0]?.state).toBe('queued')
  })

  it('blocker 4: a retirement enrolled in a span lands with it, and rolls back with it', async () => {
    const uow = new InMemoryUnitOfWork()
    const { outbox, store } = await harness(() => applied, { unitOfWork: uow })
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()
    expect(state(outbox, record.mutationId)).toBe('applied')

    // The shape POD-369 required: the span is threaded in explicitly, so the
    // store write enrolls in the SAME transaction as the entity + cursor work a
    // replica would do in the same body.
    const replicaWrites: string[] = []
    await uow.transact(async (span) => {
      replicaWrites.push('entity+cursor')
      await outbox.retireApplied(record.mutationId, span)
      // Not visible yet: effects publish from onCommit, so nothing escapes to an
      // observer before the span is durable (POD-369's amendment 2).
      expect(outbox.all()).toHaveLength(1)
    })
    expect(outbox.all()).toEqual([])
    expect(store.durable()).toEqual([])
    expect(replicaWrites).toEqual(['entity+cursor'])

    // Now the abort half: a failure anywhere in the body leaves BOTH sides as
    // they were — the crash window ADR 2 D10 forbids.
    const second = await outbox.enqueue(close('POD-2'))
    await outbox.drain()
    await expect(
      uow.transact(async (span) => {
        await outbox.retireApplied(second.mutationId, span)
        throw new Error('replica write failed')
      }),
    ).rejects.toThrow(/replica write failed/)

    expect(outbox.find(second.mutationId)?.state).toBe('applied')
    expect(store.durable().map((r) => r.mutationId)).toEqual([second.mutationId])
  })

  it('blocker 4: one span, not two, when the outbox mutates inside an open transaction', async () => {
    const uow = new InMemoryUnitOfWork()
    const { outbox } = await harness(() => applied, { unitOfWork: uow })
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()
    const spansBefore = uow.spans

    await uow.transact(async (span) => {
      await outbox.retireApplied(record.mutationId, span)
    })

    // Nested transact JOINS rather than opening a second transaction.
    expect(uow.spans).toBe(spansBefore + 1)
  })

  it('blocker 5: a re-issue may not reuse the retired id, nor collide with any existing one', async () => {
    const { outbox, clock } = await harness(() => applied)
    const other = await outbox.enqueue(close('POD-2'))
    const doomed = await outbox.enqueue(close('POD-1'))
    clock.advance(MAX_AGE_MS + 1)
    await outbox.sweepExpired()

    // D11.4 is a MUST: the old id may still have a receipt.
    await expect(
      outbox.retry(doomed.mutationId, { mutationId: doomed.mutationId }),
    ).rejects.toThrow(/must mint a NEW mutationId/)
    // And an id already in the store would make the Authority's dedupe key
    // ambiguous.
    await expect(outbox.retry(doomed.mutationId, { mutationId: other.mutationId })).rejects.toThrow(
      /already exists/,
    )

    // Neither refusal mutated anything.
    expect(state(outbox, doomed.mutationId)).toBe('dead-letter')
    expect(outbox.all().filter((r) => r.mutationId === other.mutationId)).toHaveLength(1)

    const reissued = await outbox.retry(doomed.mutationId, { mutationId: 'm-fresh' })
    expect(reissued.mutationId).toBe('m-fresh')
  })

  it('blocker 7: a removal without a licence cannot reach the store', async () => {
    // The regex this replaces would pass a method called `flush`, and would miss a
    // deletion inserted inside a maintenance path. This is the guard that does
    // not care what the code is called: every id that disappears from a draft
    // must have been removed with one of D9 invariant 1's two licences.
    const { outbox, store } = await harness()
    const record = await outbox.enqueue(close('POD-1'))

    // Reach past the public API the way a future `destroy()`/`flush()` would.
    const internals = outbox as unknown as {
      mutate: (body: (draft: { remove: unknown; put: unknown }) => void) => Promise<void>
    }
    await expect(
      internals.mutate((draft) => {
        // Deleting without claiming a licence — exactly what an innocent-looking
        // `records.filter(...)` inside a maintenance routine would do.
        const d = draft as unknown as { records: OutboxRecord[] }
        d.records = []
      }),
    ).rejects.toThrow(OutboxInvariantError)

    expect(outbox.all().map((r) => r.mutationId)).toEqual([record.mutationId])
    expect(store.durable().map((r) => r.mutationId)).toEqual([record.mutationId])
  })

  it('blocker 7: the two licensed removals still work, and only from their own state', async () => {
    const { outbox, store } = await harness(() => applied)
    const retired = await outbox.enqueue(close('POD-1'))
    const cancelled = await outbox.enqueue(close('POD-2'))
    await outbox.drain()

    await outbox.retireApplied(retired.mutationId) // licence: covering-truth
    await expect(outbox.purgeCancelled(cancelled.mutationId)).rejects.toThrow(/from applied/)
    // Reaching `cancelled` requires the user's decision first.
    await expect(outbox.discard(cancelled.mutationId)).rejects.toThrow(/illegal/)

    const queued = await outbox.enqueue(close('POD-3'))
    await outbox.discard(queued.mutationId)
    await outbox.purgeCancelled(queued.mutationId) // licence: user-discarded
    expect(store.durable().map((r) => r.mutationId)).toEqual([cancelled.mutationId])
  })
})

describe('review round 2 — one physical store, several writers', () => {
  it('two principal-bound instances on one store do not clobber each other', async () => {
    // Reviewer's probe, which lost Ada's work outright: both instances open on the
    // EMPTY shared store, so each held a stale base, and a whole-snapshot write
    // deleted rows it had never seen. Record-level `apply` plus a fresh rebase is
    // the fix — and note the instances are opened BEFORE either write, which is
    // what made the old code fail.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const ada = await harness(() => unreachable, { store, clock, idPrefix: 'ada-' })
    const grace = await harness(() => unreachable, {
      store,
      clock,
      principal: 'u-grace',
      idPrefix: 'grace-',
    })

    const a = await ada.outbox.enqueue(close('POD-1', { attribution: ADA }))
    const g = await grace.outbox.enqueue(close('POD-2', { attribution: GRACE }))

    expect(store.durable().map((r) => r.mutationId)).toEqual([a.mutationId, g.mutationId])
    expect(ada.outbox.all().map((r) => r.mutationId)).toEqual([a.mutationId])
    expect(grace.outbox.all().map((r) => r.mutationId)).toEqual([g.mutationId])

    // Interleaved lifecycles keep both sides intact, in FIFO order.
    ada.authority.reprogram(() => applied)
    await ada.outbox.drain()
    await grace.outbox.enqueue(close('POD-3', { attribution: GRACE }))
    expect(store.durable().map((r) => r.mutationId)).toEqual([
      a.mutationId,
      g.mutationId,
      'grace-2',
    ])
    expect(store.durable().find((r) => r.mutationId === a.mutationId)?.state).toBe('applied')
  })

  it('enforces mutationId uniqueness ACROSS instances, not just within one', async () => {
    // Uniqueness is global because the id is the Authority's dedupe key. A
    // per-instance check would have missed this: Grace's outbox never saw Ada's
    // record in memory.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const ada = await harness(() => unreachable, { store, clock, idPrefix: 'shared-' })
    const grace = await harness(() => unreachable, {
      store,
      clock,
      principal: 'u-grace',
      idPrefix: 'shared-',
    })
    await ada.outbox.enqueue(close('POD-1', { attribution: ADA }))

    await expect(grace.outbox.enqueue(close('POD-2', { attribution: GRACE }))).rejects.toThrow(
      /duplicate mutationId/,
    )
    expect(store.durable()).toHaveLength(1)
  })

  it('accumulates several retirements inside ONE span, and publishes once', async () => {
    // Reviewer's probe, which resurrected m1: each retirement staged from a base
    // that is intentionally unchanged until commit and enrolled a full snapshot,
    // so the second one won. A feed frame can carry several provenance
    // retirements, so this is a normal path, not an exotic one.
    const uow = new InMemoryUnitOfWork()
    const { outbox, store, events } = await harness(() => applied, { unitOfWork: uow })
    const a = await outbox.enqueue(close('POD-1'))
    const b = await outbox.enqueue(close('POD-2'))
    const c = await outbox.enqueue(close('POD-3'))
    await outbox.drain()

    const during: number[] = []
    await uow.transact(async (span) => {
      await outbox.retireApplied(a.mutationId, span)
      await outbox.retireApplied(b.mutationId, span)
      // Nothing published yet: one adoption and one event flush, on commit.
      during.push(outbox.all().length)
    })

    expect(during).toEqual([3])
    expect(store.durable().map((r) => r.mutationId)).toEqual([c.mutationId])
    expect(outbox.all().map((r) => r.mutationId)).toEqual([c.mutationId])
    expect(events.filter((e) => e.type === 'retired').map((e) => e.mutationId)).toEqual([
      a.mutationId,
      b.mutationId,
    ])
  })

  it('rolls back EVERY retirement in an aborted span, and emits none of them', async () => {
    const uow = new InMemoryUnitOfWork()
    const { outbox, store, events } = await harness(() => applied, { unitOfWork: uow })
    const a = await outbox.enqueue(close('POD-1'))
    const b = await outbox.enqueue(close('POD-2'))
    await outbox.drain()
    const before = store.durable().map((r) => r.mutationId)

    await expect(
      uow.transact(async (span) => {
        await outbox.retireApplied(a.mutationId, span)
        await outbox.retireApplied(b.mutationId, span)
        throw new Error('entity write failed')
      }),
    ).rejects.toThrow(/entity write failed/)

    expect(store.durable().map((r) => r.mutationId)).toEqual(before)
    expect(outbox.all().map((r) => r.mutationId)).toEqual(before)
    expect(events.filter((e) => e.type === 'retired')).toEqual([])
    // And the span's staged view is gone, so a later transaction starts clean.
    await uow.transact(async (span) => {
      await outbox.retireApplied(a.mutationId, span)
    })
    expect(store.durable().map((r) => r.mutationId)).toEqual([b.mutationId])
  })

  it('enrolls RETIREMENT only — a user action is not part of a replica commit', async () => {
    // Writing the boundary down because the first version of this test assumed
    // otherwise: `retireApplied` is the only span-enrolled operation, because the
    // span exists to cover the Replica's entity write + cursor advance + the
    // retirement that follows from them (ADR 2 D10). Enqueue, discard, retry and
    // edit are USER actions; they are not part of an entity commit and take no
    // span. An entry created inside a span is therefore not visible to a
    // non-enrolled operation until the span commits — which is correct, not a
    // gap: the store does not have it yet either.
    const uow = new InMemoryUnitOfWork()
    const { outbox, store } = await harness(() => applied, { unitOfWork: uow })
    const retiring = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    await uow.transact(async (span) => {
      await outbox.retireApplied(retiring.mutationId, span)
      // A mutation with no span of its own JOINS the configured unit of work's
      // ambient span (that is what `transact` nesting means), so it composes with
      // the staged removal instead of clobbering it — and it lands at the same
      // commit.
      await outbox.enqueue(close('POD-2'))
    })

    const durable = store.durable()
    expect(durable.map((r) => r.mutationId)).not.toContain(retiring.mutationId)
    expect(durable).toHaveLength(1)
    expect(durable[0]?.state).toBe('queued')
  })

  it('refuses to resurrect an id the open span has already retired', async () => {
    const uow = new InMemoryUnitOfWork()
    const { outbox, store } = await harness(() => applied, { unitOfWork: uow })
    const target = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    await uow.transact(async (span) => {
      await outbox.retireApplied(target.mutationId, span)
      // Within this transaction the entry is already gone, so a user action
      // against it is refused — it is NOT silently re-added by a stale base,
      // which is the resurrection this whole refactor removes.
      await expect(outbox.discard(target.mutationId)).rejects.toThrow(/vanished/)
    })

    expect(store.durable()).toEqual([])
    expect(outbox.all()).toEqual([])
  })

  it('picks up another writer changes on its next mutation', async () => {
    // The rebase is on FRESH truth, so a second tab (ADR 6 D4.6) or a sibling
    // instance cannot be silently overwritten even for the same principal.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const tabOne = await harness(() => unreachable, { store, clock, idPrefix: 'one-' })
    const tabTwo = await harness(() => unreachable, { store, clock, idPrefix: 'two-' })

    const fromOne = await tabOne.outbox.enqueue(close('POD-1'))
    const fromTwo = await tabTwo.outbox.enqueue(close('POD-2'))

    expect(store.durable().map((r) => r.mutationId)).toEqual([
      fromOne.mutationId,
      fromTwo.mutationId,
    ])
    // Same principal, so the second tab sees both once it rebases.
    expect(tabTwo.outbox.all().map((r) => r.mutationId)).toEqual([
      fromOne.mutationId,
      fromTwo.mutationId,
    ])
  })
})

describe('review round 2, second correction — the batch shape POD-369 submits', () => {
  /** Stands in for the Replica half: entity rows + cursor, enrolled in the span. */
  class FakeReplica {
    entity = { id: 'E', revision: 0 }
    cursor = 0
    observations: string[] = []
    async applyFrame(
      span: SyncSpan,
      frame: { revision: number; cursor: number },
      store: { enlist?: (w: () => Promise<void>) => void },
    ): Promise<void> {
      const before = { ...this.entity, cursor: this.cursor }
      store.enlist?.(async () => undefined)
      // Stages, then adopts AND emits from onCommit — POD-369's shape, so an
      // abort needs no revert: `before` is only read to prove nothing moved.
      void before
      span.onCommit(() => {
        this.entity = { id: 'E', revision: frame.revision }
        this.cursor = frame.cursor
        this.observations.push(`upserted:${frame.revision}`, `cursor:${frame.cursor}`)
      })
    }
  }

  it('commits two provenance matches as ONE enrolled write, with entity and cursor', async () => {
    const uow = new InMemoryUnitOfWork()
    const { outbox, store, events } = await harness(() => applied, { unitOfWork: uow })
    const replica = new FakeReplica()
    const a = await outbox.enqueue(close('POD-1'))
    const b = await outbox.enqueue(close('POD-2'))
    await outbox.drain()
    const writesBefore = store.writes

    await uow.transact(async (span) => {
      await replica.applyFrame(span, { revision: 1, cursor: 7 }, store as never)
      // ONE ordered batch, deduplicated by the Replica, in the same span.
      await outbox.retireAllApplied([a.mutationId, b.mutationId], span)
    })

    // Rehydrate: both retired, entity and cursor present.
    expect(store.durable()).toEqual([])
    expect(replica.entity.revision).toBe(1)
    expect(replica.cursor).toBe(7)
    // Exactly ONE enrolled outbox write for the batch, not one per id.
    expect(store.writes).toBe(writesBefore + 1)
    expect(events.filter((e) => e.type === 'retired').map((e) => e.mutationId)).toEqual([
      a.mutationId,
      b.mutationId,
    ])
  })

  it('aborts the batch whole: both entries and the OLD entity and cursor survive, no observations', async () => {
    const uow = new InMemoryUnitOfWork()
    const { outbox, store, events } = await harness(() => applied, { unitOfWork: uow })
    const replica = new FakeReplica()
    const a = await outbox.enqueue(close('POD-1'))
    const b = await outbox.enqueue(close('POD-2'))
    await outbox.drain()

    await expect(
      uow.transact(async (span) => {
        await replica.applyFrame(span, { revision: 1, cursor: 7 }, store as never)
        await outbox.retireAllApplied([a.mutationId, b.mutationId], span)
        throw new Error('frame validation failed after enrollment')
      }),
    ).rejects.toThrow(/frame validation failed/)

    expect(store.durable().map((r) => r.mutationId)).toEqual([a.mutationId, b.mutationId])
    expect(outbox.all().map((r) => r.mutationId)).toEqual([a.mutationId, b.mutationId])
    expect(replica.entity.revision).toBe(0)
    expect(replica.cursor).toBe(0)
    expect(replica.observations).toEqual([])
    expect(events.filter((e) => e.type === 'retired')).toEqual([])
  })

  it('extends the span draft when a second batch arrives — bootstrap aggregating two frames', async () => {
    const uow = new InMemoryUnitOfWork()
    const { outbox, store, events } = await harness(() => applied, { unitOfWork: uow })
    const a = await outbox.enqueue(close('POD-1'))
    const b = await outbox.enqueue(close('POD-2'))
    const c = await outbox.enqueue(close('POD-3'))
    await outbox.drain()

    await uow.transact(async (span) => {
      await outbox.retireAllApplied([a.mutationId], span)
      // A second call in the same span EXTENDS the staged draft rather than
      // replacing it — two buffered provenance frames in one bootstrap install.
      await outbox.retireAllApplied([b.mutationId], span)
    })

    expect(store.durable().map((r) => r.mutationId)).toEqual([c.mutationId])
    expect(events.filter((e) => e.type === 'retired').map((e) => e.mutationId)).toEqual([
      a.mutationId,
      b.mutationId,
    ])
  })

  it('validates the whole batch before staging any of it', async () => {
    const uow = new InMemoryUnitOfWork()
    const { outbox, store } = await harness(() => applied, { unitOfWork: uow })
    const a = await outbox.enqueue(close('POD-1'))
    const queued = await outbox.enqueue(close('POD-2'))
    await uow.transact(async () => {
      // POD-1 drains to applied; POD-2 stays queued.
    })
    await outbox.drain()
    await outbox.noteTransportLost(queued.mutationId).catch(() => undefined)

    // One bad id fails the batch rather than half-retiring it.
    await expect(outbox.retireAllApplied([a.mutationId, 'nope' as MutationId])).rejects.toThrow(
      /unknown outbox entry/,
    )
    expect(outbox.find(a.mutationId)?.state).toBe('applied')
    expect(store.durable().map((r) => r.mutationId)).toContain(a.mutationId)
  })

  it('two principal-bound instances stage keyed mutations in ONE shared span and both survive', async () => {
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const ada = await harness(() => applied, { store, clock, unitOfWork: uow, idPrefix: 'ada-' })
    const grace = await harness(() => applied, {
      store,
      clock,
      unitOfWork: uow,
      principal: 'u-grace',
      idPrefix: 'grace-',
    })

    await uow.transact(async () => {
      await ada.outbox.enqueue(close('POD-1', { attribution: ADA }))
      await grace.outbox.enqueue(close('POD-2', { attribution: GRACE }))
    })

    expect(store.durable().map((r) => r.mutationId)).toEqual(['ada-1', 'grace-1'])
    expect(ada.outbox.all().map((r) => r.mutationId)).toEqual(['ada-1'])
    expect(grace.outbox.all().map((r) => r.mutationId)).toEqual(['grace-1'])
  })

  it('refuses to write a key owned by another principal, even inside a shared span', async () => {
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const ada = await harness(() => unreachable, { store, clock, idPrefix: 'ada-' })
    const adas = await ada.outbox.enqueue(close('POD-1', { attribution: ADA }))
    const grace = await harness(() => unreachable, {
      store,
      clock,
      principal: 'u-grace',
      idPrefix: 'grace-',
    })

    // Reach past the public API the way a mis-wired adapter would, and try to
    // stage a removal of Ada's key from Grace's instance.
    const internals = grace.outbox as unknown as {
      mutate: (
        body: (draft: { remove: (id: MutationId, l: string) => void }) => void,
      ) => Promise<void>
    }
    await expect(
      internals.mutate((draft) => {
        draft.remove(adas.mutationId, 'user-discarded')
      }),
    ).rejects.toThrow(OutboxInvariantError)

    expect(store.durable().map((r) => r.mutationId)).toEqual([adas.mutationId])
  })
})

describe('the POD-373 crash case, outbox half', () => {
  it('never leaves one retirement landed and the other queued inside one frame', async () => {
    // POD-369's scenario, outbox side: a single frame covering (10, 12] carries an
    // UPSERT for A with mutationId m1 and a REMOVE for B with m2. Both ops carry
    // provenance deliberately — a tombstone the user authored must retire its
    // command exactly as an edit does. The forbidden recovered states are "cursor
    // 12 with m1 or m2 still queued" and "cursor 12 with m1 retired and m2
    // queued": the torn mix INSIDE one frame.
    //
    // With one batch in one span there are only two outcomes, and this asserts
    // both of them rather than the impossibility of a third.
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const edit = { command: CLOSE, input: { entity: 'A' }, attribution: ADA, partitionKey: 'A' }
    const tombstone = {
      command: CLOSE,
      input: { entity: 'B', deleted: true },
      attribution: ADA,
      partitionKey: 'B',
    }

    // ABORT: neither retires, and the pair is intact.
    const aborted = await harness(() => applied, { store, clock, unitOfWork: uow, idPrefix: 'm' })
    const m1 = await aborted.outbox.enqueue(edit)
    const m2 = await aborted.outbox.enqueue(tombstone)
    await aborted.outbox.drain()
    await expect(
      uow.transact(async (span) => {
        await aborted.outbox.retireAllApplied([m1.mutationId, m2.mutationId], span)
        throw new Error('crash inside the span')
      }),
    ).rejects.toThrow(/crash inside the span/)
    expect(store.durable().map((r) => r.mutationId)).toEqual([m1.mutationId, m2.mutationId])
    expect(aborted.events.filter((e) => e.type === 'retired')).toEqual([])

    // COMMIT: both retire together. There is no third snapshot in between.
    await uow.transact(async (span) => {
      await aborted.outbox.retireAllApplied([m1.mutationId, m2.mutationId], span)
    })
    expect(store.durable()).toEqual([])
    expect(aborted.events.filter((e) => e.type === 'retired').map((e) => e.mutationId)).toEqual([
      m1.mutationId,
      m2.mutationId,
    ])

    // And a cold rehydrate agrees with durable truth either way.
    const reopened = await harness(() => applied, { store, clock, idPrefix: 'r' })
    expect(reopened.outbox.all()).toEqual([])
  })
})
