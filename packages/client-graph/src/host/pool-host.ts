import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { reportSidebarPool } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import { useMemo, useRef, useSyncExternalStore } from 'react'
import type { WorklistPoolHandle } from '../create'
import type { MobxPool } from '../pool'
import type { createPoolProjection } from '../runtime-pool'
import {
  attachPoolScreens,
  type PoolScreen,
  type PoolScreenOptions,
  preparePoolScreens,
  screenOptions,
} from './screens'

export interface PoolHostOptions {
  /** The app's screen list. Each entry latches its own switch at attachment. */
  readonly screens: readonly PoolScreen[]
  /** Development builds keep weak references to retired pools for leak checks. */
  readonly dev: boolean
  /** App startup work after the switches latch, with or without an enabled
   * screen. Its stop runs first at teardown. */
  start?(runtime: ClientRuntime): (() => void) | void
  /** Pool-wide options that belong to no screen (POD-5431: the transaction
   * log). Read when a pool is built; never builds one by itself. */
  options?(runtime: ClientRuntime): PoolScreenOptions
}

export interface PoolHost {
  /** The store provider's attachRuntime: it owns this teardown, including
   * while the graph import is in flight. */
  attach<TApi extends PodiumClientApi>(
    runtime: ClientRuntime<TApi>,
    onError: (error: Error) => void,
  ): () => void
  /** null while the graph loads; a rebuild wakes existing readers. */
  usePool(): MobxPool | null
  /** A scalar reader over the pool for components outside observer trees. */
  usePoolProjection<T>(read: (pool: MobxPool) => T, empty: T): T
  /** Force GC between turns first; names retired pool parts still reachable. */
  survivors(): string[]
}

interface PoolSlot {
  handle: WorklistPoolHandle | null
  error: Error | null
  listeners: Set<() => void>
  project: typeof createPoolProjection | null
}

/** One pool per signed-in runtime for an app. No graph code, row feed, locals
 * subscription or pool is built while every screen is switched off. */
export function createPoolHost({
  screens,
  dev,
  start,
  options: hostOptions,
}: PoolHostOptions): PoolHost {
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

  // This helper holds only weak references; survivors() keeps its answers
  // alive for the current job.
  function survivors(): string[] {
    return retired.filter(({ ref }) => ref.deref() !== undefined).map(({ name }) => name)
  }

  function retire(pool: MobxPool): void {
    if (!dev) return
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

  function attach<TApi extends PodiumClientApi>(
    runtime: ClientRuntime<TApi>,
    onError: (error: Error) => void,
  ): () => void {
    // Structural legacy/test runtimes without UI state request no pool screen.
    if (!runtime.ui) return () => {}
    for (const screen of screens) screen.initialize(runtime.ui)
    const stopStart = start?.(runtime) ?? (() => {})
    if (!screens.some((screen) => screen.enabled())) return stopStart
    const stopPrepared = preparePoolScreens(screens, runtime)
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
    if (dev && typeof window !== 'undefined') {
      Object.assign(window, { __sidebarPool: { survivors } })
    }
    void import('../runtime-pool')
      .then(({ createRuntimeWorklistPool, createPoolProjection }) => {
        if (disposed) return
        const options = { ...screenOptions(screens, runtime), ...hostOptions?.(runtime) }
        slot.handle = Object.keys(options).length
          ? createRuntimeWorklistPool(runtime, options)
          : createRuntimeWorklistPool(runtime)
        stopScreens = attachPoolScreens(screens, runtime, slot.handle.pool, fail)
        slot.project = createPoolProjection
        notify(slot)
      })
      .catch(fail)
    return () => {
      if (disposed) return
      disposed = true
      stopStart()
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

  function usePool(): MobxPool | null {
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

  /** Layout-only subscription that keeps one projection and subscription per hook.
   * Mount and each observed change read once; structurally equal values keep their
   * identity and do not wake React. A new reader closure is evaluated once in render
   * to adopt changed captures. Large screens should pass a memoized reader.
   * The MobX implementation arrives with the startup attachment. */
  function usePoolProjection<T>(read: (pool: MobxPool) => T, empty: T): T {
    const runtime = useStoreHandle()
    const pool = usePool()
    const project = slotFor(runtime).project
    const reader = useRef(read)
    reader.current = read
    const view = useMemo(
      () => (pool && project ? project(pool, reader.current) : null),
      // Reader closures change with props. The view adopts the latest reader
      // below without replacing its observer or React subscription.
      [pool, project],
    )
    view?.getSnapshot(reader.current)
    return useSyncExternalStore(
      view?.subscribe ?? (() => () => {}),
      view?.getSnapshot ?? (() => empty),
    )
  }

  return { attach, usePool, usePoolProjection, survivors }
}
