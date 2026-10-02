import { useStoreHandle } from '@podium/client-core/react'
import { missionIndexStats, sessionOwnershipStats } from '@podium/client-core/viewmodels'
import { useEffect } from 'react'

/** Counts belong to the existing store owner, never to a second runtime. */
const counts = new WeakMap<object, Record<string, number>>()
const work = new WeakMap<object, { legacyMs: number; poolMs: number }>()
export function missionLegacyCountsFor(owner: object): Readonly<Record<string, number>> {
  return { ...counts.get(owner) }
}
export function resetMissionLegacyCounts(owner: object): void { counts.delete(owner); work.delete(owner) }
function measureWork<T>(owner: object, layer: 'legacyMs' | 'poolMs', read: () => T): T {
  const current = work.get(owner) ?? { legacyMs: 0, poolMs: 0 }
  work.set(owner, current)
  const start = performance.now()
  try { return read() } finally { current[layer] += performance.now() - start }
}
function recordLegacy(owner: object, operation: string, amount: number): void {
  let current = counts.get(owner)
  if (!current) { current = {}; counts.set(owner, current) }
  current[operation] = (current[operation] ?? 0) + amount
}
export function measurePoolMission<T>(owner: object, read: () => T): T {
  return measureWork(owner, 'poolMs', () => {
    const before = missionIndexStats(), ownership = sessionOwnershipStats().lookups
    try { return read() } finally {
      for (const [key, value] of Object.entries(missionIndexStats())) {
        const delta = value - before[key as keyof typeof before]
        if (delta > 0 && false) recordLegacy(owner, `pool.mission.${key}`, delta)
      }
      const delta = sessionOwnershipStats().lookups - ownership
      if (delta > 0) recordLegacy(owner, 'pool.sessionOwnership', delta)
    }
  })
}
export function measureLegacyMission<T>(owner: object, operation: string, read: () => T): T {
  recordLegacy(owner, operation, 1)
  return measureWork(owner, 'legacyMs', read)
}
export function useMissionPaneCensus(): void {
  const owner = useStoreHandle()
  useEffect(() => {
    const api = { read: () => missionLegacyCountsFor(owner), reset: () => resetMissionLegacyCounts(owner) }
    const timing = { read: () => ({ ...work.get(owner) }), reset: api.reset }
    Object.assign(window, { __missionPaneLegacy: api, __missionPaneWork: timing })
    return () => {
      if (Reflect.get(window, '__missionPaneLegacy') === api) Reflect.deleteProperty(window, '__missionPaneLegacy')
      if (Reflect.get(window, '__missionPaneWork') === timing) Reflect.deleteProperty(window, '__missionPaneWork')
    }
  }, [owner])
}
