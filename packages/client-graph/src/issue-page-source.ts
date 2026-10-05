import type { Replica } from '@podium/client-core/replica'
import { createDemandAtoms } from '@podium/mobx-helpers'
import { runInAction } from 'mobx'
import type { IssuePageSourceRows } from './issue-page-schema'
import type { MobxPool } from './pool'
import { defineSource } from './source-registry'
import type { Loaded } from './worklist/rollup'

/** Borrow the kernel's canonical exit evidence on demand. No exit ledger,
 * entity cache or mutation owner is copied into this source.
 *
 * Per-id demand (finding 13, POD-5433; the shape of `session-exit-source.ts`):
 * each observed id has its own atom, so an issue batch wakes only the readers
 * of the ids it names, and an id leaves the set when its last reader goes. */
export function attachIssuePageSource(pool: MobxPool, owner: { replica: Pick<Replica, 'exitKind' | 'subscribeAddressedBatch'> }): () => void {
  const demanded = createDemandAtoms<string>((id) => `issueExit:${id}`)
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
  const source = Object.assign(defineSource({
    readById(_entity: 'issueExit', id: string): Loaded<IssuePageSourceRows['issueExit']> {
      demanded.observe(id)
      return { kind: owner.replica.exitKind?.('issueProjection', id) }
    },
    release() { stop(); demanded.clear() },
  }), { counts })
  pool.sources.register(['issueExit'], source)
  return () => source.dispose()
}
