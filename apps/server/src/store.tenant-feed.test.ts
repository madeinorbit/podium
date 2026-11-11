import { SyncRepository } from '@podium/sync/adapters/sqlite/sync-repository'
import { describe, expect, it, vi } from 'vitest'
import { openTestStore } from './test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from './test-support/statement-count'

type Store = Awaited<ReturnType<typeof openTestStore>>
const pin: StatementPin<Store> = {
  name: 'tenant batch reservation and append',
  sizes: [5, 50],
  setup: async () => await openTestStore(':memory:'),
  target: (store) => store,
  run: (store, size) =>
    store.sync.appendChanges(
      Array.from({ length: size }, (_, i) => ({
        entity: 'issueProjection',
        entityId: `i${i}`,
        op: 'upsert',
        payload: '{}',
      })),
      1,
    ),
  check: async (result, store, size) => {
    expect(result).toEqual(Array.from({ length: size }, (_, i) => i + 1))
    expect(await store.sync.changesSince(0)).toHaveLength(size)
  },
  teardown: (store) => store.close(),
}

describe('tenant write transaction', () => {
  it('reserves once per batch and inserts once per chunk', async () => {
    await expectConstantStatements(pin, 2)
    await expectArmed(pin, 2, (store) => {
      const append = SyncRepository.prototype.appendChanges
      const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementation(async (rows, time) => {
        for (const _row of rows) await store.sync.maxChangeSeq()
        return await append.call(store.sync, rows, time)
      })
      return () => spy.mockRestore()
    })
  })

  it('serializes simultaneous writers in commit order without losing a batch', async () => {
    const store = await openTestStore(':memory:')
    try {
      const assigned = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.sync.appendChanges(
            [{ entity: 'issueProjection', entityId: `i${i}`, op: 'upsert', payload: '{}' }],
            i,
          ),
        ),
      )
      expect(assigned.flat()).toEqual(Array.from({ length: 10 }, (_, i) => i + 1))
      expect((await store.sync.changesSince(0)).map((row) => row.entityId)).toEqual(
        Array.from({ length: 10 }, (_, i) => `i${i}`),
      )
    } finally {
      await store.close()
    }
  })
})
