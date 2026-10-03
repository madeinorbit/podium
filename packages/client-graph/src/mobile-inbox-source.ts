import type { ClientRuntime } from '@podium/client-core/engine'
import { compareStructural, computed, observable, runInAction } from 'mobx'
import type { MobxPool } from './pool'
import type { MobileInboxRows } from './mobile-inbox-schema'
import { LOADING, type Loaded } from './worklist/rollup'

/** Lazily attached by PoolSources.ensure under the fixed mobile-inbox key.
 * Only cursor progress is borrowed from the existing replica. Entity values
 * and cold summaries always pass through pool.row. */
export class MobileInboxSource {
  private readonly state = observable.box<Loaded<MobileInboxRows['mobileInboxState']>>(LOADING, { deep: false })
  private demanded = false
  private scheduled = false
  private disposed = false
  private readonly stop: () => void
  readonly counts = { batches: 0, prefixReads: 0 }
  private readonly prefixes

  constructor(private readonly runtime: Pick<ClientRuntime, 'replica' | 'subscribe'>, pool: MobxPool) {
    this.stop = runtime.subscribe(() => { if (this.demanded) this.schedule() })
    this.prefixes = computed((): Loaded<MobileInboxRows['mobileReferencePrefixes']> => {
      this.counts.prefixReads++
      const used = new Set<string>()
      // Resident membership comes from the declared inverse, never an issue
      // walk or an index that includes cold payloads.
      for (const id of pool.tables.repo.keys()) if (pool.graph.size('repo', id, 'issues') > 0) used.add(id)
      // Cold history contributes only its explicitly declared repoId summary.
      // This shared summary is cached once per pool, not once per chip/token.
      let loading = false
      for (const id of pool.residency?.ids('issue', true) ?? []) {
        const row = pool.row('issue', id, 'summary') as Loaded<{ repoId?: string }>
        if (row === LOADING) loading = true
        else if (row?.repoId) used.add(row.repoId)
      }
      const prefixes = new Set<string>()
      for (const id of used) {
        const row = pool.row('repo', id) as Loaded<{ prefix?: string }>
        if (row === LOADING) loading = true
        else if (row?.prefix) prefixes.add(row.prefix)
      }
      return loading ? LOADING : { prefixes: [...prefixes].sort() }
    }, { equals: compareStructural })
  }

  read<E extends keyof MobileInboxRows>(entity: E, _id: string): Loaded<MobileInboxRows[E]> {
    if (this.disposed) return LOADING
    this.demanded = true
    if (this.state.get() === LOADING) this.schedule()
    return (entity === 'mobileReferencePrefixes' ? this.prefixes.get() : this.state.get()) as Loaded<MobileInboxRows[E]>
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) return
      const hasCursor = this.runtime.replica.getCursor() !== null
      runInAction(() => {
        if (this.state.get() === LOADING || (this.state.get() as MobileInboxRows['mobileInboxState']).hasCursor !== hasCursor)
          this.state.set({ hasCursor })
        this.counts.batches++
      })
    })
  }

  dispose(): void { this.disposed = true; this.stop() }
}
