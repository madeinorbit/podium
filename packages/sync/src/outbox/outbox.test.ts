import { asSessionId, type MutationId } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  type EnqueueRequest,
  envelopeFor,
  Outbox,
  OutboxInvariantError,
  OutboxUsageError,
} from './outbox'
import type { OutboxEnvelope, OutboxEvent, OutboxSubmitOutcome, SyncSpan } from './ports'
import { SyncCommitConflict } from './ports'
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
  it('is FIFO within a partition', async () => {
    const order: string[] = []
    const { outbox } = await harness((envelope) => {
      order.push((envelope.input as { seq: string }).seq)
      return applied
    })
    await outbox.enqueue({ ...close('POD-1'), input: { seq: 'first' } })
    await outbox.enqueue({ ...close('POD-1'), input: { seq: 'second' } })
    await outbox.drain()

    expect(order).toEqual(['first', 'second'])
  })

  it('drains partitions CONCURRENTLY: a slow partition does not delay another', async () => {
    // This test used to share a name with the FIFO one above and assert only that
    // the second partition's entry appeared — which a strictly SEQUENTIAL drain
    // also satisfies. Mutating `Promise.all` into a sequential loop passed the whole
    // suite, so the name claimed something nothing checked (coordinator broadcast on
    // tests that assert their own name).
    //
    // The property that actually matters is independence, so that is what is
    // asserted, by ORDERING rather than timing: POD-1's submit hangs until the test
    // releases it, and POD-2 must still be submitted meanwhile. A sequential drain
    // can never reach POD-2, so it fails on a behavioural mismatch rather than a
    // stall — the drain promise is simply still pending when we look.
    const started: string[] = []
    let releaseSlow = (): void => {}
    const slowHeld = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const { outbox } = await harness(async (envelope) => {
      const id = (envelope.input as { issueId: string }).issueId
      started.push(id)
      if (id === 'POD-1') await slowHeld
      return applied
    })
    await outbox.enqueue(close('POD-1'))
    await outbox.enqueue(close('POD-2'))

    const draining = outbox.drain()
    // Let the event loop turn over as far as it will while POD-1 is stuck.
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(started).toContain('POD-2')
    expect(started).toEqual(['POD-1', 'POD-2'])

    releaseSlow()
    await draining
    expect(outbox.all().map((r) => r.state)).toEqual(['applied', 'applied'])
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
    const { outbox, store } = await harness(() => applied, {})
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
    const { outbox } = await harness(() => applied, {})
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
    const { outbox, store, events } = await harness(() => applied, {})
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
    const { outbox, store, events } = await harness(() => applied, {})
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

  it('enrolls RETIREMENT only: an aborted span keeps the user enqueue and undoes the retirement', async () => {
    // The real rule, asserted by ABORTING the span. `retireApplied` is the only
    // span-enrolled operation, because the span exists to cover the Replica's entity
    // write + cursor advance + the retirement that follows (ADR 2 D10). Enqueue,
    // discard, retry and edit are USER actions: they take no span and do NOT join one
    // that happens to be open, so they commit independently and survive its abort.
    //
    // This test previously claimed the enqueue JOINED the open span, which was only
    // ever true via an ambient current-span flag — removed as unsafe, because it
    // could absorb an unrelated caller's write and lose it on abort. Aborting is what
    // makes the difference between the two visible.
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const { outbox, events } = await harness(() => applied, { store, clock })
    const retiring = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    let independent: OutboxRecord | undefined
    await expect(
      uow.transact(async (span) => {
        await outbox.retireApplied(retiring.mutationId, span)
        independent = await outbox.enqueue(close('POD-2'))
        // Already durable, before this transaction has decided anything.
        expect(store.durable().map((r) => r.mutationId)).toContain(independent.mutationId)
        throw new Error('replica frame rejected after staging the retirement')
      }),
    ).rejects.toThrow(/replica frame rejected/)

    // The user's enqueue SURVIVES the abort; the enrolled retirement does NOT.
    expect(
      store
        .durable()
        .map((r) => r.mutationId)
        .sort(),
    ).toEqual([retiring.mutationId, independent?.mutationId].sort())
    expect(outbox.find(retiring.mutationId)?.state).toBe('applied')
    expect(types(events)).toContain('local-ack')
    expect(types(events)).not.toContain('retired')
  })

  it('refuses to retire an id the same span has already retired', async () => {
    // Within one span the staged view is authoritative for that span, so a second
    // batch cannot retire what the first already removed. This used to be written
    // with `discard()` inside the span body, which only worked because an ambient
    // "current span" silently absorbed unrelated calls — a defect, now removed, so
    // the property is asserted through the seam that actually threads a span.
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const { outbox } = await harness(() => applied, { store, clock })
    const target = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    await expect(
      uow.transact(async (span) => {
        await outbox.retireAllApplied([target.mutationId], span)
        await outbox.retireAllApplied([target.mutationId], span)
      }),
    ).rejects.toThrow(/unknown outbox entry/)

    // The failed transaction left the entry exactly as it was.
    expect(store.durable().map((r) => [r.mutationId, r.state])).toEqual([
      [target.mutationId, 'applied'],
    ])
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
    const { outbox, store, events } = await harness(() => applied, {})
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
    const { outbox, store, events } = await harness(() => applied, {})
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
    const { outbox, store, events } = await harness(() => applied, {})
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
    const { outbox, store } = await harness(() => applied, {})
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

  it('two principal-bound instances RETIRE into one shared span and both survive', async () => {
    // This test used to enqueue from both instances inside an open transaction and
    // claim they shared it. Once the ambient join was removed (round 6) that stopped
    // being true — enqueue is a user action and takes no span, so both writes were
    // independent and the name was a lie, introduced by my own fix. Rewritten to
    // share a span through the seam that actually threads one: retirement.
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const ada = await harness(() => applied, { store, clock, idPrefix: 'ada-' })
    const grace = await harness(() => applied, {
      store,
      clock,
      principal: 'u-grace',
      idPrefix: 'grace-',
    })
    const adas = await ada.outbox.enqueue(close('POD-1', { attribution: ADA }))
    const graces = await grace.outbox.enqueue(close('POD-2', { attribution: GRACE }))
    const keep = await ada.outbox.enqueue(close('POD-3', { attribution: ADA }))
    await ada.outbox.drain()
    await grace.outbox.drain()
    const writesBefore = store.writes

    await uow.transact(async (span) => {
      await ada.outbox.retireAllApplied([adas.mutationId], span)
      await grace.outbox.retireAllApplied([graces.mutationId], span)
    })

    // Both retirements landed, and neither instance's staging replaced the other's:
    // the span accumulated two participants' keyed deltas.
    expect(store.durable().map((r) => r.mutationId)).toEqual([keep.mutationId])
    expect(ada.outbox.all().map((r) => r.mutationId)).toEqual([keep.mutationId])
    expect(grace.outbox.all()).toEqual([])
    // ONE physical write for the whole transaction, not one per participant: both
    // instances stage into the same store's per-span draft, so the span publishes
    // once. (I asserted two here first and the count corrected me — the accumulating
    // draft is doing more than I credited it with.)
    expect(store.writes).toBe(writesBefore + 1)
  })

  it('aborts a shared span for BOTH participants, retiring neither', async () => {
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const ada = await harness(() => applied, { store, clock, idPrefix: 'ada-' })
    const grace = await harness(() => applied, {
      store,
      clock,
      principal: 'u-grace',
      idPrefix: 'grace-',
    })
    const adas = await ada.outbox.enqueue(close('POD-1', { attribution: ADA }))
    const graces = await grace.outbox.enqueue(close('POD-2', { attribution: GRACE }))
    await ada.outbox.drain()
    await grace.outbox.drain()
    const before = JSON.stringify(store.durable())

    await expect(
      uow.transact(async (span) => {
        await ada.outbox.retireAllApplied([adas.mutationId], span)
        await grace.outbox.retireAllApplied([graces.mutationId], span)
        throw new Error('shared span aborts')
      }),
    ).rejects.toThrow(/shared span aborts/)

    expect(JSON.stringify(store.durable())).toBe(before)
    expect(ada.outbox.all().map((r) => r.mutationId)).toEqual([adas.mutationId])
    expect(grace.outbox.all().map((r) => r.mutationId)).toEqual([graces.mutationId])
    expect(types(ada.events)).not.toContain('retired')
    expect(types(grace.events)).not.toContain('retired')
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
    const aborted = await harness(() => applied, { store, clock, idPrefix: 'm' })
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

describe('review round 3 — concurrent writers, deterministically', () => {
  it('two instances racing the SAME explicit mutationId: one wins, one is refused', async () => {
    // Reviewer's probe: both promises fulfilled and durable storage kept Grace's
    // row, silently replacing Ada's locally-acked intent. The barrier makes the
    // interleaving deterministic — both callers read and stage, THEN both apply —
    // which is exactly the window per-instance serialization cannot close.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const ada = await harness(() => unreachable, { store, clock })
    const grace = await harness(() => unreachable, { store, clock, principal: 'u-grace' })
    const collide = 'm-collide' as MutationId

    const release = store.holdNextApplies(2)
    const both = Promise.allSettled([
      ada.outbox.enqueue(close('POD-1', { attribution: ADA, mutationId: collide })),
      grace.outbox.enqueue(close('POD-2', { attribution: GRACE, mutationId: collide })),
    ])
    await Promise.resolve()
    release()
    const [first, second] = await both

    // Exactly one fulfils. The loser is REFUSED rather than overwriting.
    const outcomes = [first?.status, second?.status].sort()
    expect(outcomes).toEqual(['fulfilled', 'rejected'])
    const rejected = [first, second].find((r) => r?.status === 'rejected')
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/duplicate mutationId/)

    // One row, and both instances agree with durable truth about who owns it.
    expect(store.durable()).toHaveLength(1)
    const owner = store.durable()[0]?.attribution.onBehalfOf
    const winner = owner === 'u-ada' ? ada : grace
    const loser = owner === 'u-ada' ? grace : ada
    expect(winner.outbox.all()).toHaveLength(1)
    expect(loser.outbox.all()).toEqual([])
    // And the loser emitted no local-ack: nothing escapes for work that never landed.
    expect(types(loser.events)).not.toContain('local-ack')
  })

  it('discard versus drain on two tabs: the user decision wins and nothing is submitted', async () => {
    // Reviewer's probe: both fulfilled, the authority received a submission, and
    // durable state ended `applied` — overwriting a successful user discard.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const tabA = await harness(() => applied, { store, clock, idPrefix: 'a-' })
    const tabB = await harness(() => applied, { store, clock, idPrefix: 'b-' })
    const record = await tabA.outbox.enqueue(close('POD-1'))
    // Tab B learns about it the way a second tab does: on its next rebase.
    await tabB.outbox.enqueue(close('POD-2'))

    const release = store.holdNextApplies(2)
    const both = Promise.allSettled([tabA.outbox.discard(record.mutationId), tabB.outbox.drain()])
    await Promise.resolve()
    release()
    const [discarded, drained] = await both

    // BOTH settle successfully, and that is a requirement rather than incidental:
    // losing a race to the user's own discard is a NORMAL drain outcome, not a
    // drain error. A pass that rejected here would make every concurrent cancel
    // look like a failure to whatever drives the drain.
    expect(discarded?.status).toBe('fulfilled')
    expect(drained?.status).toBe('fulfilled')

    // The discard is durable, and the drain did NOT overwrite it.
    expect(store.durable().find((r) => r.mutationId === record.mutationId)?.state).toBe('cancelled')
    // Nothing was sent for the cancelled entry: `sending` must be durable before
    // the envelope goes out, so losing that race means never submitting.
    expect(tabB.authority.envelopes.map((e) => e.mutationId)).not.toContain(record.mutationId)
    // Scoped to the CONTESTED record: tab B's own entry drained legitimately, so a
    // blanket "no applied event" assertion would be testing the wrong thing.
    const aboutContested = tabB.events.filter(
      (e) => 'mutationId' in e && e.mutationId === record.mutationId,
    )
    expect(types(aboutContested)).toEqual([])
  })

  it('a re-staged mutation still lands when the conflict was benign', async () => {
    // A conflict is not automatically a refusal: if the body can still succeed
    // against fresh truth, it does, and the caller never sees the retry.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const ada = await harness(() => unreachable, { store, clock, idPrefix: 'ada-' })
    const grace = await harness(() => unreachable, {
      store,
      clock,
      principal: 'u-grace',
      idPrefix: 'g-',
    })

    const release = store.holdNextApplies(2)
    const both = Promise.allSettled([
      ada.outbox.enqueue(close('POD-1', { attribution: ADA })),
      grace.outbox.enqueue(close('POD-2', { attribution: GRACE })),
    ])
    await Promise.resolve()
    release()
    const results = await both

    // Different ids, so both are legitimate and BOTH must land.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(
      store
        .durable()
        .map((r) => r.attribution.onBehalfOf)
        .sort(),
    ).toEqual(['u-ada', 'u-grace'])
  })

  it('surfaces a permanent conflict instead of spinning forever', async () => {
    const store = new InMemoryOutboxStore()
    const { outbox } = await harness(() => unreachable, { store })
    // A store that always reports a conflict stands in for a pathological writer.
    const original = store.apply.bind(store)
    let calls = 0
    store.apply = async (mutation, span) => {
      calls += 1
      void original
      return { ok: false, conflicts: (mutation.put ?? []).map((r) => r.mutationId) }
    }

    await expect(outbox.enqueue(close('POD-1'))).rejects.toThrow(/conflict/)
    expect(calls).toBe(5)
  })
})

describe('review round 4 — commit-time conflicts and transaction atomicity', () => {
  it('propagates a commit conflict to the caller who OWNS the span', async () => {
    // An apply-time conflict is the kernel's to resolve by re-staging. A COMMIT-time
    // conflict can only happen inside a span the CALLER opened, so it surfaces on
    // THEIR `transact` call and the retry decision is theirs — the kernel has no
    // branch for it, because a branch claiming to handle an unreachable case is worse
    // than its absence.
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const { outbox } = await harness(() => applied, { store, clock })
    const target = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    let seen: unknown
    try {
      await uow.transact(async (span) => {
        await outbox.retireApplied(target.mutationId, span)
        // Another writer moves the record, so the staged expectation goes stale and
        // the precondition can only fail at commit.
        await store.apply({
          put: [{ ...(store.durable()[0] as OutboxRecord), state: 'cancelled' }],
          expect: [{ mutationId: target.mutationId, expect: 'applied' }],
        })
      })
    } catch (error) {
      seen = error
    }

    expect(seen).toBeInstanceOf(SyncCommitConflict)
    // The kernel did not silently retry it into existence: the entry is whatever the
    // other writer made it, and the retirement did not happen.
    expect(store.durable().map((r) => [r.mutationId, r.state])).toEqual([
      [target.mutationId, 'cancelled'],
    ])
  })

  it('a late precondition failure leaves NOTHING of the transaction behind', async () => {
    // Two participants stage the SAME key into ONE span — the shape an authority and
    // a replica adapter would produce. The second staging conflicts, the transaction
    // rejects, and nothing of it survives: no row, no memory, no ack, and a cold
    // rehydrate agrees. (Previously written with two `enqueue` calls inside the span,
    // which relied on the ambient join that has since been removed as unsafe.)
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const { outbox, events } = await harness(() => unreachable, { store, clock })
    const collide: OutboxRecord = {
      mutationId: 'm-shared' as MutationId,
      command: CLOSE,
      input: { by: 'first' },
      partitionKey: 'p',
      attribution: ADA,
      state: 'queued',
      queuedAt: 0,
      attempts: 0,
    }

    await expect(
      uow.transact(async (span) => {
        const first = await store.apply(
          { put: [collide], expect: [{ mutationId: collide.mutationId, expect: 'absent' }] },
          span,
        )
        expect(first.ok).toBe(true)
        // The span now HAS the key staged, so a second `absent` expectation on it
        // fails immediately — the span reads its own writes.
        const second = await store.apply(
          {
            put: [{ ...collide, input: { by: 'second' } }],
            expect: [{ mutationId: collide.mutationId, expect: 'absent' }],
          },
          span,
        )
        expect(second.ok).toBe(false)
        throw new SyncCommitConflict([collide.mutationId])
      }),
    ).rejects.toThrow(SyncCommitConflict)

    expect(store.durable()).toEqual([])
    expect(outbox.all()).toEqual([])
    expect(types(events)).not.toContain('local-ack')
    const reopened = await harness(() => unreachable, { store, clock, idPrefix: 'r-' })
    expect(reopened.outbox.all()).toEqual([])
  })

  it('publishes nothing when a staged precondition goes stale before commit', async () => {
    // The late-failure path that survives staging: span A stages a retirement, then
    // ANOTHER writer commits something that invalidates one of A's preconditions
    // before A commits. A must publish nothing at all.
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const { outbox } = await harness(() => applied, { store, clock })
    const target = await outbox.enqueue(close('POD-1'))
    await outbox.drain()
    const before = JSON.stringify(store.durable())

    await expect(
      uow.transact(async (span) => {
        await outbox.retireApplied(target.mutationId, span)
        // A second writer moves the same record while the span is open, so the
        // staged expectation (applied) no longer holds at commit.
        const outside = await store.apply({
          put: [{ ...(store.durable()[0] as OutboxRecord), state: 'cancelled' }],
          expect: [{ mutationId: target.mutationId, expect: 'applied' }],
        })
        expect(outside.ok).toBe(true)
      }),
    ).rejects.toThrow(SyncCommitConflict)

    // The outside commit survived, and the aborted span left no trace.
    expect(store.durable().map((r) => [r.mutationId, r.state])).toEqual([
      [target.mutationId, 'cancelled'],
    ])
    expect(before).not.toEqual(JSON.stringify(store.durable()))
  })

  it("an aborted span cannot delete another transaction's committed value", async () => {
    // Reviewer's overlapping-key probe. Under the old keyed undo: span A staged a put
    // for `shared`, transaction B replaced `shared` and committed, A then hit a late
    // conflict and its undo restored the prior value — DELETING B's committed work.
    // B had also read A's uncommitted write, a dirty read. Staging closes both: A's
    // write is invisible until it publishes, and it never publishes.
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const { outbox } = await harness(() => unreachable, { store, clock })
    const shared: OutboxRecord = {
      mutationId: 'shared' as MutationId,
      command: CLOSE,
      input: { by: 'A' },
      partitionKey: 'p',
      attribution: ADA,
      state: 'queued',
      queuedAt: 0,
      attempts: 0,
    }
    void outbox

    await expect(
      uow.transact(async (span) => {
        const staged = await store.apply(
          { put: [shared], expect: [{ mutationId: shared.mutationId, expect: 'absent' }] },
          span,
        )
        expect(staged.ok).toBe(true)
        // B commits its own value for the SAME key. It must not see A's staged write
        // — so `absent` still holds for it, which is the no-dirty-read assertion.
        const b = await store.apply({
          put: [{ ...shared, input: { by: 'B' } }],
          expect: [{ mutationId: shared.mutationId, expect: 'absent' }],
        })
        expect(b.ok).toBe(true)
        // A now hits a genuine conflict: the key it expected absent exists.
        throw new Error('A fails after B committed')
      }),
    ).rejects.toThrow(/A fails after B committed/)

    // B's committed value survives A's abort, unchanged.
    expect(store.durable()).toHaveLength(1)
    expect(store.durable()[0]?.input).toEqual({ by: 'B' })
  })

  it('an aborted removal restores record ORDER byte for byte', async () => {
    // Reviewer's exact-rollback probe. Under the old keyed undo, restoring a removed
    // record by push turned [first, second] into [second, first] — an aborted
    // transaction silently reordering durable records, which D12's FIFO depends on.
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const { outbox } = await harness(() => applied, { store, clock })
    const first = await outbox.enqueue(close('POD-1'))
    const second = await outbox.enqueue(close('POD-2'))
    const before = JSON.stringify(store.durable())
    expect(store.durable().map((r) => r.mutationId)).toEqual([first.mutationId, second.mutationId])

    await expect(
      uow.transact(async (span) => {
        await store.apply(
          {
            remove: [first.mutationId],
            expect: [{ mutationId: first.mutationId, expect: 'queued' }],
          },
          span,
        )
        throw new Error('abort after staging the removal')
      }),
    ).rejects.toThrow(/abort after staging/)

    // Byte for byte, order included.
    expect(JSON.stringify(store.durable())).toBe(before)
  })

  it('refuses a mutation that touches a key with no precondition', async () => {
    // The nit, made structural in two places: `delta()` builds `expect` itself from
    // the same sets it builds `put`/`remove` from, so an incomplete mutation is not
    // constructible through the kernel — and the adapter refuses one anyway, so a
    // future caller cannot reintroduce an unconditional apply through a well-typed
    // mutation.
    const { store } = await harness()
    await expect(store.apply({ remove: ['ghost' as MutationId], expect: [] })).rejects.toThrow(
      /no precondition/,
    )
  })

  it('refuses to adopt a record that never went through put()', async () => {
    // Memory silently ahead of the store is the same defect class as an unlicensed
    // removal: the delta is built from what `put()` tracked, so an untracked change
    // would be adopted and never written.
    const { outbox, store } = await harness()
    const internals = outbox as unknown as {
      mutate: (body: (draft: unknown) => void) => Promise<void>
    }
    await expect(
      internals.mutate((draft) => {
        const d = draft as { records: OutboxRecord[] }
        d.records.push({
          mutationId: 'sneaky' as MutationId,
          command: CLOSE,
          input: {},
          partitionKey: 'p',
          attribution: ADA,
          state: 'queued',
          queuedAt: 0,
          attempts: 0,
        })
      }),
    ).rejects.toThrow(OutboxInvariantError)
    expect(store.durable()).toEqual([])
    expect(outbox.all()).toEqual([])
  })
})

describe('review round 5 — store-level transaction isolation', () => {
  it('serializes commits, so two concurrent spans on DISJOINT keys both survive', async () => {
    // The commit lock had no test, and a mutant that removed it passed: the double's
    // commit was synchronous end to end, so nothing could interleave. `slowCommits`
    // models the gap a real IndexedDB or SQLite transaction has between computing a
    // post-state and publishing it — and with that gap, two unserialized commits each
    // publish from the same base and the second silently drops the first's key.
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const one = await harness(() => unreachable, { store, clock, idPrefix: 'one-' })
    const two = await harness(() => unreachable, {
      store,
      clock,
      principal: 'u-grace',
      idPrefix: 'two-',
    })
    store.slowCommits = true
    const uowOne = new InMemoryUnitOfWork()
    const uowTwo = new InMemoryUnitOfWork()

    await Promise.all([
      uowOne.transact(async (span) => {
        await store.apply(
          {
            put: [
              {
                mutationId: 'one-key' as MutationId,
                command: CLOSE,
                input: {},
                partitionKey: 'p1',
                attribution: ADA,
                state: 'queued',
                queuedAt: 0,
                attempts: 0,
              },
            ],
            expect: [{ mutationId: 'one-key' as MutationId, expect: 'absent' }],
          },
          span,
        )
      }),
      uowTwo.transact(async (span) => {
        await store.apply(
          {
            put: [
              {
                mutationId: 'two-key' as MutationId,
                command: CLOSE,
                input: {},
                partitionKey: 'p2',
                attribution: GRACE,
                state: 'queued',
                queuedAt: 0,
                attempts: 0,
              },
            ],
            expect: [{ mutationId: 'two-key' as MutationId, expect: 'absent' }],
          },
          span,
        )
      }),
    ])

    // Neither commit dropped the other's key.
    expect(
      store
        .durable()
        .map((r) => r.mutationId)
        .sort(),
    ).toEqual(['one-key', 'two-key'])
    void one
    void two
  })
})

describe('review round 6 — an unrelated open transaction must not absorb a mutation', () => {
  it('a concurrent enqueue gets its OWN transaction and survives the outer abort', async () => {
    // The probe: an ambient "current span" made every `transact` arriving mid-body
    // JOIN that transaction, even from an unrelated concurrent caller. So `enqueue`
    // fulfilled while durable length was 0, and aborting the unrelated outer
    // transaction discarded the acknowledged command. Two separate failures at once:
    // success reported before durability, and acknowledged work silently lost.
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const { outbox, events } = await harness(() => unreachable, { store, clock })

    let releaseOuter = (): void => {}
    const outerHeld = new Promise<void>((resolve) => {
      releaseOuter = resolve
    })
    const outer = uow.transact(async () => {
      await outerHeld
      throw new Error('unrelated outer transaction aborts')
    })

    // Concurrent, unrelated user action while the outer transaction is open.
    const enqueued = outbox.enqueue(close('POD-1'))
    for (let i = 0; i < 20; i++) await Promise.resolve()

    // It must NOT have resolved by joining someone else's open transaction...
    const record = await enqueued
    // ...and when it does resolve, it is durable: that is what `local-ack` means.
    expect(store.durable().map((r) => r.mutationId)).toEqual([record.mutationId])
    expect(types(events)).toContain('local-ack')

    releaseOuter()
    await expect(outer).rejects.toThrow(/unrelated outer transaction aborts/)

    // The unrelated abort did not discard the acknowledged command.
    expect(store.durable().map((r) => r.mutationId)).toEqual([record.mutationId])
    expect(outbox.all().map((r) => r.mutationId)).toEqual([record.mutationId])
    const reopened = await harness(() => unreachable, { store, clock, idPrefix: 'r-' })
    expect(reopened.outbox.all().map((r) => r.mutationId)).toEqual([record.mutationId])
  })

  it('serializes independent transactions instead of nesting them', async () => {
    const uow = new InMemoryUnitOfWork()
    const order: string[] = []
    let releaseFirst = (): void => {}
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = uow.transact(async () => {
      order.push('first:start')
      await firstHeld
      order.push('first:end')
    })
    const second = uow.transact(async () => {
      order.push('second:start')
    })
    for (let i = 0; i < 20; i++) await Promise.resolve()

    // The second call waits for the first to settle rather than joining it.
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    expect(uow.spans).toBe(2)
  })
})
