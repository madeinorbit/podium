/**
 * Pending-message counts come from SQL (POD-6155 step 4).
 *
 * Before the world index's counters were deleted, this test compared them
 * (`WorldIndex.reader.pendingCount`) with the indexed SQL count
 * (`MessagesRepository.countPending`) for every delivery target over the
 * benchmark corpus's ids (POD-6146: cell h1a1, seed 4443), at the commit that
 * adds this file. What stays is a regression test over a smaller set: the
 * count equals the number of the target's rows in a pending status, read back
 * row by row, with messages in every delivery status — queued, on its way,
 * delivered, read, failed, cancelled, expired — after a second wave of
 * transitions and a rolled-back one; operator (chat) messages, which are never
 * delivery targets, never move an issue or session count; and a delivery
 * trigger reads nothing, however much mail is pending (POD-6219: it used to
 * count its target's rows; the flush's page read answers the same question).
 */

import { createHash } from 'node:crypto'
import { asSessionId, asThreadId, isMessagePending, type MessageDeliveryStatus } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { MessageRow, SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { seedMessage } from '../../test-support/seed-message'
import { expectConstantStatements } from '../../test-support/statement-count'
import { DeliveryScheduler } from './scheduler'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const at = '2026-10-15T00:00:00.000Z'
const hash = (value: string) => createHash('sha256').update(value).digest().readUInt32BE(0)
const STATUSES: MessageDeliveryStatus[] = ['stored', 'dispatched', 'typed', 'confirmed', 'failed', 'cancelled', 'expired']

function message(id: string, toKind: MessageRow['toKind'], toId: string | null, status: MessageDeliveryStatus) {
  const deliveredTo = status === 'typed' || status === 'dispatched' ? asSessionId(`delivered-${id}`) : null
  return {
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: null,
    fromIssue: null,
    toKind,
    toId,
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: id,
    expiresAt: null,
    createdAt: at,
    deliveryStatus: status,
    deliveredAt: null,
    deliveredTo,
    readAt: null,
    injectedAt: null,
    deadLetteredAt: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    factKey: null,
    factTarget: null,
    expectsResponse: false,
  } as unknown as MessageRow
}

type Target = { kind: 'issue' | 'session'; id: string }

/** The SQL count against the rows' own statuses, read back one by one. */
async function expectCounts(store: SessionStore, targets: readonly Target[], seeded: readonly { id: string; target: Target }[]) {
  const pending = new Map<string, number>()
  for (const { id, target } of seeded) {
    const row = await store.messages.getMessage(id)
    if (row && isMessagePending(row.deliveryStatus)) {
      const key = `${target.kind}:${target.id}`
      pending.set(key, (pending.get(key) ?? 0) + 1)
    }
  }
  for (const target of targets) {
    expect(await store.messages.countPending(target), `${target.kind} ${target.id}`).toBe(pending.get(`${target.kind}:${target.id}`) ?? 0)
  }
}

describe('pending counts come from SQL', () => {
  it('for every status, after a second wave of transitions and a rolled-back one', async () => {
    const store = await openTestStore(':memory:')
    stores.push(store)
    const targets: Target[] = [
      ...Array.from({ length: 40 }, (_, i): Target => ({ kind: i % 2 ? 'issue' : 'session', id: `${i % 2 ? 'iss_' : 'session-'}${i}` })),
      { kind: 'issue', id: 'iss_never-addressed' },
      { kind: 'session', id: 'session-never-addressed' },
    ]
    const seeded: { id: string; target: (typeof targets)[number] }[] = []
    const writes: (() => Promise<void>)[] = []
    for (const target of targets.slice(0, -2)) {
      const n = hash(`${target.kind}:${target.id}`) % 4
      for (let i = 0; i < n; i++) {
        const id = `msg-${target.kind}-${target.id}-${i}`
        const status = STATUSES[hash(id) % STATUSES.length]!
        seeded.push({ id, target })
        writes.push(async () => await seedMessage(store.messages, message(id, target.kind, target.id, status)))
      }
    }
    // Operator (chat) messages: never a delivery target, never in an issue or session count.
    for (let i = 0; i < 50; i++) {
      writes.push(async () => await seedMessage(store.messages, message(`op-${i}`, 'operator', null, i % 3 ? 'stored' : 'confirmed')))
    }
    for (let i = 0; i < writes.length; i += 500) {
      await store.transact(async () => {
        for (const write of writes.slice(i, i + 500)) await write()
      })
    }
    expect(seeded.length).toBeGreaterThan(30)
    expect(new Set(await Promise.all(seeded.map(async ({ id }) => (await store.messages.getMessage(id))?.deliveryStatus))).size).toBeGreaterThan(4)
    await expectCounts(store, targets, seeded)

    // Second wave: move a slice of the rows on, through the production moves.
    await store.transact(async () => {
      for (const { id } of seeded.filter(({ id }) => hash(`wave:${id}`) % 3 === 0)) {
        switch (hash(`move:${id}`) % 5) {
          case 0: await store.messages.markDelivered(id, null, at); break
          case 1: await store.messages.markDispatched(id, asSessionId(`delivered-${id}`), at); break
          case 2: await store.messages.markDeadLetter(id, at); break
          case 3: await store.messages.expireObserved({ id, createdAt: at, lifecycle: 'wait', expiresAt: null }); break
          case 4: await store.messages.markRead(id, null, at); break
        }
      }
    })
    await expectCounts(store, targets, seeded)

    // A rolled-back wave moves neither.
    const before = await Promise.all(targets.slice(0, 50).map(async (target) => await store.messages.countPending(target)))
    await expect(store.transact(async () => {
      for (const { id } of seeded.slice(0, 200)) await store.messages.markCancelled(id)
      throw new Error('roll back')
    })).rejects.toThrow('roll back')
    expect(await Promise.all(targets.slice(0, 50).map(async (target) => await store.messages.countPending(target)))).toEqual(before)
    await expectCounts(store, targets, seeded)
  })

  it('a delivery trigger reads nothing, however much mail is pending', async () => {
    await expectConstantStatements(
      {
        name: 'queueDeliveryTarget',
        setup: async (size) => {
          const store = await openTestStore(':memory:')
          stores.push(store)
          for (let i = 0; i < size; i++) await seedMessage(store.messages, message(`pending-${i}`, 'issue', 'iss_busy', 'stored'))
          const scheduler = new DeliveryScheduler({
            messages: store.messages,
            now: () => at,
            runner: { targetOf: () => null, nowMs: () => 0, attemptPass: () => {} },
          })
          return { store, scheduler }
        },
        target: (f) => f.store,
        run: async (f) => {
          f.scheduler.queueDeliveryTarget({ kind: 'issue', id: 'iss_busy' })
          return f.scheduler.deliveryStats()
        },
        check: (stats) => expect(stats).toMatchObject({ pendingTargetCount: 1 }),
        teardown: (f) => f.scheduler.dispose(),
      },
      0,
    )
  })
})
