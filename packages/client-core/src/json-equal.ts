/**
 * Equality for protocol rows, which are JSON values. Unlike stringify, this
 * avoids allocating two complete strings per existing row and stops as soon as
 * a changed field is found. Undefined object fields are ignored to preserve
 * JSON serialization semantics used by persistence.
 */
export function jsonRowsEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  const leftArray = Array.isArray(left)
  if (leftArray !== Array.isArray(right)) return false
  if (leftArray) {
    const a = left as unknown[]
    const b = right as unknown[]
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!jsonRowsEqual(a[i], b[i])) return false
    }
    return true
  }
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const aKeys = Object.keys(a).filter((key) => a[key] !== undefined)
  const bKeys = Object.keys(b).filter((key) => b[key] !== undefined)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key) || !jsonRowsEqual(a[key], b[key])) return false
  }
  return true
}
