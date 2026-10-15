/**
 * The statement-count harness itself [POD-6149]: it must pass a constant
 * operation and fail a planted per-row loop, naming the query that grew.
 */
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import {
  countStatements,
  expectConstantStatements,
  type StatementPin,
} from '../test-support/statement-count'

const ids = (size: number) => Array.from({ length: size }, (_, i) => asSessionId(`count-${i}`))

const pinOf = (
  name: string,
  run: (store: SessionStore, size: number) => Promise<unknown>,
): StatementPin<SessionStore> => ({
  name,
  setup: async () => await openTestStore(':memory:'),
  target: (store) => store,
  run,
  teardown: async (store) => await store.close(),
})

describe('statement-count harness', () => {
  it('counts every statement the operation runs and nothing outside it', async () => {
    const store = await openTestStore(':memory:')
    try {
      await store.sessions.getSession(asSessionId('before'))
      const counted = await countStatements(store, async () => {
        await store.sessions.getSession(asSessionId('a'))
        await store.sessions.getSession(asSessionId('b'))
        return 'done'
      })
      await store.sessions.getSession(asSessionId('after'))
      expect(counted.result).toBe('done')
      expect(counted.statements).toBe(2)
      expect([...counted.byQuery.values()]).toEqual([2])
    } finally {
      await store.close()
    }
  })

  it('passes an operation whose count does not depend on the data size', async () => {
    const counts = await expectConstantStatements(
      pinOf('one batched read', async (store, size) => await store.sync.queuedMessageCounts(ids(size))),
      1,
    )
    expect(counts.large.statements).toBe(1)
  })

  it('is armed: a planted query-per-row loop fails and names the growing query', async () => {
    const planted = pinOf('planted loop', async (store, size) => {
      for (const id of ids(size)) await store.sessions.getSession(id)
    })
    await expect(expectConstantStatements(planted, 5)).rejects.toThrow(
      /planted loop: 5 statements at 5 rows, 200 at 200\n! 5 -> 200 {2}select "id", "owner_user_id"/,
    )
  })

  it('is armed: one statement added outside any loop moves the pinned constant', async () => {
    const extra = pinOf('one extra statement', async (store, size) => {
      await store.sync.queuedMessageCounts(ids(size))
      await store.sessions.getSession(asSessionId('extra'))
    })
    await expect(expectConstantStatements(extra, 1)).rejects.toThrow(
      /one extra statement: pinned at 1 statements, ran 2/,
    )
  })
})
