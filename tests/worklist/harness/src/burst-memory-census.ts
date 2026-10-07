/** Temporary, opt-in attribution for POD-5779; never an app import. */
import { createRequire } from 'node:module'
import { lazyKeptCount } from '@podium/mobx-helpers'
import type { MobxPool } from '@podium/client-graph/pool'

let label = ''
export function burstMemoryLabel(value: string): void { label = value }

export function burstMemoryCensus(phase: string, pool?: MobxPool): void {
  if (process.env.PODIUM_BURST_MEMORY_CENSUS !== '1') return
  const { heapStats, fullGC } = createRequire(import.meta.url)('bun:jsc') as {
    heapStats(): { heapSize: number; heapCapacity: number; extraMemorySize: number; objectCount: number; objectTypeCounts: Record<string, number> }
    fullGC(): void
  }
  // Diagnostic reflection over the pool's existing models: create no model and
  // read no model field. Slot names come from our own lazy diagnostic symbol.
  const models = (pool === undefined ? {} : Object.getOwnPropertyDescriptor(pool, 'models')?.value) as Record<string, Map<string, object>>
  const objects: Record<string, number> = {}
  const fields: Record<string, number> = {}
  let watched = 0, held = 0
  for (const [entity, rows] of Object.entries(models)) {
    objects[entity] = rows.size
    for (const model of rows.values()) {
      const key = Object.getOwnPropertySymbols(model).find(symbol => symbol.description === 'lazy slots')
      const slots = key === undefined ? undefined : (model as Record<symbol, Map<symbol, unknown>>)[key]
      watched += slots?.size ?? 0
      held += lazyKeptCount(model) - (slots?.size ?? 0)
      if (slots) for (const field of slots.keys()) {
        const name = `${model.constructor.name}.${field.description}`
        fields[name] = (fields[name] ?? 0) + 1
      }
    }
  }
  const readHeap = () => {
    const { heapSize, heapCapacity, extraMemorySize, objectCount, objectTypeCounts } = heapStats()
    return { heapSize, heapCapacity, extraMemorySize, objectCount, objectTypeCounts }
  }
  const allocated = readHeap()
  fullGC()
  const retained = readHeap()
  console.error('BURST_MEMORY ' + JSON.stringify({ label, phase, objects, watched, held, allocated, retained, fields }))
}
