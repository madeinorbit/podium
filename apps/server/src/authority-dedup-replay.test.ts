/** The model rows, their log and a restart agree even across rolled-back spans. */
import type { EntityChangeSpec } from '@podium/sync'
import { testLedgerWriter } from '@podium/sync/testing'
import { describe, expect, it } from 'vitest'
import { afterCommit } from './store/executor/executor'
import { StoreModelLedger } from './test-support/model-ledger'
import { openTestStore } from './test-support/open-test-store'

const row = (id: string, value: number): EntityChangeSpec => ({
  entity: 'conversation',
  id,
  op: 'upsert',
  value: { id, value },
})

describe('model comparison replay', () => {
  it('keeps source rows and changes identical through nesting, rollback and restart', async () => {
    const store = await openTestStore(':memory:')
    try {
      const create = () =>
        new StoreModelLedger(store, {
          repo: store.sync,
          now: () => 1_000,
          transact: (fn) => store.transact(fn),
          postCommit: (step, label) => afterCommit(step, label),
        })
      let ledger = create()
      const expected = new Map<string, unknown>()
      for (let round = 0; round < 12; round++) {
        const id = `c${round % 4}`
        const spec = row(id, round)
        await testLedgerWriter(ledger).commit(ledger.rowWrite([spec]))
        expected.set(id, spec.value)
        const cursor = await ledger.cursor()
        await expect(
          store.transact(async () => {
            await testLedgerWriter(ledger).commit(ledger.rowWrite([row('rolled-back', round)]))
            await store.transact(async () => {
              await testLedgerWriter(ledger).commit(ledger.rowWrite([row(id, 999)]))
            })
            throw new Error('rollback')
          }),
        ).rejects.toThrow('rollback')
        expect(await ledger.cursor()).toBe(cursor)
        ledger = create()
        expect(
          new Map(
            (await ledger.authority.snapshot('conversation')).map((value) => [
              (value as { id: string }).id,
              value,
            ]),
          ),
        ).toEqual(expected)
        expect((await testLedgerWriter(ledger).commit(ledger.rowWrite([spec]))).changes).toEqual([])
      }
      expect(await store.sync.maxChangeSeq()).toBe(12)
    } finally {
      await store.close()
    }
  })
})
