import type { SettingsOwner } from './settings-source'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { attachHeaderSource } from './header-source'
import { $mobx, compareStructural, computed, reaction, type IComputedValue, type Reaction } from 'mobx'
import { _observerFinalizationRegistry } from 'mobx-react-lite'
import { createWorklistPool, type WorklistPoolHandle } from './create'
import type { MobxPool } from './pool'
import { createEngineLocals, type LocalsEngine } from './shared/engine-locals'
import { createRowSource, type RowSourceReplica, type RowSourceRuntime } from './shared/row-source'
import { measureWorklistPoolDelivery, observeWorklistPoolPerf } from './sidebar-perf'
import type { PoolSummaryFields } from './source-registry'

/** React's scalar/layout readers share MobX tracking without eagerly loading
 * the graph in legacy mode. Rows use observer directly; this seam is for the
 * palette and project controls, which need only a small section projection. */
export function createPoolProjection<T>(pool: MobxPool, read: (pool: MobxPool) => T) {
  const state = projectionState(pool, read)
  const view = {
    getSnapshot(): T {
      if (state.reaction === null) {
        observeProjection(state)
        // React can abandon a render before subscribing. Use the same cleanup
        // as observer components, including its fallback on engines without GC hooks.
        _observerFinalizationRegistry.register(view, state, state)
      }
      if (state.error !== null) throw state.error.cause
      return state.snapshot!.value
    },
    subscribe(wake: () => void): () => void {
      if (state.reaction === null) observeProjection(state)
      _observerFinalizationRegistry.unregister(state)
      const listener = () => wake()
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
        if (state.listeners.size !== 0) return
        state.reaction?.dispose()
        state.reaction = null
      }
    },
  }
  return view
}

interface ProjectionState<T> {
  readonly value: IComputedValue<T>
  snapshot: { value: T } | null
  error: { cause: unknown } | null
  reaction: Reaction | null
  readonly listeners: Set<() => void>
}

// Both factories stay outside createPoolProjection: even the computed's closure
// must not share a context with the view, or it would retain the finalization target.
function projectionState<T>(pool: MobxPool, read: (pool: MobxPool) => T): ProjectionState<T> {
  return {
    value: computed(() => read(pool), { equals: compareStructural }),
    snapshot: null,
    error: null,
    reaction: null,
    listeners: new Set(),
  }
}

function observeProjection<T>(state: ProjectionState<T>): void {
  const stop = reaction(
    () => state.value.get(),
    (next) => {
      const failed = state.error !== null
      state.error = null
      if (!failed && state.snapshot !== null && compareStructural(state.snapshot.value, next)) return
      state.snapshot = { value: next }
      for (const listener of [...state.listeners]) listener()
    },
    {
      fireImmediately: true,
      onError: (cause) => {
        state.error = { cause }
        for (const listener of [...state.listeners]) listener()
      },
    },
  )
  // The first read is already tracked. Subscription adopts this observer rather
  // than asking an unobserved computed to derive the same screen a second time.
  state.reaction = stop[$mobx]
}

/** Structural seam satisfied by the app's StoreProvider runtime. */
export type WorklistRuntime = RowSourceRuntime &
  LocalsEngine & { readonly replica: RowSourceReplica; readonly ui?: RoutedUiState }

/** A read-only attachment: optimism and every write still belong to the runtime. */
export function createRuntimeWorklistPool(runtime: WorklistRuntime, options: { preferences?: boolean; settings?: boolean; header?: boolean; summaries?: PoolSummaryFields } = {}): WorklistPoolHandle {
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
      { header: options.header, settings: options.settings, summaries: options.summaries },
    )
    if (options.preferences || options.settings) {
      if (!runtime.ui) throw new Error('Preferences require the existing runtime UI owner')
      handle.pool.attachPreferences(runtime.ui)
    }
    if (options.settings) {
      const state = runtime.getSnapshot()
      if (!Array.isArray(Reflect.get(state, 'machines')) || !Object.hasOwn(state, 'settingsTab')) {
        throw new Error('Settings require the existing runtime catalog and window owner')
      }
      // The shared row-source seam exposes only its repo inputs. The provider
      // runtime also owns the catalog/window fields checked above.
      handle.pool.attachSettings(runtime as WorklistRuntime & SettingsOwner)
    }
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
