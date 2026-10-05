import type { ClientRuntime } from '@podium/client-core/engine'
import { observable, runInAction } from 'mobx'
import type { MobileInboxRows } from './mobile-inbox-schema'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

/** Lazily attached by PoolSources.ensure under the fixed mobile-inbox key.
 * Only cursor progress is borrowed from the existing replica. Entity values
 * and cold summaries always pass through pool.row. */
export class MobileInboxSource {
  private readonly state = observable.box<Loaded<MobileInboxRows['mobileInboxState']>>(LOADING, {
    deep: false,
  })
  private demanded = false
  private scheduled = false
  private disposed = false
  private readonly stop: () => void
  readonly counts = { batches: 0 }

  constructor(
    private readonly runtime: Pick<ClientRuntime, 'replica'>,
    _pool: MobxPool,
  ) {
    // Keyed (POD-5433): only a cursor move can change `hasCursor`.
    if (!runtime.replica.subscribeCursor) throw new Error('Mobile inbox requires the replica cursor signal')
    this.stop = runtime.replica.subscribeCursor(() => {
      if (this.demanded) this.schedule()
    })
  }

  read<E extends keyof MobileInboxRows>(_entity: E, _id: string): Loaded<MobileInboxRows[E]> {
    if (this.disposed) return LOADING
    this.demanded = true
    if (this.state.get() === LOADING) this.schedule()
    return this.state.get() as Loaded<MobileInboxRows[E]>
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) return
      const hasCursor = this.runtime.replica.getCursor() !== null
      runInAction(() => {
        if (
          this.state.get() === LOADING ||
          (this.state.get() as MobileInboxRows['mobileInboxState']).hasCursor !== hasCursor
        )
          this.state.set({ hasCursor })
        this.counts.batches++
      })
    })
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }
}
