/**
 * [spec:SP-d562]
 * A deliberately small progressive boundary for production-sized task groups.
 * The complete issue order remains outside this module and continues to drive
 * keyboard navigation; this only decides how much of that order is mounted.
 */
export const ISSUE_RENDER_CHUNK = 40

/**
 * Keep the ordinary mounted prefix bounded, but never hide focused/selected
 * issues. Including the prefix through a required issue preserves visual order
 * and gives scrollIntoView a real target after keyboard movement.
 */
export function progressiveRenderLimit(
  ids: readonly string[],
  revealed: number,
  requiredIds: ReadonlySet<string>,
): number {
  let required = 0
  for (let i = 0; i < ids.length; i++) {
    if (requiredIds.has(ids[i] as string)) required = i + 1
  }
  return Math.min(ids.length, Math.max(revealed, required))
}

/** Advance one deterministic chunk without overshooting the current group. */
export function nextProgressiveRenderLimit(current: number, total: number): number {
  return Math.min(total, current + ISSUE_RENDER_CHUNK)
}
