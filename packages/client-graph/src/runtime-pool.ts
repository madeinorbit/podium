import { createWorklistPool, type WorklistPoolHandle } from './create'
import { measureWorklistPoolDelivery, observeWorklistPoolPerf } from './sidebar-perf'
import { createEngineLocals, type LocalsEngine } from './shared/engine-locals'
import { createRowSource, type RowSourceReplica, type RowSourceRuntime } from './shared/row-source'
import { computed, reaction, compareStructural } from 'mobx'
import type { MobxPool } from './pool'

/** React's scalar/layout readers share MobX tracking without eagerly loading
 * the graph in legacy mode. Rows use observer directly; this seam is for the
 * palette and project controls, which need only a small section projection. */
export function createPoolProjection<T>(pool: MobxPool, read: (pool: MobxPool) => T) {
  const value = computed(() => read(pool), { equals: compareStructural })
  let snapshot = value.get()
  return {
    getSnapshot: () => snapshot,
    subscribe: (wake: () => void) => reaction(() => value.get(), next => {
      if (compareStructural(snapshot, next)) return
      snapshot = next
      wake()
    }, { fireImmediately: true }),
  }
}

/** Structural seam satisfied by the app's StoreProvider runtime. */
export type WorklistRuntime = RowSourceRuntime &
  LocalsEngine & { readonly replica: RowSourceReplica }

/** A read-only attachment: optimism and every write still belong to the runtime. */
export function createRuntimeWorklistPool(runtime: WorklistRuntime): WorklistPoolHandle {
  const rows = createRowSource(runtime, runtime.replica, { mode: 'overlaid' })
  let locals: ReturnType<typeof createEngineLocals> | undefined
  let handle: WorklistPoolHandle | undefined
  let stopPerf: (() => void) | undefined
  try {
    locals = createEngineLocals(runtime)
    handle = createWorklistPool(
      {
        ...rows.source,
        subscribe: (listener) =>
          rows.source.subscribe((event) => {
            measureWorklistPoolDelivery(runtime, () => listener(event))
          }),
      },
      locals.source,
    )
    stopPerf = observeWorklistPoolPerf(runtime, handle.pool)
  } catch (error) {
    handle?.dispose()
    locals?.dispose()
    rows.dispose()
    throw error
  }
  const attached = handle
  let disposed = false
  return {
    pool: attached.pool,
    dispose(): void {
      if (disposed) return
      disposed = true
      stopPerf?.()
      try {
        attached.dispose()
      } finally {
        locals?.dispose()
        rows.dispose()
      }
    },
  }
}
