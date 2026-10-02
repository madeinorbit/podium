import type { RoutedUiState } from '@podium/client-core/ui-state'
import { attachHeaderSource } from './header-source'
import { compareStructural, computed, reaction } from 'mobx'
import { createWorklistPool, type WorklistPoolHandle } from './create'
import type { MobxPool } from './pool'
import { createEngineLocals, type LocalsEngine } from './shared/engine-locals'
import { createRowSource, type RowSourceReplica, type RowSourceRuntime } from './shared/row-source'
import { measureWorklistPoolDelivery, observeWorklistPoolPerf } from './sidebar-perf'
import type { ResolveIssueReferences } from './residency'

/** React's scalar/layout readers share MobX tracking without eagerly loading
 * the graph in legacy mode. Rows use observer directly; this seam is for the
 * palette and project controls, which need only a small section projection. */
export function createPoolProjection<T>(pool: MobxPool, read: (pool: MobxPool) => T) {
  const value = computed(() => read(pool), { equals: compareStructural })
  let snapshot = value.get()
  return {
    getSnapshot: () => snapshot,
    subscribe: (wake: () => void) =>
      reaction(
        () => value.get(),
        (next) => {
          if (compareStructural(snapshot, next)) return
          snapshot = next
          wake()
        },
        { fireImmediately: true },
      ),
  }
}

/** Structural seam satisfied by the app's StoreProvider runtime. */
export type WorklistRuntime = RowSourceRuntime &
  LocalsEngine & { readonly replica: RowSourceReplica; readonly ui?: RoutedUiState }

/** A read-only attachment: optimism and every write still belong to the runtime. */
export function createRuntimeWorklistPool(runtime: WorklistRuntime, options: { preferences?: boolean; settings?: boolean; header?: boolean; resolveReferences?: ResolveIssueReferences } = {}): WorklistPoolHandle {
  const rows = createRowSource(runtime, runtime.replica, { mode: 'overlaid' })
  let locals: ReturnType<typeof createEngineLocals> | undefined
  let handle: WorklistPoolHandle | undefined
  let stopHeader: (() => void) | undefined
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
      { header: options.header, settings: options.settings, ...(options.resolveReferences ? { resolveReferences: options.resolveReferences } : {}) },
    )
    if (options.preferences || options.settings) {
      if (!runtime.ui) throw new Error('Preferences require the existing runtime UI owner')
      handle.pool.attachPreferences(runtime.ui)
    }
    if (options.settings) handle.pool.attachSettings(runtime)
    if (options.header) stopHeader = attachHeaderSource(handle.pool, runtime as Parameters<typeof attachHeaderSource>[1])
    stopPerf = observeWorklistPoolPerf(runtime, handle.pool)
  } catch (error) {
    stopHeader?.()
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
      stopHeader?.()
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
