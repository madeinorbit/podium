/** Shallow equality over own enumerable keys (Object.is per value). */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (
      !Object.hasOwn(b, k) ||
      !Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
      return false
  }
  return true
}

