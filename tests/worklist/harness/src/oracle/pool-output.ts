import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

const frozenFiles = new Map<string, ReadonlyMap<string, { sha256: string; bytes: number }>>()

/** The fingerprints a test file froze, by snapshot key, read from its `.snap`. */
function frozenOf(testPath: string): ReadonlyMap<string, { sha256: string; bytes: number }> {
  let frozen = frozenFiles.get(testPath)
  if (frozen === undefined) {
    const file = join(dirname(testPath), '__snapshots__', `${basename(testPath)}.snap`)
    const text = readFileSync(file, 'utf8')
    const entries = new Map<string, { sha256: string; bytes: number }>()
    for (const match of text.matchAll(
      /exports\[`([^`]*)`\] = `\n\{\n {2}"bytes": (\d+),\n {2}"sha256": "([0-9a-f]+)",\n\}\n`;/g,
    )) {
      const [, key, bytes, sha256] = match
      if (key !== undefined && sha256 !== undefined)
        entries.set(key, { bytes: Number(bytes), sha256 })
    }
    frozen = entries
    frozenFiles.set(testPath, frozen)
  }
  return frozen
}

/**
 * POD-5432: hold a VARIANT of a frozen run to that run's own snapshot, never
 * writing a second copy: the entry the same file froze for `label` in the test
 * named as the current one minus `variant` (` (pool owns optimism)`). A missing
 * entry fails; this never records one.
 */
export function expectFrozenPoolOutput(value: unknown, label: string, variant: string): void {
  const { currentTestName, testPath } = expect.getState()
  if (currentTestName === undefined || testPath === undefined)
    throw new Error('expectFrozenPoolOutput runs inside a test')
  const frozenTest = currentTestName.replace(variant, '')
  if (frozenTest === currentTestName)
    throw new Error(`test name ${currentTestName} does not carry the variant ${variant}`)
  const key = `${frozenTest} > ${label} 1`
  const frozen = frozenOf(testPath).get(key)
  if (frozen === undefined) throw new Error(`no frozen pool output for ${key}`)
  expect(poolOutputFingerprint(value), label).toEqual(frozen)
}
