import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { chipCheckFor, chipPerf, reportSidebarPool } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { MobxPool, WorklistPoolHandle } from '@podium/client-graph'
import type { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import { sidebarDataLayer } from '@/lib/sidebar-data-layer'
import { chipsPerfRequested } from '@/lib/chips-data-layer'
import { attachPoolScreens, preparePoolScreens, screenOptions } from './pool-screen-registry'
import { poolBackedScreens } from './pool-screens'

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
  // Structural legacy/test runtimes without UI state request no pool screen.
  if (!runtime.ui) return () => {}
  for (const screen of poolBackedScreens) screen.initialize(runtime.ui)
  if (sidebarDataLayer() === 'pool') runtime.enablePoolRuntimeWork?.()
  let stopCensus = (): void => {}
  if (chipsPerfRequested() && typeof window !== 'undefined') {
    chipPerf.enable()
    const owner = new WeakRef(runtime)
    const census = { reset: chipPerf.reset,
      read: () => { const current = owner.deref(); return current ? chipPerf.read(current) : null },
      check: () => { const current = owner.deref(); return current ? chipCheckFor(current) : null },
    }
    Object.assign(window, { __chipPerf: census })
    stopCensus = () => { if (Reflect.get(window, '__chipPerf') === census) Reflect.deleteProperty(window, '__chipPerf') }
  }
  if (!poolBackedScreens.some((screen) => screen.enabled())) return stopCensus
  const stopPrepared = preparePoolScreens(poolBackedScreens, runtime)
  reportSidebarPool(runtime, null, false)
  const slot = slotFor(runtime)
  slot.error = null
  let disposed = false
  let stopScreens: (() => void) | undefined
  const fail = (cause: unknown): void => {
    if (disposed) return
    slot.error = cause instanceof Error ? cause : new Error(String(cause))
    onError(slot.error)
    notify(slot)
  }
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    Object.assign(window, { __sidebarPool: { survivors: worklistPoolSurvivors } })
  }
  void import('@podium/client-graph/runtime-pool')
    .then(({ createRuntimeWorklistPool, createPoolProjection }) => {
      if (disposed) return
      const options = screenOptions(poolBackedScreens, runtime)
      slot.handle = Object.keys(options).length
        ? createRuntimeWorklistPool(runtime, options)
        : createRuntimeWorklistPool(runtime)
      stopScreens = attachPoolScreens(poolBackedScreens, runtime, slot.handle.pool, fail)
      slot.project = createPoolProjection
      notify(slot)
    })
    .catch(fail)
  return () => {
    if (disposed) return
    disposed = true
    stopCensus()
    stopScreens?.()
    stopPrepared()
    stopScreens = undefined
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
