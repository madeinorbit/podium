import type { Replica } from '@podium/client-core/replica'
import { observable, runInAction } from 'mobx'
import type { SessionExitRows } from './session-exit-schema'
import type { PoolSource } from './source-registry'
import { LOADING } from './worklist/rollup'

export const SESSION_EXIT_SOURCE_KEY = 'session-exits'

/** Borrow the canonical exit evidence in a demand batch. The existing replica
 * remains its owner; unknown rows make no claim about removal or visibility. */
export function createSessionExitSource(owner: { replica: Pick<Replica, 'exitKind' | 'subscribeAddressedBatch'> }): PoolSource<'sessionExit'> {
  const rows = observable.map<string, SessionExitRows['sessionExit']>(undefined, { deep: false })
  const demanded = new Set<string>(), dirty = new Set<string>()
  let scheduled = false, disposed = false
  function schedule() {
    if (scheduled || disposed || !dirty.size) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed) return
      const ids = [...dirty]
      dirty.clear()
      const values = ids.map(id => ({ id, kind: owner.replica.exitKind?.('session', id) }))
      runInAction(() => {
        for (const { id, kind } of values) if (!rows.has(id) || rows.get(id)?.kind !== kind) rows.set(id, { kind })
      })
    })
  }
  const subscribe = owner.replica.subscribeAddressedBatch?.bind(owner.replica)
  if (!subscribe) throw new Error('Session exits require the addressed replica boundary')
  const stop = subscribe(batch => {
    if (batch.type === 'replace') for (const id of demanded) dirty.add(id)
    else for (const row of batch.rows) if (row.kind === 'sessions' && demanded.has(row.id)) dirty.add(row.id)
    schedule()
  })
  return {
    read(_entity, id) {
      if (disposed) return LOADING
      demanded.add(id)
      if (!rows.has(id)) { dirty.add(id); schedule(); return LOADING }
      return rows.get(id)
    },
    dispose() {
      if (disposed) return
      disposed = true
      stop(); demanded.clear(); dirty.clear()
      queueMicrotask(() => runInAction(() => rows.clear()))
    },
  }
}
