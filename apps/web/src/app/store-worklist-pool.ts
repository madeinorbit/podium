import { initializeSettingsDataLayer, settingsDataLayer, settingsCheckRequested } from '@/features/settings/data-layer'
import { initializePreferencesDataLayer, preferencesDataLayer, preferencesCheckRequested } from '@/lib/preferences-data-layer'
import { headerDataLayer, headerCheckRequested, initializeHeaderDataLayer } from '@/lib/header-data-layer'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { chipCheckFor, chipPerf, recordChipWork, reportSidebarPool } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { MobxPool, WorklistPoolHandle } from '@podium/client-graph'
import type { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import {
  initializeSidebarDataLayer,
  sidebarCheckRequested,
  sidebarDataLayer,
} from '@/lib/sidebar-data-layer'
import { chipsCheckRequested, chipsDataLayer, chipsPerfRequested, initializeChipsDataLayer } from '@/lib/chips-data-layer'

interface PoolSlot {
  handle: WorklistPoolHandle | null
  error: Error | null
  listeners: Set<() => void>
  project: typeof createPoolProjection | null
}

// Each screen freezes its choice at startup. Later migrations add one entry
// here; all enabled screens still share the provider's existing single pool.
const poolBackedScreens: readonly {
  initialize(ui: ClientRuntime['ui']): void
  enabled(): boolean
}[] = [
  { initialize: initializeSettingsDataLayer, enabled: () => settingsDataLayer() === 'pool' },
  { initialize: initializePreferencesDataLayer, enabled: () => preferencesDataLayer() === 'pool' },
  { initialize: initializeSidebarDataLayer, enabled: () => sidebarDataLayer() === 'pool' },
  { initialize: initializeHeaderDataLayer, enabled: () => headerDataLayer() === 'pool' },
  { initialize: initializeChipsDataLayer, enabled: () => chipsDataLayer() === 'pool' },
]

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
  reportSidebarPool(runtime, null, false)
  const slot = slotFor(runtime)
  slot.error = null
  let disposed = false
  let stopCheck: (() => void) | undefined
  let stopHeaderCheck: (() => void) | undefined
  let stopSettingsCheck: (() => void) | undefined
  let stopPreferenceCheck: (() => void) | undefined
  let stopChipCheck: (() => void) | undefined
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    Object.assign(window, { __sidebarPool: { survivors: worklistPoolSurvivors } })
  }
  void import('@podium/client-graph/runtime-pool')
    .then(({ createRuntimeWorklistPool, createPoolProjection }) => {
      if (disposed) return
      const settings = settingsDataLayer() === 'pool'
      const preferences = preferencesDataLayer() === 'pool'
      const chips = chipsDataLayer() === 'pool'
      const header = headerDataLayer() === 'pool'
      slot.handle = preferences || settings || chips || header
        ? createRuntimeWorklistPool(runtime, { ...(settings ? { settings: true } : {}), ...(preferences ? { preferences: true } : {}), ...(header ? { header: true } : {}), ...(chips ? {
          resolveReferences: async (refs) => {
            recordChipWork(runtime, 'resolveBatches')
            recordChipWork(runtime, 'resolveRefs', refs.length)
            return await runtime.getSnapshot().trpc.issues.resolveRefs.query({ refs: [...refs] })
          },
        } : {}) })
        : createRuntimeWorklistPool(runtime)
      // Build the resident identity index once on attachment, before a
      // conversation opens. No reference reader exists for other screens.
      const references = chips ? slot.handle.pool.references : null
      slot.project = createPoolProjection
      notify(slot)
      if (settingsCheckRequested()) {
        void import('@podium/client-graph/diagnostics/settings-check').then(({ installSettingsCheck }) => {
          if (disposed || !slot.handle) return
          stopSettingsCheck = installSettingsCheck(slot.handle.pool, runtime)
        }).catch(() => {})
      }
      if (preferencesCheckRequested()) {
        void import('@podium/client-graph/diagnostics/preference-check').then(({ installPreferenceCheck }) => {
          if (disposed || !slot.handle) return
          stopPreferenceCheck = installPreferenceCheck(slot.handle.pool, runtime.ui)
        }).catch(() => {})
      }
      if (chipsCheckRequested() && references) {
        void import('@podium/client-graph/diagnostics/chip-check').then(({ startChipCheck }) => {
          if (disposed) return
          stopChipCheck = startChipCheck(runtime, references, () => [...document.querySelectorAll('a.ref-link--issue[data-ref], [data-issue-reference]')]
            .map(node => node.getAttribute('data-ref') ?? node.getAttribute('data-issue-reference')!))
        }).catch(() => {})
      }
      if (headerCheckRequested()) {
        void import('@podium/client-graph/diagnostics/header-runtime-check').then(({ startHeaderCheck }) => {
          if (disposed || !slot.handle) return
          stopHeaderCheck = startHeaderCheck(runtime, slot.handle.pool, (report) => {
            if (typeof window !== 'undefined') Object.assign(window, { __headerCheck: report })
          })
        }).catch(() => {})
      }
      if (sidebarDataLayer() === 'pool') {
        const pool = slot.handle.pool
        void import('@podium/client-graph/diagnostics/runtime-check')
          .then(({ startSidebarCheck }) => {
            if (disposed) return
            stopCheck = startSidebarCheck(runtime, pool, {
              startup: sidebarCheckRequested(),
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
    stopCensus()
    stopSettingsCheck?.()
    stopSettingsCheck = undefined
    stopPreferenceCheck?.()
    stopPreferenceCheck = undefined
    stopChipCheck?.()
    stopChipCheck = undefined
    stopHeaderCheck?.()
    stopHeaderCheck = undefined
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
