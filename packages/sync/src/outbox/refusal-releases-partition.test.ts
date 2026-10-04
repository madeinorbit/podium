/**
 * POD-5430: one refusal rule (R1 and R3 of `docs/plans/pod-4286-optimism-and-refusals.md`,
 * ADR 3 amendment 2).
 *
 * R1. An entry holds its partition only while its outcome is UNKNOWN: in flight,
 *     taken but not applied, or queued behind a transient failure. A definitive
 *     outcome (applied, refused, expired, cancelled) lets the next entry go, for
 *     every command.
 * R3. A retry or an edit is a new act by the user, so it goes to the BACK of its
 *     partition, behind everything already queued.
 *
 * The first test is POD-5415's queue proof (POD-4978's mobile queue audit) as a
 * kernel test: a refused rename used to hold the read receipt and the second
 * rename behind it until the user dealt with the first.
 */

import { actorUser, asUserId, type MutationId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { OUTBOX_MAX_AGE_MS } from './limits'
import { type EnqueueRequest, Outbox } from './outbox'
import type { OutboxEnvelope, OutboxEvent, OutboxSubmitOutcome } from './ports'
import type { OutboxAttribution, OutboxCommand } from './records'
import {
  InMemoryOutboxStore,
  ManualClock,
  ScriptedAuthority,
  sequentialMutationIds,
} from './test-doubles'

const UPDATE: OutboxCommand = { name: 'issues.update', version: 1, delivery: 'offline-eligible' }
const MARK_READ: OutboxCommand = {
  name: 'issues.markRead',
  version: 1,
  delivery: 'offline-eligible',
}
const CHAT: OutboxCommand = { name: 'sessions.sendText', version: 1, delivery: 'offline-eligible' }

const ADA: OutboxAttribution = {
  actor: actorUser(asUserId('u-ada')),
  onBehalfOf: asUserId('u-ada'),
}

const applied: OutboxSubmitOutcome = { kind: 'applied' }
const accepted: OutboxSubmitOutcome = { kind: 'accepted' }
const unreachable: OutboxSubmitOutcome = { kind: 'unreachable' }
const conflicted: OutboxSubmitOutcome = { kind: 'rejected', refusal: { kind: 'conflict' } }
const invalid: OutboxSubmitOutcome = {
  kind: 'rejected',
  refusal: { kind: 'invalid', details: ['input.title'] },
}

type Responder = (
  envelope: OutboxEnvelope,
  attempt: number,
) => OutboxSubmitOutcome | Promise<OutboxSubmitOutcome>

const ISSUE = 'iss_90f8'

const rename = (title: string): EnqueueRequest => ({
  command: UPDATE,
  input: { id: ISSUE, patch: { title } },
  attribution: ADA,
  partitionKey: `issue:${ISSUE}`,
})

const markRead = (): EnqueueRequest => ({
  command: MARK_READ,
  input: { id: ISSUE },
  attribution: ADA,
  partitionKey: `issue:${ISSUE}`,
})

const chat = (text: string): EnqueueRequest => ({
  command: CHAT,
  input: { sessionId: 's1', text },
  attribution: ADA,
  partitionKey: 'chat:s1',
})

/** What the authority saw, by the label each input carries. */
const label = (envelope: OutboxEnvelope): string => {
  const input = envelope.input as { patch?: { title?: string }; text?: string }
  if (input.patch?.title !== undefined) return `rename ${input.patch.title}`
  if (input.text !== undefined) return `chat ${input.text}`
  return 'read'
}

async function harness(
  respond: Responder,
  init: { store?: InMemoryOutboxStore; clock?: ManualClock; idPrefix?: string } = {},
) {
  const store = init.store ?? new InMemoryOutboxStore()
  const clock = init.clock ?? new ManualClock()
  const authority = new ScriptedAuthority(respond)
  const events: OutboxEvent[] = []
  const outbox = await Outbox.open({
    store,
    submit: authority,
    principal: 'u-ada',
    now: clock.now,
    maxAgeMs: OUTBOX_MAX_AGE_MS,
    commandMaxAgeMs: { [CHAT.name]: 120_000 },
    newMutationId: sequentialMutationIds(init.idPrefix ?? 'm'),
    onStoreUnreadable: (error) => {
      throw error
    },
  })
  outbox.subscribe((event) => events.push(event))
  return { outbox, store, clock, authority, events }
}

const stateOf = (outbox: Outbox, id: MutationId): string | undefined => outbox.find(id)?.state
const queuedCount = (outbox: Outbox): number =>
  outbox.pending().filter((r) => r.state === 'queued').length

describe('R1 — a definitive refusal releases its partition (POD-5415)', () => {
  it("POD-5415's sequence: the read receipt and the second rename send past the refused rename", async () => {
    const { outbox, authority } = await harness((envelope) =>
      label(envelope) === 'rename A' ? conflicted : applied,
    )
    const renameA = await outbox.enqueue(rename('A'))
    await outbox.drain()
    // Mission open after the refusal, then the next rename, as on the phone.
    const read = await outbox.enqueue(markRead())
    await outbox.drain()
    const renameB = await outbox.enqueue(rename('B'))
    await outbox.drain()

    expect(stateOf(outbox, renameA.mutationId)).toBe('dead-letter')
    expect(stateOf(outbox, read.mutationId)).toBe('applied')
    expect(stateOf(outbox, renameB.mutationId)).toBe('applied')
    expect(authority.envelopes.map(label)).toEqual(['rename A', 'read', 'rename B'])
    // The banner's numbers: "1 change needing review", nothing queued behind it.
    expect(outbox.deadLetters()).toHaveLength(1)
    expect(queuedCount(outbox)).toBe(0)
    // Rename A's authored text is kept verbatim for recovery.
    expect(outbox.deadLetters()[0]?.input).toEqual({ id: ISSUE, patch: { title: 'A' } })
  })

  it('lets entries queued BEFORE the refusal go in the same pass, in order', async () => {
    const { outbox, authority } = await harness((envelope) =>
      label(envelope) === 'rename A' ? invalid : applied,
    )
    await outbox.enqueue(rename('A'))
    await outbox.enqueue(markRead())
    await outbox.enqueue(rename('B'))
    await outbox.drain()

    expect(authority.envelopes.map(label)).toEqual(['rename A', 'read', 'rename B'])
    expect(queuedCount(outbox)).toBe(0)
  })

  it('lets the next entry go past one that EXPIRED, for every command', async () => {
    let online = false
    const { outbox, clock, authority } = await harness(() => (online ? applied : unreachable))
    const old = await outbox.enqueue(rename('old'))
    await outbox.drain()
    clock.advance(OUTBOX_MAX_AGE_MS - 1_000)
    const fresh = await outbox.enqueue(rename('fresh'))
    clock.advance(2_000)

    online = true
    await outbox.drain()

    expect(stateOf(outbox, old.mutationId)).toBe('dead-letter')
    expect(stateOf(outbox, fresh.mutationId)).toBe('applied')
    expect(authority.attempts(fresh.mutationId)).toBe(1)
  })

  it('still holds the partition while the outcome is UNKNOWN: backing off', async () => {
    const { outbox, authority } = await harness((envelope) =>
      label(envelope) === 'rename A' ? unreachable : applied,
    )
    await outbox.enqueue(rename('A'))
    const behind = await outbox.enqueue(rename('B'))
    await outbox.drain()

    expect(stateOf(outbox, behind.mutationId)).toBe('queued')
    expect(authority.attempts(behind.mutationId)).toBe(0)
  })

  it('still holds the partition while the outcome is UNKNOWN: taken but not applied', async () => {
    const { outbox, authority } = await harness((envelope) =>
      label(envelope) === 'rename A' ? accepted : applied,
    )
    await outbox.enqueue(rename('A'))
    const behind = await outbox.enqueue(rename('B'))
    await outbox.drain()

    expect(stateOf(outbox, behind.mutationId)).toBe('queued')
    expect(authority.attempts(behind.mutationId)).toBe(0)
  })

  it('keeps chat sends releasing as before, with no per-command list', async () => {
    const { outbox, authority } = await harness((envelope) =>
      label(envelope) === 'chat refused' ? invalid : applied,
    )
    await outbox.enqueue(chat('refused'))
    await outbox.enqueue(chat('next'))
    await outbox.drain()

    expect(authority.envelopes.map(label)).toEqual(['chat refused', 'chat next'])
  })
})

describe('R3 — a retry or an edit goes to the back of its partition', () => {
  it('drains a retry AFTER the entries queued before it, and the order survives a reopen', async () => {
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    let online = true
    const respond: Responder = (envelope, attempt) => {
      if (!online) return unreachable
      return label(envelope) === 'rename A' && attempt === 1 ? conflicted : applied
    }
    const { outbox } = await harness(respond, { store, clock })
    const renameA = await outbox.enqueue(rename('A'))
    await outbox.drain()
    expect(stateOf(outbox, renameA.mutationId)).toBe('dead-letter')

    // Offline: the user writes rename B, then retries A. A is the later act.
    online = false
    const renameB = await outbox.enqueue(rename('B'))
    await outbox.retry(renameA.mutationId, { expectedRevision: 2 })

    const order = outbox
      .all()
      .filter((r) => r.state === 'queued')
      .map((r) => r.mutationId)
    expect(order).toEqual([renameB.mutationId, renameA.mutationId])

    // Durable: a reload reads the same order.
    const reopened = await harness(respond, { store, clock, idPrefix: 'r' })
    online = true
    await reopened.outbox.drain()
    expect(reopened.authority.envelopes.map(label)).toEqual(['rename B', 'rename A'])
  })

  it('drains a same-id re-issue (a chat retry) after the message written since', async () => {
    let online = false
    const { outbox, clock, authority } = await harness(() => (online ? applied : unreachable))
    const first = await outbox.enqueue(chat('first'))
    await outbox.drain()
    clock.advance(121_000)
    await outbox.sweepExpired()
    expect(stateOf(outbox, first.mutationId)).toBe('dead-letter')

    const second = await outbox.enqueue(chat('second'))
    const retried = await outbox.retry(first.mutationId, { reissue: true })
    expect(retried.mutationId).toBe(first.mutationId)

    online = true
    await outbox.drain()
    expect(stateOf(outbox, second.mutationId)).toBe('applied')
    expect(stateOf(outbox, first.mutationId)).toBe('applied')
    expect(authority.envelopes.map(label)).toEqual(['chat first', 'chat second', 'chat first'])
  })

  it('drains an edit after the entries queued before it', async () => {
    let online = true
    const { outbox, authority } = await harness((envelope) => {
      if (!online) return unreachable
      return label(envelope) === 'rename A' ? conflicted : applied
    })
    const renameA = await outbox.enqueue(rename('A'))
    await outbox.drain()
    online = false
    await outbox.enqueue(rename('B'))
    await outbox.edit(renameA.mutationId, { input: { id: ISSUE, patch: { title: 'A2' } } })

    online = true
    await outbox.drain()
    expect(authority.envelopes.map(label).slice(-2)).toEqual(['rename B', 'rename A2'])
  })
})

describe('D12 — a send that never settles holds only its own partition (POD-5432 note)', () => {
  it('drains another partition written AFTER the hung send, without waiting for it', async () => {
    // The transport bounds nothing: plain fetch through httpBatchLink, no
    // timeout. A send the server never answers stays `sending` for as long as
    // the connection lives, and that must not stop any other partition.
    const { outbox, authority } = await harness((envelope) =>
      label(envelope) === 'rename A' ? new Promise<OutboxSubmitOutcome>(() => {}) : applied,
    )
    await outbox.enqueue(rename('A'))
    void outbox.drain()
    for (let i = 0; i < 20; i++) await Promise.resolve()

    const later = await outbox.enqueue(chat('written later'))
    void outbox.drain()
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(authority.envelopes.map(label)).toEqual(['rename A', 'chat written later'])
    expect(stateOf(outbox, later.mutationId)).toBe('applied')
  })

  it('still holds the hung partition: the entry behind the hung send waits', async () => {
    const { outbox, authority } = await harness((envelope) =>
      label(envelope) === 'rename A' ? new Promise<OutboxSubmitOutcome>(() => {}) : applied,
    )
    await outbox.enqueue(rename('A'))
    void outbox.drain()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    const behind = await outbox.enqueue(rename('B'))
    void outbox.drain()
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(stateOf(outbox, behind.mutationId)).toBe('queued')
    expect(authority.attempts(behind.mutationId)).toBe(0)
  })
})
