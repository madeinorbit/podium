import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type EnqueueRequest, Outbox } from './outbox'
import type { OutboxEvent, OutboxSubmitOutcome } from './ports'
import type { OutboxAttribution, OutboxCommand, OutboxRecord } from './records'
import {
  InMemoryOutboxStore,
  ManualClock,
  ScriptedAuthority,
  sequentialMutationIds,
} from './test-doubles'

/**
 * POD-785 — the CAPACITY half of "the outbox grows unbounded".
 *
 * The measured cause (docs/internal/pod-785-evidence/) is not a missing size cap.
 * It is that a queue which never drains accumulates redundant writes for ever:
 * one dead-lettered entry stops its partition (D12), and behind it the app keeps
 * queueing read receipts at ~361 B each. 93% of that queue is superseded — a
 * receipt for a target that a LATER queued receipt already covers.
 *
 * So the bound is not a threshold at which work is discarded. It is COLLAPSE of
 * writes that carry no information the queue does not already hold, which leaves
 * the queue proportional to the user's working set instead of to time spent
 * offline. The non-negotiable constraint the whole suite exists to hold:
 * NOTHING CONTENT-BEARING IS EVER DROPPED.
 */

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const ADA: OutboxAttribution = {
  actor: actorUser(asUserId('u-ada')),
  onBehalfOf: asUserId('u-ada'),
}

const cmd = (name: string): OutboxCommand => ({ name, version: 1, delivery: 'offline-eligible' })
const MARK_READ = cmd('issues.markRead')
const SEND_TEXT = cmd('sessions.resumeAndSend')

const applied: OutboxSubmitOutcome = { kind: 'applied' }
const denied: OutboxSubmitOutcome = { kind: 'rejected', refusal: { kind: 'unauthorized' } }
const unreachable: OutboxSubmitOutcome = { kind: 'unreachable' }

interface Harness {
  readonly outbox: Outbox
  readonly store: InMemoryOutboxStore
  readonly clock: ManualClock
  readonly events: OutboxEvent[]
}

async function harness(
  respond: (command: string) => OutboxSubmitOutcome = () => applied,
): Promise<Harness> {
  const store = new InMemoryOutboxStore()
  const clock = new ManualClock()
  const events: OutboxEvent[] = []
  const outbox = await Outbox.open({
    store,
    // `OutboxEnvelope.command` is a string (ports.ts:32) — reading `.name` off it
    // yields undefined and answers `applied` to everything, which silently
    // disarms every refusal in this file.
    submit: new ScriptedAuthority((envelope) => respond(envelope.command)),
    principal: 'u-ada',
    now: clock.now,
    maxAgeMs: MAX_AGE_MS,
    newMutationId: sequentialMutationIds('m'),
    onStoreUnreadable: () => {},
  })
  outbox.subscribe((event) => events.push(event))
  return { outbox, store, clock, events }
}

/** A read receipt: idempotent, target-keyed, and fully superseded by a later one
 *  for the same target — the exact shape that filled the queue on 2026-07-17. */
const receipt = (issue: string, extra: Partial<EnqueueRequest> = {}): EnqueueRequest => ({
  command: MARK_READ,
  input: { issueId: issue, readAt: '2026-07-17T09:14:22.101Z' },
  attribution: ADA,
  partitionKey: `issue:${issue}`,
  collapseKey: `issue-read:${issue}`,
  ...extra,
})

/** Text typed into a live PTY. Never collapsible: two sends are two sends, and
 *  ADR 3 D11 names this as the reason "idempotent-ish" is not a property we lean
 *  on. It carries NO collapseKey, which is what makes that structural. */
const sendText = (session: string, text: string): EnqueueRequest => ({
  command: SEND_TEXT,
  input: { sessionId: session, text },
  attribution: ADA,
  partitionKey: `session:${session}`,
})

const ids = (records: readonly OutboxRecord[]): string[] => records.map((r) => r.mutationId)

describe('supersede collapse bounds the redundant-write class', () => {
  it('keeps only the newest queued write per collapse key', async () => {
    const { outbox } = await harness(() => unreachable)

    const first = await outbox.enqueue(receipt('POD-1'))
    const second = await outbox.enqueue(receipt('POD-1'))
    const third = await outbox.enqueue(receipt('POD-1'))

    expect(ids(outbox.pending())).toEqual([third.mutationId])
    expect(outbox.find(first.mutationId)).toBeUndefined()
    expect(outbox.find(second.mutationId)).toBeUndefined()
  })

  it('bounds a long offline run by the WORKING SET, not by time offline', async () => {
    const { outbox } = await harness(() => unreachable)

    // 900 visits across a 60-issue working set — the section C workload.
    let seed = 12345
    const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 900; i++) {
      await outbox.enqueue(receipt(`POD-${Math.floor(rand() * 60)}`))
    }

    // One per distinct target, and nothing more.
    expect(outbox.pending().length).toBe(60)
  })

  it('collapses only within one collapse key', async () => {
    const { outbox } = await harness(() => unreachable)

    await outbox.enqueue(receipt('POD-1'))
    await outbox.enqueue(receipt('POD-2'))
    await outbox.enqueue(receipt('POD-1'))

    expect(outbox.pending().length).toBe(2)
    expect(outbox.pending().map((r) => (r.input as { issueId: string }).issueId)).toEqual([
      'POD-2',
      'POD-1',
    ])
  })

  it('publishes the collapse so an overlay above the seam can repaint', async () => {
    const { outbox, events } = await harness(() => unreachable)

    const first = await outbox.enqueue(receipt('POD-1'))
    events.length = 0
    const second = await outbox.enqueue(receipt('POD-1'))

    expect(events).toContainEqual({ type: 'superseded', mutationId: first.mutationId })
    expect(events).toContainEqual({ type: 'local-ack', mutationId: second.mutationId })
  })
})

describe('collapse never reaches work that is not redundant', () => {
  it('NEVER collapses a command that declares no collapse key', async () => {
    const { outbox } = await harness(() => unreachable)

    await outbox.enqueue(sendText('s-1', 'first line'))
    await outbox.enqueue(sendText('s-1', 'second line'))
    await outbox.enqueue(sendText('s-1', 'third line'))

    // Three sends are three sends: collapsing them would swallow text a person
    // typed into a live terminal.
    expect(outbox.pending().length).toBe(3)
    expect(outbox.pending().map((r) => (r.input as { text: string }).text)).toEqual([
      'first line',
      'second line',
      'third line',
    ])
  })

  it('never collapses across partitions, even on an equal collapse key', async () => {
    const { outbox } = await harness(() => unreachable)

    await outbox.enqueue(receipt('POD-1', { partitionKey: 'issue:POD-1' }))
    await outbox.enqueue(receipt('POD-1', { partitionKey: 'issue:OTHER' }))

    // Ordering is only defined WITHIN a partition, so a cross-partition collapse
    // would be deciding an order D12 does not give us.
    expect(outbox.pending().length).toBe(2)
  })

  it('never collapses an entry that has already left `queued`', async () => {
    // The predecessor is in flight: the Authority may already have it, so the
    // record is the only trace of a send that must still be resolved.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Resolves the instant the transport is entered — by which point `sending`
    // is durable, because the Outbox persists it BEFORE the envelope goes out.
    // Signalling from inside `submit` is what makes this deterministic; counting
    // microtasks would be a fixed sleep wearing a different hat.
    let entered: (() => void) | undefined
    const inTransport = new Promise<void>((resolve) => {
      entered = resolve
    })
    const store = new InMemoryOutboxStore()
    const clock = new ManualClock()
    const slow = await Outbox.open({
      store,
      submit: {
        submit: async () => {
          entered?.()
          await gate
          return applied
        },
      },
      principal: 'u-ada',
      now: clock.now,
      maxAgeMs: MAX_AGE_MS,
      newMutationId: sequentialMutationIds('s'),
      onStoreUnreadable: () => {},
    })

    const inFlight = await slow.enqueue(receipt('POD-1'))
    const draining = slow.drain()
    await inTransport
    expect(slow.find(inFlight.mutationId)?.state).toBe('sending')

    const next = await slow.enqueue(receipt('POD-1'))
    expect(slow.find(inFlight.mutationId)).toBeDefined()
    expect(slow.find(next.mutationId)).toBeDefined()

    release?.()
    await draining
  })

  it('never collapses a dead-lettered entry out of the recovery surface', async () => {
    const { outbox } = await harness((command) =>
      command === 'issues.markRead' ? denied : applied,
    )

    const parked = await outbox.enqueue(receipt('POD-1'))
    await outbox.drain()
    expect(outbox.deadLetters().map((r) => r.mutationId)).toEqual([parked.mutationId])

    // A later receipt for the same target must not silently erase the refusal
    // the user still has to see and act on.
    await outbox.enqueue(receipt('POD-1'))

    expect(outbox.deadLetters().map((r) => r.mutationId)).toEqual([parked.mutationId])
  })
})

describe('re-issue leaves no tombstone behind', () => {
  it('removes the cancelled predecessor instead of keeping it for ever', async () => {
    const { outbox, store } = await harness(() => denied)

    const original = await outbox.enqueue({
      command: cmd('sessions.rename'),
      input: { sessionId: 's-1', title: 'first' },
      attribution: ADA,
      partitionKey: 'session:s-1',
    })
    await outbox.drain()

    let live: MutationId = original.mutationId
    for (let i = 0; i < 25; i++) {
      const next = await outbox.edit(live, { input: { sessionId: 's-1', title: `edit ${i}` } })
      await outbox.drain()
      live = next.mutationId
    }

    // The user's intent continues under the newest id; the 25 superseded ids are
    // not recoverable state and nothing ever purged them before POD-785.
    expect(store.durable().filter((r) => r.state === 'cancelled')).toEqual([])
    expect(store.durable().length).toBe(1)
    expect(store.durable()[0]?.mutationId).toBe(live)
  })
})

describe('the collapsed entry is gone from the store, not just from the view', () => {
  it('removes the predecessor durably, so a reload does not resurrect it', async () => {
    const { outbox, store } = await harness(() => unreachable)

    const first = await outbox.enqueue(receipt('POD-1'))
    const second = await outbox.enqueue(receipt('POD-1'))

    expect(ids(store.durable())).toEqual([second.mutationId])

    // Re-open over the same store: this is what a reload does, and it is where a
    // collapse that only touched memory would show up as the queue growing back.
    const reopened = await Outbox.open({
      store,
      submit: new ScriptedAuthority(() => unreachable),
      principal: 'u-ada',
      now: new ManualClock().now,
      maxAgeMs: MAX_AGE_MS,
      newMutationId: sequentialMutationIds('r'),
      onStoreUnreadable: () => {},
    })
    expect(ids(reopened.all())).toEqual([second.mutationId])
    expect(reopened.find(first.mutationId)).toBeUndefined()
  })
})
