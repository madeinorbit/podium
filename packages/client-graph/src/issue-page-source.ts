import type { Replica } from '@podium/client-core/replica'
import { observable, runInAction } from 'mobx'
import type { IssuePageSourceRows } from './issue-page-schema'
import type { MobxPool } from './pool'
import type { PoolSource } from './source-registry'
import { LOADING, type Loaded } from './worklist/rollup'

/** Borrow the kernel's canonical exit evidence on demand. No exit ledger,
 * entity cache or mutation owner is copied into this source. */
export function attachIssuePageSource(pool: MobxPool, owner: { replica: Pick<Replica, 'exitKind' | 'subscribeAddressedBatch'> }): () => void {
  const epoch = observable.box(0)
  let disposed = false
  const subscribe = owner.replica.subscribeAddressedBatch?.bind(owner.replica)
  if (!subscribe) throw new Error('Issue page requires the addressed replica boundary')
  const stop = subscribe(batch => {
    if (batch.type === 'replace' || batch.rows.some(row => row.kind === 'issueProjections')) {
      runInAction(() => epoch.set(epoch.get() + 1))
    }
  })
  const source: PoolSource<'issueExit'> = {
    read(_entity, id): Loaded<IssuePageSourceRows['issueExit']> {
      if (disposed) return LOADING
      epoch.get()
      return { kind: owner.replica.exitKind?.('issueProjection', id) }
    },
    dispose() { if (!disposed) { disposed = true; stop() } },
  }
  pool.sources.register(['issueExit'], source)
  return () => source.dispose()
}
