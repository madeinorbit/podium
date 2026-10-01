import { headerDataLayer, initializeHeaderDataLayer } from '@/lib/header-data-layer'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { reportSidebarPool } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { MobxPool, WorklistPoolHandle } from '@podium/client-graph'
import type { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import {
  initializeSidebarDataLayer,
  sidebarCheckRequested,
  sidebarDataLayer,
} from '@/lib/sidebar-data-layer'

interface PoolSlot {
  handle: WorklistPoolHandle | null
  error: Error | null
  listeners: Set<() => void>
  project: typeof createPoolProjection | null
}

// The store handle IS the runtime. Weak keys never retain a departed principal;
// clearing the slot also releases the pool from React's subscription closures.
const slots = new WeakMap<object, PoolSlot>()
const retired: { name: string; ref: WeakRef<object> }[] = []
let generation = 0

function slotFor(runtime: object): PoolSlot {
  let slot = slots.get(runtime)
  if (slot === undefined) {
    slot = { handle: null, error: null, listeners: new Set(), project: null }
    slots.set(runtime, slot)
  }
  return slot
}

function notify(slot: PoolSlot): void {
  for (const listener of slot.listeners) listener()
}

/** Force GC between turns, then check retired generations. This helper holds
 * only weak references; survivors() keeps its answers alive for the current job. */
export function worklistPoolSurvivors(): string[] {
  return retired.filter(({ ref }) => ref.deref() !== undefined).map(({ name }) => name)
}

function retire(pool: MobxPool): void {
  if (!import.meta.env.DEV) return
  generation += 1
  const owned = {
    pool,
    tables: pool.tables,
    relations: pool.graph,
    worklist: pool.worklist,
    groups: pool.groups,
    clock: pool.clock,
    residency: pool.residency,
  }
  for (const [name, object] of Object.entries(owned)) {
    if (object !== null) retired.push({ name: `${generation}.${name}`, ref: new WeakRef(object) })
  }
}

/** StoreProvider owns this teardown, including while the import is in flight.
 * No graph code, row feed, locals subscription or pool is built in legacy mode. */
export function attachWorklistPool<TApi extends PodiumClientApi>(
  runtime: ClientRuntime<TApi>,
  onError: (error: Error) => void,
): () => void {
  initializeSidebarDataLayer(runtime.ui)
  initializeHeaderDataLayer()
  if (sidebarDataLayer() !== 'pool' && headerDataLayer() !== 'pool') return () => {}
  reportSidebarPool(runtime, null, false)
  const slot = slotFor(runtime)
  slot.error = null
  let disposed = false
  let stopCheck: (() => void) | undefined
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    Object.assign(window, { __sidebarPool: { survivors: worklistPoolSurvivors } })
  }
  void import('@podium/client-graph/runtime-pool')
    .then(({ createRuntimeWorklistPool, createPoolProjection }) => {
      if (disposed) return
      slot.handle = createRuntimeWorklistPool(runtime, { header: headerDataLayer() === 'pool' })
      slot.project = createPoolProjection
      notify(slot)
      if (sidebarCheckRequested()) {
        const pool = slot.handle.pool
        void import('@podium/client-graph/diagnostics/runtime-check')
          .then(({ startSidebarCheck }) => {
            if (disposed) return
            stopCheck = startSidebarCheck(runtime, pool, {
              state: (store) => {
                const base = {
                  pinnedRepos: store.pins.repos,
                  pinnedWorktrees: store.pins.worktrees,
                  projectOrder: store.sidebarSettings.repoOrder,
                }
                const keys = [
                  'podium:sidebar:pinned-fold',
                  ...pool.sidebar
                    .sections(base)
                    .bands.flatMap((band) => [
                      band.foldKey,
                      band.snoozedFoldKey,
                      band.closedFoldKey,
                    ]),
                ]
                return {
                  pinnedRepos: store.pins.repos,
                  pinnedWorktrees: store.pins.worktrees,
                  projectOrder: store.sidebarSettings.repoOrder,
                  paneA: store.paneA,
                  selectedWorktree: store.selectedWorktree,
                  collapsed: Object.fromEntries(
                    keys.flatMap((key) => {
                      const raw = runtime.ui.get(key)
                      return raw === null ? [] : [[key, raw === 'true']]
                    }),
                  ),
                }
              },
            })
          })
          .catch(() => {
            /* Optional diagnostics must not take down the sidebar. */
          })
      }
    })
    .catch((cause: unknown) => {
      if (disposed) return
      slot.error = cause instanceof Error ? cause : new Error(String(cause))
      onError(slot.error)
    })
  return () => {
    if (disposed) return
    disposed = true
    stopCheck?.()
    stopCheck = undefined
    const handle = slot.handle
    slot.handle = null
    slot.project = null
    slot.error = null
    if (handle !== null) {
      retire(handle.pool)
      handle.dispose()
    }
    queueMicrotask(() => notify(slot))
  }
}

/** The real sidebar's data hook.
 * null is the initial import/loading state. A rebuild wakes existing readers. */
export function useWorklistPool(): MobxPool | null {
  const runtime = useStoreHandle()
  const slot = slotFor(runtime)
  return useSyncExternalStore(
    (listener) => {
      slot.listeners.add(listener)
      return () => slot.listeners.delete(listener)
    },
    () => {
      if (slot.error !== null) throw slot.error
      return slot.handle?.pool ?? null
    },
  )
}

/** Layout-only pool subscription for companions that remain on their current
 * component tree. The MobX implementation arrives with the startup attachment. */
export function useWorklistPoolProjection<T>(read: (pool: MobxPool) => T, empty: T): T {
  const runtime = useStoreHandle()
  const pool = useWorklistPool()
  const project = slotFor(runtime).project
  const view = useMemo(() => (pool && project ? project(pool, read) : null), [pool, project, read])
  return useSyncExternalStore(
    view?.subscribe ?? (() => () => {}),
    view?.getSnapshot ?? (() => empty),
  )
}
