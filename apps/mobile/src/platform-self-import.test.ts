/**
 * A platform file must not VALUE-import its own base name (POD-2382).
 *
 * Metro resolves `./TaskFiltersSheet` from `TaskFiltersSheet.ios.tsx` to the
 * .ios file itself on iOS, so a value import of the "base" module reads
 * undefined there and crashes at first use, while vitest (which resolves the
 * base file) stays green. Type-only imports and re-exports are erased and safe;
 * shared values belong in a module with its own base name.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const PLATFORM = /\.(ios|android|native|web)\.(tsx?|jsx?)$/
const STATEMENT = /\b(import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/g

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (PLATFORM.test(entry.name)) yield path
  }
}

/** Value imports in `source` that resolve to `base` (the file minus platform and extension). */
function selfValueImports(file: string, source: string): string[] {
  const base = file.replace(PLATFORM, '')
  const found: string[] = []
  for (const match of source.matchAll(STATEMENT)) {
    const [, , typeOnly, clause = '', specifier = ''] = match
    if (typeOnly || !specifier.startsWith('.')) continue
    if (resolve(dirname(file), specifier) !== base) continue
    // `import { type A, type B } from` is erased as well.
    const names = clause
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((name) => name.trim())
    if (clause.startsWith('{') && names.filter(Boolean).every((name) => name.startsWith('type ')))
      continue
    found.push(match[0].replace(/\s+/g, ' '))
  }
  return found
}

it('finds no platform file value-importing its own base module', () => {
  const offenders = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'app'))].flatMap((file) =>
    selfValueImports(file, readFileSync(file, 'utf8')).map(
      (statement) => `${relative(ROOT, file)}: ${statement}`,
    ),
  )
  expect(offenders).toEqual([])
})

it('catches the POD-2382 shape and lets type-only imports through', () => {
  const file = join(ROOT, 'src/components/TaskFiltersSheet.ios.tsx')
  expect(
    selfValueImports(file, "import { FILTER_FACETS, type Facet } from './TaskFiltersSheet'"),
  ).toHaveLength(1)
  expect(selfValueImports(file, "import type { Facet } from './TaskFiltersSheet'")).toEqual([])
  expect(selfValueImports(file, "export type { Facet } from './TaskFiltersSheet'")).toEqual([])
  expect(selfValueImports(file, "import { type Facet } from './TaskFiltersSheet'")).toEqual([])
  expect(selfValueImports(file, "import { FILTER_FACETS } from './task-filter-facets'")).toEqual([])
})
