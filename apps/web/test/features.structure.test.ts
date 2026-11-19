// @vitest-environment node
/**
 * Shared layers stay below composed feature screens: production modules in
 * lib/ and components/ui/ may not import features/. Colocated tests may use
 * a feature's pure helpers as fixtures. Feature screens may compose one
 * another; there is no blanket feature-to-feature import rule.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })

/** Layer of a src-relative path: 'feature:<name>' | 'lib' | 'ui' | 'app' | 'root'. */
const layerOf = (rel: string): string => {
  if (rel.startsWith('features/')) return `feature:${rel.split('/')[1]}`
  if (rel.startsWith('lib/')) return 'lib'
  if (rel.startsWith('components/ui/')) return 'ui'
  if (rel.startsWith('app/')) return 'app'
  return 'root'
}

// import/export-from/dynamic-import/vi.mock specifiers (#264 round 2). Module
// source strings can't contain newlines, so matching the from-clause / call
// argument ALONE is multiline-safe — the old variant anchored on the `import`
// keyword with a no-newline gap and silently skipped multiline imports
// (`import {\n X\n} from '@/features/...'`), i.e. exactly the ones a formatter
// produces once a specifier list grows. The lookbehind keeps `from` inside
// hyphenated string content ('discovered-from') from reading as a from-clause.
const SPEC_RE =
  /(?<![-'"])\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]|\bimport\s+['"]([^'"\n]+)['"]|vi\.(?:mock|doMock|unmock)\(\s*['"]([^'"\n]+)['"]/g

type Edge = { file: string; spec: string; from: string; to: string }

const edgesFrom = (file: string, text: string): Edge[] => {
  const from = layerOf(file)
  const abs = join(SRC, file)
  const edges: Edge[] = []
  for (const m of text.matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
    if (!spec) continue
    let target: string
    if (spec.startsWith('@/')) target = spec.slice(2)
    else if (spec.startsWith('.'))
      target = relative(SRC, normalize(join(dirname(abs), spec))).replaceAll('\\', '/')
    else continue
    if (!target.startsWith('..')) edges.push({ file, spec, from, to: layerOf(target) })
  }
  return edges
}

const collectEdges = (): Edge[] =>
  walk(SRC).flatMap((abs) =>
    edgesFrom(relative(SRC, abs).replaceAll('\\', '/'), readFileSync(abs, 'utf8')),
  )

const lowerLayerViolations = (edges: Edge[]): Edge[] =>
  edges.filter(
    (edge) =>
      (edge.from === 'lib' || edge.from === 'ui') &&
      edge.to.startsWith('feature:') &&
      !/\.(?:test|spec)\.tsx?$/.test(edge.file),
  )

describe('feature folder boundaries', () => {
  const edges = collectEdges()

  it('the specifier matcher sees multiline imports (#264 round 2 regression guard)', () => {
    const text = [
      'import {',
      '  A,',
      '  B,',
      "} from '@/features/chat/x'",
      'export {',
      '  C,',
      "} from './re-export'",
      'const lazy = import(',
      "  './lazy'",
      ')',
      "import './side-effect'",
      "if (kind === 'discovered-from') return 'Discovered from' // not an import",
    ].join('\n')
    const specs = [...text.matchAll(SPEC_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4])
    expect(specs).toEqual(['@/features/chat/x', './re-export', './lazy', './side-effect'])
  })

  it('lib/ and components/ui/ do not import features', () => {
    const violations = lowerLayerViolations(edges).map(
      (edge) => `${edge.file} imports '${edge.spec}'`,
    )
    expect(violations, violations.join('\n')).toEqual([])
  })

  it.each([
    ['lib/reader.ts', "import { X } from '@/features/issues/X'"],
    ['lib/reader.ts', "export { X } from '../features/issues/X'"],
    ['components/ui/menu.tsx', "const panel = import('../../features/issues/X')"],
    ['components/ui/menu.tsx', "import '@/features/chat/X'"],
    ['lib/reader.ts', "import {\n X,\n} from '@/features/issues/X'"],
  ])('rejects a planted lower-layer feature import in %s: %s', (file, text) => {
    expect(lowerLayerViolations(edgesFrom(file, text))).toHaveLength(1)
  })

  it.each([
    ['lib/reader.test.ts', "import { X } from '@/features/issues/X'"],
    ['components/ui/menu.spec.tsx', "import { X } from '@/features/chat/X'"],
    ['features/issues/Issue.tsx', "import { Chat } from '@/features/chat/Chat'"],
    ['lib/reader.ts', "import { X } from './shared'"],
    ['components/ui/menu.tsx', "import { X } from '@/lib/shared'"],
  ])('accepts a fixture or an import within the layer direction in %s', (file, text) => {
    expect(lowerLayerViolations(edgesFrom(file, text))).toEqual([])
  })

  const rootModules = (files: readonly string[]) =>
    files.filter((file) => /\.tsx?$/.test(file) && !/\.(?:d|test|spec)\.tsx?$/.test(file))

  it('src root contains entry styles, declarations and regression tests only', () => {
    const files = readdirSync(SRC, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
    expect(rootModules(files)).toEqual([])
    expect(files).toEqual(expect.arrayContaining(['index.css', 'styles.css', 'vite-env.d.ts']))
  })

  it('rejects a new runtime root module while allowing declarations and tests', () => {
    expect(
      rootModules([
        'feature.ts',
        'Screen.tsx',
        'vite-env.d.ts',
        'wiring.test.ts',
        'screen.spec.tsx',
      ]),
    ).toEqual(['feature.ts', 'Screen.tsx'])
  })
})
