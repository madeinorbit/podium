import { actorUser, asMutationId, asUserId, type MutationId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type EnqueueRequest, Outbox } from './outbox'
import type { OutboxEnvelope, OutboxEvent, OutboxSubmitOutcome } from './ports'
import type {
  ConfirmationEvidence,
  CoveringCursor,
  OutboxAttribution,
  OutboxCommand,
} from './records'
import {
  InMemoryOutboxStore,
  InMemoryUnitOfWork,
  ManualClock,
  ScriptedAuthority,
  sequentialMutationIds,
} from './test-doubles'

// Confirmation by evidence (POD-6275, ADR 2 D9 + ADR 12). An applied entry leaves
// the outbox when the replica proves it holds the server truth that contains it:
// a committed cursor at or past the entry's receipt, or a committed row whose
// provenance names the entry's id. These tests pin the coverage rule, which is
// the whole contract `isConfirmable` and `confirm` share.

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

const CLOSE: OutboxCommand = { name: 'issues.close', version: 1, delivery: 'offline-eligible' }

const ADA: OutboxAttribution = {
  actor: actorUser(asUserId('u-ada')),
  onBehalfOf: asUserId('u-ada'),
}
const GRACE: OutboxAttribution = {
  actor: actorUser(asUserId('u-grace')),
  onBehalfOf: asUserId('u-grace'),
}

type Responder = (
  envelope: OutboxEnvelope,
  attempt: number,
) => OutboxSubmitOutcome | Promise<OutboxSubmitOutcome>

interface Harness {
  readonly outbox: Outbox
  readonly store: InMemoryOutboxStore
  readonly authority: ScriptedAuthority
  readonly events: OutboxEvent[]
}

async function harness(
  respond: Responder,
  init: { store?: InMemoryOutboxStore; principal?: string; idPrefix?: string } = {},
): Promise<Harness> {
  const store = init.store ?? new InMemoryOutboxStore()
  const authority = new ScriptedAuthority(respond)
  const events: OutboxEvent[] = []
  const outbox = await Outbox.open({
    store,
    submit: authority,
    principal: init.principal ?? 'u-ada',
    now: new ManualClock().now,
    maxAgeMs: MAX_AGE_MS,
    newMutationId: sequentialMutationIds(init.idPrefix ?? 'm'),
    onStoreUnreadable: () => {},
  })
  outbox.subscribe((event) => events.push(event))
  return { outbox, store, authority, events }
}

const close = (issue: string, attribution: OutboxAttribution = ADA): EnqueueRequest => ({
  command: CLOSE,
  input: { issueId: issue },
  attribution,
  partitionKey: `issue:${issue}`,
})

const cursor = (seq: number, epoch = 'e', feedId = 'f'): CoveringCursor => ({ feedId, epoch, seq })

const evidence = (
  through: CoveringCursor,
  extra: { confirmed?: readonly MutationId[]; install?: boolean } = {},
): ConfirmationEvidence => ({
  confirmed: extra.confirmed ?? [],
  through,
  install: extra.install ?? false,
})

const appliedWith = (receipt?: CoveringCursor): OutboxSubmitOutcome =>
  receipt ? { kind: 'applied', receipt } : { kind: 'applied' }

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const typesFor = (events: readonly OutboxEvent[], id: MutationId): string[] =>
  events.filter((e) => 'mutationId' in e && e.mutationId === id).map((e) => e.type)

describe('Outbox confirmation by evidence', () => {
  it('an applied entry with a receipt stays until a cursor reaches its seq', async () => {
    const { outbox, events } = await harness(() => appliedWith(cursor(7)))
    const M = (await outbox.enqueue(close('POD-1'))).mutationId
    await outbox.drain()
    expect(outbox.find(M)?.state).toBe('applied')
    expect(outbox.find(M)?.receipt).toEqual(cursor(7))

    expect(await outbox.confirm(evidence(cursor(6)))).toEqual([])
    expect(outbox.find(M)?.state).toBe('applied')
    expect(await outbox.confirm(evidence(cursor(7)))).toEqual([M])
    expect(outbox.find(M)).toBeUndefined()
    expect(typesFor(events, M).slice(-1)).toEqual(['retired'])
  })

  it('the receipt survives reopening the store', async () => {
    const first = await harness(() => appliedWith(cursor(7)))
    const M = (await first.outbox.enqueue(close('POD-1'))).mutationId
    await first.outbox.drain()

    // A reload: a fresh instance over the same durable store.
    const second = await harness(() => appliedWith(), { store: first.store })
    expect(second.outbox.find(M)?.receipt).toEqual(cursor(7))
    expect(await second.outbox.confirm(evidence(cursor(6)))).toEqual([])
    expect(await second.outbox.confirm(evidence(cursor(9)))).toEqual([M])
    expect(first.store.durable()).toEqual([])
  })

  it('a frame naming an in-flight entry retires it; its later reply neither throws nor stalls the partition', async () => {
    const reply = deferred<OutboxSubmitOutcome>()
    const submitted = deferred<void>()
    const { outbox, authority, events } = await harness((envelope) => {
      if (envelope.mutationId === asMutationId('m1')) {
        submitted.resolve()
        return reply.promise
      }
      return appliedWith(cursor(3))
    })
    // Two writes to ONE partition: the second may only go once the first settles.
    const A = (await outbox.enqueue(close('POD-1'))).mutationId
    const B = (await outbox.enqueue(close('POD-1'))).mutationId
    const draining = outbox.drain()
    await submitted.promise
    expect(outbox.find(A)?.state).toBe('sending')

    // The covering frame overtakes the HTTP reply.
    expect(await outbox.confirm(evidence(cursor(2), { confirmed: [A] }))).toEqual([A])
    expect(outbox.find(A)).toBeUndefined()
    expect(typesFor(events, A)).toEqual(['local-ack', 'sending', 'applied', 'retired'])

    // The reply lands afterwards: no throw, no Stale stop, and B goes out.
    reply.resolve(appliedWith(cursor(2)))
    await draining
    expect(outbox.find(A)).toBeUndefined()
    expect(authority.envelopes.map((e) => e.mutationId)).toEqual([A, B])
    expect(outbox.find(B)?.state).toBe('applied')
  })

  it('ids this queue does not own are ignored', async () => {
    const store = new InMemoryOutboxStore()
    const grace = await harness(() => appliedWith(), {
      store,
      principal: 'u-grace',
      idPrefix: 'g',
    })
    const G = (await grace.outbox.enqueue(close('POD-9', GRACE))).mutationId

    const ada = await harness(
      () => ({ kind: 'rejected', refusal: { kind: 'unauthorized' } }) as OutboxSubmitOutcome,
      { store },
    )
    const dead = (await ada.outbox.enqueue(close('POD-1'))).mutationId
    await ada.outbox.drain()
    expect(ada.outbox.find(dead)?.state).toBe('dead-letter')
    const cancelled = (await ada.outbox.enqueue(close('POD-2'))).mutationId
    await ada.outbox.discard(cancelled)
    expect(ada.outbox.find(cancelled)?.state).toBe('cancelled')

    const named = evidence(cursor(100), {
      confirmed: [G, dead, cancelled, asMutationId('never-heard-of-it')],
    })
    expect(ada.outbox.isConfirmable(named)).toBe(false)
    expect(await ada.outbox.confirm(named)).toEqual([])
    // Another principal's queued work, and the user's own parked and cancelled
    // entries, are all exactly where they were.
    expect(store.durable().map((r) => [r.mutationId, r.state])).toEqual([
      [G, 'queued'],
      [dead, 'dead-letter'],
      [cancelled, 'cancelled'],
    ])
  })

  it('an install in another epoch retires old-epoch receipts; a delta in another epoch does not', async () => {
    const { outbox } = await harness(() => appliedWith(cursor(7, 'e1')))
    const M = (await outbox.enqueue(close('POD-1'))).mutationId
    await outbox.drain()

    // Epochs compare by equality only: a delta from another epoch says nothing.
    expect(await outbox.confirm(evidence(cursor(100, 'e2')))).toEqual([])
    // An install in the SAME epoch still compares seqs.
    expect(await outbox.confirm(evidence(cursor(6, 'e1'), { install: true }))).toEqual([])
    expect(outbox.find(M)?.state).toBe('applied')
    // A new truth that supersedes the receipt's epoch covers it.
    expect(await outbox.confirm(evidence(cursor(1, 'e2'), { install: true }))).toEqual([M])
    expect(outbox.find(M)).toBeUndefined()
  })

  it('an applied entry without a receipt is covered by any evidence', async () => {
    const { outbox, events } = await harness(() => appliedWith())
    const M = (await outbox.enqueue(close('POD-1'))).mutationId
    await outbox.drain()
    expect(outbox.find(M)?.state).toBe('applied')
    expect(outbox.find(M)?.receipt).toBeUndefined()

    expect(await outbox.confirm(evidence(cursor(0, 'anything', 'any-feed')))).toEqual([M])
    expect(outbox.find(M)).toBeUndefined()
    expect(typesFor(events, M).slice(-1)).toEqual(['retired'])
  })

  it('with a span nothing is visible until commit; an aborted span retires nothing', async () => {
    const uow = new InMemoryUnitOfWork()
    const { outbox, store, events } = await harness(() => appliedWith(cursor(5)))
    const M = (await outbox.enqueue(close('POD-1'))).mutationId
    const N = (await outbox.enqueue(close('POD-2'))).mutationId
    await outbox.drain()

    await expect(
      uow.transact(async (span) => {
        expect(await outbox.confirm(evidence(cursor(5)), span)).toEqual([M, N])
        throw new Error('replica write failed')
      }),
    ).rejects.toThrow(/replica write failed/)
    expect(outbox.find(M)?.state).toBe('applied')
    expect(outbox.find(N)?.state).toBe('applied')
    expect(store.durable().map((r) => r.mutationId)).toEqual([M, N])
    expect(events.some((e) => e.type === 'retired')).toBe(false)

    await uow.transact(async (span) => {
      expect(await outbox.confirm(evidence(cursor(5)), span)).toEqual([M, N])
      expect(outbox.all().map((r) => r.mutationId)).toEqual([M, N])
      expect(events.some((e) => e.type === 'retired')).toBe(false)
    })
    expect(uow.spans).toBe(2)
    expect(outbox.all()).toEqual([])
    expect(store.durable()).toEqual([])
    expect(events.filter((e) => e.type === 'retired').length).toBe(2)
  })

  describe('isConfirmable agrees with confirm on every case above', () => {
    type Setup = 'queued' | 'sending' | 'accepted' | 'applied' | 'dead-letter' | 'cancelled'
    interface Case {
      readonly name: string
      readonly setup: Setup
      readonly receipt?: CoveringCursor
      readonly foreign?: boolean
      readonly named: boolean
      readonly through: CoveringCursor
      readonly install?: boolean
      readonly covered: boolean
    }
    const r7 = cursor(7)
    const cases: readonly Case[] = [
      {
        name: 'receipt above the cursor',
        setup: 'applied',
        receipt: r7,
        named: false,
        through: cursor(6),
        covered: false,
      },
      {
        name: 'receipt at the cursor',
        setup: 'applied',
        receipt: r7,
        named: false,
        through: cursor(7),
        covered: true,
      },
      {
        name: 'receipt below the cursor',
        setup: 'applied',
        receipt: r7,
        named: false,
        through: cursor(8),
        covered: true,
      },
      {
        name: 'delta in another epoch',
        setup: 'applied',
        receipt: r7,
        named: false,
        through: cursor(99, 'e2'),
        covered: false,
      },
      {
        name: 'install in another epoch',
        setup: 'applied',
        receipt: r7,
        named: false,
        through: cursor(1, 'e2'),
        install: true,
        covered: true,
      },
      {
        name: 'delta on another feed',
        setup: 'applied',
        receipt: r7,
        named: false,
        through: cursor(99, 'e', 'g'),
        covered: false,
      },
      {
        name: 'install on another feed',
        setup: 'applied',
        receipt: r7,
        named: false,
        through: cursor(1, 'e', 'g'),
        install: true,
        covered: true,
      },
      {
        name: 'install in the same epoch below the receipt',
        setup: 'applied',
        receipt: r7,
        named: false,
        through: cursor(6),
        install: true,
        covered: false,
      },
      {
        name: 'applied receipt above the cursor but named',
        setup: 'applied',
        receipt: r7,
        named: true,
        through: cursor(1),
        covered: true,
      },
      {
        name: 'applied without a receipt',
        setup: 'applied',
        named: false,
        through: cursor(0),
        covered: true,
      },
      { name: 'queued and named', setup: 'queued', named: true, through: cursor(0), covered: true },
      {
        name: 'queued and not named',
        setup: 'queued',
        named: false,
        through: cursor(99),
        install: true,
        covered: false,
      },
      {
        name: 'sending and named',
        setup: 'sending',
        named: true,
        through: cursor(0),
        covered: true,
      },
      {
        name: 'sending and not named',
        setup: 'sending',
        named: false,
        through: cursor(99),
        covered: false,
      },
      {
        name: 'accepted and named',
        setup: 'accepted',
        named: true,
        through: cursor(0),
        covered: true,
      },
      {
        name: 'accepted and not named',
        setup: 'accepted',
        named: false,
        through: cursor(99),
        covered: false,
      },
      {
        name: 'dead-letter and named',
        setup: 'dead-letter',
        named: true,
        through: cursor(99),
        install: true,
        covered: false,
      },
      {
        name: 'cancelled and named',
        setup: 'cancelled',
        named: true,
        through: cursor(99),
        install: true,
        covered: false,
      },
      {
        name: "another principal's queued entry, named",
        setup: 'queued',
        foreign: true,
        named: true,
        through: cursor(99),
        covered: false,
      },
      {
        name: "another principal's applied entry without a receipt",
        setup: 'applied',
        foreign: true,
        named: false,
        through: cursor(99),
        covered: false,
      },
    ]

    for (const c of cases) {
      it(c.name, async () => {
        const reply = deferred<OutboxSubmitOutcome>()
        const submitted = deferred<void>()
        const respond: Responder = () => {
          submitted.resolve()
          switch (c.setup) {
            case 'sending':
              return reply.promise
            case 'accepted':
              return { kind: 'accepted' }
            case 'dead-letter':
              return { kind: 'rejected', refusal: { kind: 'unauthorized' } }
            default:
              return appliedWith(c.receipt)
          }
        }
        const store = new InMemoryOutboxStore()
        const author = await harness(respond, {
          store,
          principal: c.foreign ? 'u-grace' : 'u-ada',
          idPrefix: c.foreign ? 'g' : 'm',
        })
        const M = (await author.outbox.enqueue(close('POD-1', c.foreign ? GRACE : ADA))).mutationId
        let draining: Promise<void> = Promise.resolve()
        if (c.setup === 'cancelled') await author.outbox.discard(M)
        else if (c.setup !== 'queued') {
          draining = author.outbox.drain()
          await submitted.promise
          if (c.setup !== 'sending') await draining
        }
        expect(author.outbox.find(M)?.state).toBe(c.setup)

        const { outbox } = c.foreign ? await harness(() => appliedWith(), { store }) : author
        const ev = evidence(c.through, { confirmed: c.named ? [M] : [], install: c.install })
        expect(outbox.isConfirmable(ev)).toBe(c.covered)
        expect(await outbox.confirm(ev)).toEqual(c.covered ? [M] : [])
        expect(store.durable().some((r) => r.mutationId === M)).toBe(!c.covered)

        reply.resolve(appliedWith())
        await draining
      })
    }
  })
})
