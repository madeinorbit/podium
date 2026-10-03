import type { SettingsOwner } from './settings-source'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { attachHeaderSource } from './header-source'
import { compareStructural, Reaction } from 'mobx'
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
    getSnapshot(nextRead = state.read): T {
      if (state.read !== nextRead) {
        state.read = nextRead
        state.dirty = true
      }
      if (observeProjection(state) && !state.listeners.size) {
        // React can abandon a render before subscribing. Use the same cleanup
        // as observer components, including its fallback on engines without GC hooks.
        _observerFinalizationRegistry.register(view, state, state)
      }
      refreshProjection(state)
      if (state.error !== null) throw state.error.cause
      return state.snapshot!.value
    },
    subscribe(wake: () => void): () => void {
      const before = state.snapshot, error = state.error, version = state.version
      observeProjection(state)
      // Lazy reader construction can publish observable initialization during
      // tracking. Settle those real changes before attaching an imperative watch.
      while (state.dirty) refreshProjection(state)
      _observerFinalizationRegistry.unregister(state)
      const listener = () => wake()
      state.listeners.add(listener)
      // Imperative readers paint before subscribing. A lazy source can finish
      // initialization during that read; publish its newer snapshot at attachment.
      if ((before !== null || error !== null || state.version !== version) && (state.snapshot !== before || state.error !== error))
        wake()
      return () => {
        state.listeners.delete(listener)
        releaseProjection(state)
      }
    },
  }
  return view
}

interface ProjectionState<T> {
  readonly pool: MobxPool
  read: (pool: MobxPool) => T
  snapshot: { value: T } | null
  error: { cause: unknown } | null
  dirty: boolean
  version: number
  reaction: Reaction | null
  readonly listeners: Set<() => void>
}

// These helpers stay outside createPoolProjection: reaction closures must not
// share a context with the view, or they would retain the finalization target.
function projectionState<T>(pool: MobxPool, read: (pool: MobxPool) => T): ProjectionState<T> {
  return {
    pool,
    read,
    snapshot: null,
    error: null,
    dirty: true,
    version: 0,
    reaction: null,
    listeners: new Set(),
  }
}

function observeProjection<T>(state: ProjectionState<T>): boolean {
  if (state.reaction !== null) return false
  state.dirty = true
  state.reaction = new Reaction('pool projection', () => {
    state.dirty = true
    state.version++
    // Filter before notifying React or imperative consumers: equal projections
    // must not trigger owner renders, even when an observed input changes.
    if (state.listeners.size) {
      const before = state.snapshot, error = state.error
      refreshProjection(state)
      if (state.snapshot !== before || state.error !== error)
        for (const listener of [...state.listeners]) listener()
    }
  })
  return true
}

function refreshProjection<T>(state: ProjectionState<T>): void {
  if (!state.dirty) return
  state.dirty = false
  state.error = null
  let next!: T
  state.reaction!.track(() => {
    try {
      next = state.read(state.pool)
    } catch (cause) {
      state.error = { cause }
    }
  })
  if (state.error === null && (state.snapshot === null || !compareStructural(state.snapshot.value, next)))
    state.snapshot = { value: next }
}

function releaseProjection<T>(state: ProjectionState<T>): void {
  if (state.listeners.size) return
  state.reaction?.dispose()
  state.reaction = null
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
        // The pool's display reader follows first-in-replica order. The
        // replica's unique-only resolver keeps its existing ambiguity rule.
        ...(rows.source.issueIdsByRef ? { issueIdByRef: (ref: string) => rows.source.issueIdsByRef!(ref)[0] } : {}),
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
