import { asSessionId, type MutationId } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { type EnqueueRequest, envelopeFor, Outbox, OutboxUsageError } from './outbox'
import type { OutboxEnvelope, OutboxEvent, OutboxSubmitOutcome } from './ports'
import type { AuthorityRefusal } from './reasons'
import type { OutboxAttribution, OutboxCommand, OutboxRecord } from './records'
import {
  InMemoryOutboxStore,
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
  init: { store?: InMemoryOutboxStore; clock?: ManualClock } = {},
): Promise<Harness> {
  const store = init.store ?? new InMemoryOutboxStore()
  const clock = init.clock ?? new ManualClock()
  const authority = new ScriptedAuthority(respond)
  const events: OutboxEvent[] = []
  const unreadable: unknown[] = []
  const outbox = await Outbox.open({
    store,
    submit: authority,
    now: clock.now,
    maxAgeMs: MAX_AGE_MS,
    newMutationId: sequentialMutationIds(),
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
    expect(outbox.deadLetters({ forUser: 'u-ada' })).toEqual([])
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
    await store.write([
      { ...(first.outbox.find(record.mutationId) as OutboxRecord), state: 'sending' },
    ])

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

    const [parked] = outbox.deadLetters({ forUser: 'u-ada' })
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
    expect(outbox.deadLetters({ forUser: 'u-ada' })).toEqual([])

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

    const [parked] = outbox.deadLetters({ forUser: 'u-ada' })
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
    expect(outbox.deadLetters({ forUser: 'u-ada' })).toEqual([])
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
    await store.write([
      {
        ...(first.outbox.find(record.mutationId) as OutboxRecord),
        state: 'rejected',
        reason: { code: 'conflict' },
      },
    ])

    const second = await harness(() => applied, { store })
    expect(state(second.outbox, record.mutationId)).toBe('dead-letter')
    expect(second.outbox.deadLetters({ forUser: 'u-ada' })).toHaveLength(1)
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
    const [parked] = outbox.deadLetters({ forUser: 'u-ada' })
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

    const [parked] = outbox.deadLetters({ forUser: 'u-ada' })
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
    const [parked] = outbox.deadLetters({ forUser: 'u-ada' })
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
    expect(outbox.deadLetters({ forUser: 'u-ada' })[0]?.reason).toEqual({ code: 'unauthorized' })
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
    const { outbox, authority } = await harness((envelope) =>
      envelope.confirmed
        ? applied
        : { kind: 'rejected', refusal: { kind: 'confirmation-required' } },
    )
    const record = await outbox.enqueue(close('POD-1'))
    await outbox.drain()

    expect(outbox.deadLetters({ forUser: 'u-ada' })[0]?.recovery.retry).toBe('confirmation')
    await outbox.retry(record.mutationId, { confirmed: true })
    await outbox.drain()

    expect(state(outbox, record.mutationId)).toBe('applied')
    expect(authority.envelopes.at(-1)?.confirmed).toBe(true)
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
      JSON.stringify({ ...h.outbox.deadLetters({ forUser: 'u-ada' })[0], mutationId: '<id>' })

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

    const [parked] = outbox.deadLetters({ forUser: 'u-ada' })
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
    const { outbox, authority, events } = await harness(() => unreachable)
    const record = await outbox.enqueue(close('POD-shared'))
    await outbox.drain()

    // Rung 2: discard the cache, re-bootstrap, KEEP THE OUTBOX.
    expect(outbox.noteReplicaRebootstrapped('rescope')).toEqual({ preserved: 1 })
    expect(state(outbox, record.mutationId)).toBe('queued')

    authority.reprogram(() => denied)
    await outbox.drain()

    expect(state(outbox, record.mutationId)).toBe('dead-letter')
    expect(outbox.deadLetters({ forUser: 'u-ada' })[0]?.reason).toEqual({ code: 'unauthorized' })
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

    for (const cause of [
      'gap',
      'compacted',
      'malformed',
      'epoch-mismatch',
      'local-corruption',
      'schema-bump',
      'rescope',
    ] as const) {
      expect(outbox.noteReplicaRebootstrapped(cause)).toEqual({ preserved: 2 })
    }

    // Not just in memory: a cold start after the re-bootstrap still finds them.
    expect(store.durable().map((r) => r.mutationId)).toEqual([a.mutationId, b.mutationId])
    const reopened = await harness(() => applied, { store, clock })
    await reopened.outbox.drain()
    expect(state(reopened.outbox, a.mutationId)).toBe('applied')
    expect(state(reopened.outbox, b.mutationId)).toBe('applied')
  })

  it('surfaces a stale expectedRevision as an authority rejection, never as a replica-side drop', async () => {
    const { outbox } = await harness(() => conflicted)
    const record = await outbox.enqueue(close('POD-1', { expectedRevision: 3 }))
    outbox.noteReplicaRebootstrapped('epoch-mismatch')
    await outbox.drain()

    expect(state(outbox, record.mutationId)).toBe('dead-letter')
    expect(outbox.deadLetters({ forUser: 'u-ada' })[0]?.reason).toEqual({ code: 'conflict' })
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
    expect(outbox.deadLetters({ forUser: 'u-grace' })).toEqual([])
  })
})

describe('dead-letter records are private to their author', () => {
  it('never surfaces one author entry in another author recovery UI', async () => {
    const { outbox } = await harness(() => denied)
    await outbox.enqueue(close('POD-1', { attribution: ADA }))
    await outbox.enqueue(close('POD-2', { attribution: GRACE }))
    await outbox.enqueue(close('POD-3', { attribution: ADAS_AGENT }))
    await outbox.drain()

    const adas = outbox.deadLetters({ forUser: 'u-ada' })
    const graces = outbox.deadLetters({ forUser: 'u-grace' })

    // The agent's work belongs to the human it acted for (§3.1.3 A4).
    expect(adas.map((r) => (r.input as { issueId: string }).issueId).sort()).toEqual([
      'POD-1',
      'POD-3',
    ])
    expect(graces.map((r) => (r.input as { issueId: string }).issueId)).toEqual(['POD-2'])
  })

  it('recovers the author own intent even when the target is no longer visible', async () => {
    const { outbox } = await harness(() => denied)
    await outbox.enqueue(close('POD-shared'))
    await outbox.drain()

    const [parked] = outbox.deadLetters({ forUser: 'u-ada' })
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
