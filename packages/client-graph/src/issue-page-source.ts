import type { Replica } from '@podium/client-core/replica'
import { createAtom, type IAtom, runInAction } from 'mobx'
import type { IssuePageSourceRows } from './issue-page-schema'
import type { MobxPool } from './pool'
import type { PoolSource } from './source-registry'
import { LOADING, type Loaded } from './worklist/rollup'

const trackedRead = createAtom('issueExit.trackedRead')

/** Borrow the kernel's canonical exit evidence on demand. No exit ledger,
 * entity cache or mutation owner is copied into this source.
 *
 * Per-id demand (finding 13, POD-5433; the shape of `session-exit-source.ts`):
 * each observed id has its own atom, so an issue batch wakes only the readers
 * of the ids it names, and an id leaves the set when its last reader goes. */
export function attachIssuePageSource(pool: MobxPool, owner: { replica: Pick<Replica, 'exitKind' | 'subscribeAddressedBatch'> }): () => void {
  const demanded = new Map<string, IAtom>()
  let disposed = false
  const subscribe = owner.replica.subscribeAddressedBatch?.bind(owner.replica)
  if (!subscribe) throw new Error('Issue page requires the addressed replica boundary')
  const counts = { wakes: 0 }
  const stop = subscribe(batch => {
    if (demanded.size === 0) return
    const atoms = batch.type === 'replace' ? [...demanded.values()]
      : batch.rows.flatMap(row => row.kind === 'issueProjections' ? demanded.get(row.id) ?? [] : [])
    if (atoms.length === 0) return
    counts.wakes += atoms.length
    runInAction(() => { for (const atom of atoms) atom.reportChanged() })
  })
  const source: PoolSource<'issueExit'> & { counts: typeof counts } = {
    counts,
    read(_entity, id): Loaded<IssuePageSourceRows['issueExit']> {
      if (disposed) return LOADING
      if (trackedRead.reportObserved()) {
        const known = demanded.get(id)
        const atom: IAtom = known ?? createAtom(`issueExit:${id}`, undefined, () => {
          if (demanded.get(id) === atom) demanded.delete(id)
        })
        demanded.set(id, atom)
        if (!atom.reportObserved() && known === undefined) demanded.delete(id)
      }
      return { kind: owner.replica.exitKind?.('issueProjection', id) }
    },
    dispose() { if (!disposed) { disposed = true; stop(); demanded.clear() } },
  }
  pool.sources.register(['issueExit'], source)
  return () => source.dispose()
}
