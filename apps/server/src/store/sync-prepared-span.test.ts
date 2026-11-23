import { describe, expect, it } from 'vitest'
import { openTestStore } from '../test-support/open-test-store'

describe('prepared append statements across spans', () => {
  it('reuses the append after the transaction that prepared it has closed', async () => {
    const store = await openTestStore(':memory:')
    try {
      for (const id of ['first', 'second']) {
        await store.sync.appendChanges(
          [{ entity: 'issueProjection', entityId: id, op: 'upsert', payload: '{}' }],
          1,
        )
      }
      expect((await store.sync.changesSince(0)).map((row) => row.entityId)).toEqual([
        'first',
        'second',
      ])
    } finally {
      await store.close()
    }
  })
})
