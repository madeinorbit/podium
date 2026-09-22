import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ARMED GUARD (this issue): nothing inside `adapters/` imports a mechanism.
 *
 * Spec §5: the transcript section is data plus pure functions; the dependency
 * points one way, Store → grammar. An adapter that imports the Store (cursor
 * codec, runtime types, slice contract), the inventory, or the driver flips
 * that arrow — the grammar takes the Store instead of the Store taking the
 * grammar. This test makes that shape fail rather than merely absent: any
 * `adapters/**` product file reaching into `store/`, `inventory/` or
 * `driver/` is a violation, as is `manifest.ts` (the grammar's home)
 * importing the Store it must stay free of.
 *
 * Test files are exempt: they assert cursors and route sources through the
 * Store on purpose. Fixtures are exempt: they are test data, not grammar.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..')
const ADAPTERS = resolve(SRC, 'adapters')
const MANIFEST = resolve(SRC, 'manifest.ts')
const SQLITE_TRANSCRIPT = resolve(ADAPTERS, 'opencode', 'transcript.ts')

/** Mechanism homes no adapter may reach, relative to `packages/harness/src/`. */
const MECHANISM_DIRS = ['store', 'inventory', 'driver'] as const

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__fixtures__' || entry.name === 'fixtures') continue
      out.push(...walk(full))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    out.push(full)
  }
  return out
}

/** Every static + dynamic import specifier in one source file. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = []
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')
  for (const m of stripped.matchAll(
    /(?:import|export)\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/g,
  )) {
    if (m[1]) specs.push(m[1])
  }
  for (const m of stripped.matchAll(/(?<![\w$])import\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) specs.push(m[1])
  }
  return specs
}

function mechanismReach(file: string, source: string): string[] {
  const hits: string[] = []
  for (const spec of importSpecifiers(source)) {
    if (!spec.startsWith('.')) continue
    const abs = resolve(dirname(file), spec)
    const rel = abs.startsWith(SRC) ? abs.slice(SRC.length + 1).split(sep).join('/') : null
    if (!rel) continue
    const top = rel.split('/')[0]
    if ((MECHANISM_DIRS as readonly string[]).includes(top ?? '')) {
      hits.push(`${relOf(file)} imports '${spec}' (→ ${rel})`)
    }
  }
  return hits
}

function relOf(abs: string): string {
  return abs.split(sep).join('/').split('/packages/harness/src/').at(-1) ?? abs
}

describe('adapters import no mechanism (spec §5)', () => {
  it('no adapters/** product file reaches store/, inventory/ or driver/', () => {
    const violations: string[] = []
    for (const file of walk(ADAPTERS)) violations.push(...mechanismReach(file, readFileSync(file, 'utf8')))
    expect(violations).toEqual([])
  })

  it('manifest.ts (the grammar home) imports nothing from store/', () => {
    const source = readFileSync(MANIFEST, 'utf8')
    const hits = importSpecifiers(source).filter((spec) => {
      if (!spec.startsWith('.')) return false
      const abs = resolve(dirname(MANIFEST), spec)
      const rel = abs.startsWith(SRC) ? abs.slice(SRC.length + 1).split(sep).join('/') : null
      return rel?.split('/')[0] === 'store'
    })
    expect(hits).toEqual([])
  })

  it('the opencode adapter holds no source implementation (no readSlice)', () => {
    const source = readFileSync(SQLITE_TRANSCRIPT, 'utf8')
    expect(source).not.toContain('readSlice')
  })
})
