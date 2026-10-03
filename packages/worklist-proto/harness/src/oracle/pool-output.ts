import { createHash } from 'node:crypto'
import { expect } from 'vitest'

/** Frozen from the last green pilot-ON parity run. Hash every field and array
 * position so large synthetic corpora stay reviewable without a second reader.
 * Object key order is immaterial; Map/Set contents and undefined stay explicit. */
export function poolOutputFingerprint(value: unknown): { sha256: string; bytes: number } {
  const normalize = (entry: unknown): unknown => {
    if (entry === undefined) return { $undefined: true }
    if (entry instanceof Map)
      return { $map: [...entry].map(([key, item]) => [normalize(key), normalize(item)]) }
    if (entry instanceof Set) return { $set: [...entry].map(normalize) }
    if (Array.isArray(entry)) return entry.map(normalize)
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      )
    if (typeof entry === 'symbol') return { $symbol: String(entry) }
    return entry
  }
  const serialized = JSON.stringify(normalize(value))
  return {
    sha256: createHash('sha256').update(serialized).digest('hex'),
    bytes: Buffer.byteLength(serialized),
  }
}

export function expectPoolOutput(value: unknown, label: string): void {
  expect(poolOutputFingerprint(value)).toMatchSnapshot(label)
}
