/**
 * THE WRITER A MESSAGES TEST WRITES WITH (POD-6602).
 *
 * The delivery service takes the writer of whoever asked, per call, and writes
 * its own work on its declared origins. A unit test with no Ledger hands it
 * this: the commit's write runs with a fixture scope, inside the store's
 * transaction when a store is given (so "one write" still means one
 * transaction), and its `apply` follows. Nothing is appended: the messages
 * table's own feed capture, when a test installs one, still sees every row.
 */

import type { LedgerWriter } from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import type { MessageServiceWriters } from '../modules/messages/service'

type Transact = { transact<T>(fn: () => Promise<T>): Promise<T> }

/** A commit (and an empty capture) for a messages test. */
export function messageTestWriter(store?: Transact): Pick<LedgerWriter, 'commit' | 'capture'> {
  return {
    commit: async (op) => {
      const run = async () => {
        const result = await op.write(fixtureWriteScope())
        await op.changes(result)
        return result
      }
      const result = store ? await store.transact(run) : await run()
      op.apply?.(result, [])
      return { result, changes: [] }
    },
    capture: async () => [],
  }
}

/** The delivery service's own writers, for a test. */
export function messageTestWriters(store?: Transact): MessageServiceWriters {
  const writer = messageTestWriter(store)
  return { daemon: writer, delivery: writer }
}
