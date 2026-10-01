/** Passive, outside instrumentation for the app-owned pool. This module never
 * reads a row, a model, a layout or a snapshot. MobX bodies are measured at
 * the same boundary as the harness work meter, including unchanged answers;
 * an empty deadline-clock tick is not a derivation. */
import {
  observeSidebarPerfBinding,
  reportSidebarPool,
  sidebarPerfFor,
  type SidebarPerf,
} from '@podium/client-core/perf'
import { computed, observe, Reaction } from 'mobx'
import type { MobxPool } from './pool'

type Body = (this: object, ...args: unknown[]) => unknown

/** MobX is used only by the opted-in sidebar in the app. There is one open
 * panel bound to one StoreProvider; replacing that binding stops this meter
 * before another can start. No patches or clock reads survive panel close.
 * MobX is pinned; fail loudly if its measured boundary ever changes. */
function measureDerivations(perf: SidebarPerf): () => void {
  const computedProto = Object.getPrototypeOf(computed(() => 0)) as Record<string, Body>
  const reactionProto = Reaction.prototype as unknown as Record<string, Body>
  const restores: Array<() => void> = []
  const boundaries = [
    [computedProto, 'computeValue_'],
    [reactionProto, 'track'],
  ] as const
  for (const [proto, key] of boundaries) {
    if (typeof proto[key] !== 'function') throw new Error(`Sidebar work meter: missing MobX ${key}`)
  }
  for (const [proto, key] of boundaries) {
    const original = proto[key]
    const measured: Body = function (...args) {
      const start = performance.now()
      try {
        return original.apply(this, args)
      } finally {
        perf.record({ derivations: 1, start, end: performance.now() })
      }
    }
    proto[key] = measured
    restores.push(() => {
      if (proto[key] === measured) proto[key] = original
    })
  }
  return () => restores.reverse().forEach((restore) => restore())
}

/** Count residency once from map sizes, then maintain a scalar from slot
 * additions/removals, including hydration and eviction. Observers never
 * dereference the old/new row values supplied by MobX. */
export function observeWorklistPoolPerf(owner: object, pool: MobxPool): () => void {
  const tables = Object.values(pool.tables)
  let rows = tables.reduce((total, table) => total + table.size, 0)
  reportSidebarPool(owner, rows)
  const stops = tables.map((table) =>
    observe(table, (change) => {
      if (change.type === 'update') return
      rows += change.type === 'add' ? 1 : -1
      reportSidebarPool(owner, rows)
    }),
  )
  let stopMeter: (() => void) | undefined
  const stopBinding = observeSidebarPerfBinding(owner, (perf) => {
    stopMeter?.()
    stopMeter = perf ? measureDerivations(perf) : undefined
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    stopBinding()
    for (const stop of stops) stop()
    reportSidebarPool(owner, null, false)
  }
}

/** The existing feed subscription delivers once; time its actual ingest and
 * reaction work without creating another subscription or update window.
 * The runtime's beginSidebarUpdate already spans delivery through paint. */
export function measureWorklistPoolDelivery(owner: object, deliver: () => void): void {
  const perf = sidebarPerfFor(owner)
  if (!perf) {
    deliver()
    return
  }
  const start = performance.now()
  try {
    deliver()
  } finally {
    perf.record({ start, end: performance.now() })
  }
}
