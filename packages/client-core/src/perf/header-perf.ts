import { recordSliceDerivation } from './store-stats'

/** Bounded, opt-in counters. They retain names and counts, never payloads. */
let enabled = false
let counts: Record<string, { calls: number; ms: number }> = {}
export const headerStats = {
  enable() { enabled = true },
  disable() { enabled = false },
  reset() { counts = {} },
  read() { return structuredClone(counts) },
}
export function measureHeader<T>(name: string, read: () => T): T {
  if (!enabled) return read()
  const start = performance.now()
  try { return read() }
  finally {
    const key = name.slice(0, 80)
    const entry = counts[key] ?? (Object.keys(counts).length < 64 ? counts[key] = { calls: 0, ms: 0 } : undefined)
    if (entry) { entry.calls++; entry.ms += performance.now() - start }
  }
}
/** Count the real legacy derivation before it runs, as POD-4957 does. */
export function measureLegacyHeader<T>(owner: object, name: string, read: () => T): T {
  recordSliceDerivation(owner, `header.${name}`)
  return measureHeader(`legacy.${name}`, read)
}
