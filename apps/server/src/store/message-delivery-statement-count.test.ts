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
  it('pendingForPage: one keyset page of a target', async () => {
    await expectConstantStatements(
      pin(
        'pendingForPage',
        (store) => store.messages.pendingForPage({ kind: 'issue', id: 'iss_busy' }, { limit: 500 }),
        (rows, size) => expect(rows).toHaveLength(size),
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

  // POD-6174: the flush reads one page per delivery target (and attempts each
  // message on its own), so its count grows with the number of targets.
  it.skip('delivery flush: one page read for every waiting target (POD-6174)', async () => {
    await expectConstantStatements(
      pin(
        'flushDeliveryTriggers',
        async (store, size) => {
          const attempted: string[] = []
          const scheduler = new DeliveryScheduler({
            messages: store.messages,
            worldIndex: { pendingCount: () => 1 },
            now: () => '2026-10-15T01:00:00.000Z',
            runner: {
              targetOf: (row) => ({ kind: 'issue', id: row.toId ?? '' }),
              attemptOne: (row) => void attempted.push(row.id),
              nowMs: () => 0,
            },
          })
          for (let i = 0; i < size; i++) await scheduler.queueDeliveryTarget({ kind: 'issue', id: `iss_${i}` })
          await scheduler.flushDeliveryTriggers()
          return attempted
        },
        (attempted, size) => expect(attempted).toHaveLength(size),
      ),
      1,
    )
  })
})
