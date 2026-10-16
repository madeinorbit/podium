/**
 * Message delivery reads run a fixed number of statements, whatever the
 * number of queued messages [POD-6149, server-data rule 8].
 */
import { asThreadId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { DeliveryScheduler } from '../modules/messages/scheduler'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { expectConstantStatements, type StatementPin } from '../test-support/statement-count'
import type { MessageRow } from './types'

const message = (id: string, toId: string, createdAt: string): MessageRow => ({
  id,
  threadId: asThreadId(id),
  inReplyTo: null,
  fromKind: 'agent',
  fromSession: null,
  fromIssue: null,
  toKind: 'issue',
  toId,
  kind: 'message',
  urgency: 'fyi',
  lifecycle: 'wait',
  body: id,
  expiresAt: null,
  createdAt,
  deliveryStatus: 'stored',
  deliveredAt: null,
  deliveredTo: null,
  ackedBy: null,
  hop: 0,
  clampedFrom: null,
  remindedAt: null,
  expectsResponse: false,
})

/** `size` queued messages to one issue, and one more to each of `size` other issues. */
async function fixture(size: number): Promise<SessionStore> {
  const store = await openTestStore(':memory:')
  for (let i = 0; i < size; i++) {
    const at = `2026-10-15T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`
    await store.messages.addMessage(message(`busy-${i}`, 'iss_busy', at))
    await store.messages.addMessage(message(`spread-${i}`, `iss_${i}`, at))
  }
  return store
}

const pin = (
  name: string,
  run: (store: SessionStore, size: number) => Promise<unknown>,
  check: (result: unknown, size: number) => void,
): StatementPin<SessionStore> => ({
  name,
  setup: fixture,
  target: (store) => store,
  run,
  check: (result, _store, size) => check(result, size),
  teardown: async (store) => await store.close(),
})

describe('message delivery: pinned statement counts at 5 and 200 queued messages', () => {
  it('pendingForPages: one keyset page of every target', async () => {
    await expectConstantStatements(
      pin(
        'pendingForPages',
        (store, size) =>
          store.messages.pendingForPages(
            [{ kind: 'issue' as const, id: 'iss_busy' }, ...Array.from({ length: size }, (_, i) => ({ kind: 'issue' as const, id: `iss_${i}` }))]
              .map((to) => ({ to })),
            500,
          ),
        (pages, size) => {
          const [busy, ...spread] = pages as MessageRow[][]
          expect(busy).toHaveLength(size)
          expect(spread.map((page) => page.length)).toEqual(Array.from({ length: size }, () => 1))
        },
      ),
      1,
    )
  })

  it('listQueuedPage: one keyset page of the whole queue', async () => {
    await expectConstantStatements(
      pin(
        'listQueuedPage',
        (store) => store.messages.listQueuedPage({ limit: 2000 }),
        (rows, size) => expect(rows).toHaveLength(size * 2),
      ),
      1,
    )
  })

  it('countQueued: one count', async () => {
    await expectConstantStatements(
      pin('countQueued', (store) => store.messages.countQueued(), (n, size) => expect(n).toBe(size * 2)),
      1,
    )
  })

  // A trigger's own count (one per queueDeliveryTarget) is pinned in
  // pending-count-parity.test.ts; the targets are queued in setup, so this
  // counts the coalesced flush alone.
  it('delivery flush: one read for every waiting target', async () => {
    await expectConstantStatements<{ store: SessionStore; scheduler: DeliveryScheduler; attempted: string[] }>(
      {
        name: 'flushDeliveryTriggers',
        setup: async (size) => {
          const store = await fixture(size)
          const attempted: string[] = []
          const scheduler = new DeliveryScheduler({
            messages: store.messages,
            now: () => '2026-10-15T01:00:00.000Z',
            runner: {
              targetOf: (row) => ({ kind: 'issue', id: row.toId ?? '' }),
              attemptPass: (rows) => void attempted.push(...rows.map((row) => row.id)),
              nowMs: () => 0,
            },
          })
          await scheduler.queueDeliveryTarget({ kind: 'issue', id: 'iss_busy' })
          for (let i = 0; i < size; i++) await scheduler.queueDeliveryTarget({ kind: 'issue', id: `iss_${i}` })
          return { store, scheduler, attempted }
        },
        target: ({ store }) => store,
        run: async ({ scheduler, attempted }) => {
          await scheduler.flushDeliveryTriggers()
          // At 200 the busy target's page is full, so it is queued again for its next page.
          const requeued = scheduler.deliveryStats().pendingTargetCount
          scheduler.dispose()
          return { attempted: attempted.length, requeued }
        },
        check: (result, _fixture, size) =>
          expect(result).toEqual({ attempted: size * 2, requeued: size === 200 ? 1 : 0 }),
        teardown: async ({ store }) => await store.close(),
      },
      1,
    )
  })
})
