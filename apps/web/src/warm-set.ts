/**
 * Recency-ordered tab ids (most-recent first). The currently-active ids are
 * promoted to the front (in the given order); the remaining previous entries
 * keep their relative order; ids that no longer exist are dropped.
 */
export function updateRecency(
  prev: string[],
  activeIds: string[],
  existingIds: string[],
): string[] {
  const exists = new Set(existingIds)
  const active = activeIds.filter((id) => exists.has(id))
  const rest = prev.filter((id) => exists.has(id) && !active.includes(id))
  return [...active, ...rest]
}

/**
 * The set of tab ids to keep mounted: every active id, plus the most-recent
 * others until the set reaches `max(capacity, activeIds.length)`.
 */
export function computeWarmSet(
  recency: string[],
  activeIds: string[],
  capacity: number,
): Set<string> {
  const warm = new Set(activeIds)
  const target = Math.max(capacity, warm.size)
  for (const id of recency) {
    if (warm.size >= target) break
    warm.add(id)
  }
  return warm
}
