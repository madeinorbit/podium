/** Counts belong to the existing store owner, never to a second runtime. */
const counts = new WeakMap<object, Record<string, number>>()
export function missionLegacyCountsFor(owner: object): Readonly<Record<string, number>> {
  return { ...counts.get(owner) }
}
export function resetMissionLegacyCounts(owner: object): void { counts.delete(owner) }
export function measureLegacyMission<T>(owner: object, operation: string, read: () => T): T {
  let current = counts.get(owner)
  if (!current) { current = {}; counts.set(owner, current) }
  current[operation] = (current[operation] ?? 0) + 1
  return read()
}
