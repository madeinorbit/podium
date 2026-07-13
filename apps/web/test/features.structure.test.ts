// @vitest-environment node
/**
 * Feature-folder boundary check (P5d, issue #264 — see src/features/README.md).
 *
 * Rules over apps/web/src:
 *  1. features/<a> may not import features/<b> (a !== b) — features compose
 *     only via app/. A small grandfathered exception list below carries the
 *     places where a feature legitimately embeds another feature's surface;
 *     shrink it, don't grow it.
 *  2. lib/ may not import features/ (lib is the shared layer under them).
 *     Colocated .test files are exempt — a lib test may use a feature's pure
 *     helpers as fixtures.
 *  3. components/ui/ may not import features/.
 *
 * Every exception must stay in use: a stale entry fails the suite so the list
 * only ever shrinks.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** feature -> features it may import, with the reason the seam exists. */
const EXCEPTIONS: Record<string, Record<string, string>> = {
  worklist: {
    issues: 'sidebar composes issue nav inline (context menu, status icon, new-issue, hierarchy)',
    machines: 'sidebar mounts the HostIndicators strip',
    setup: 'sidebar hosts the repo add/scan flow',
  },
  terminal: { chat: 'agent pane embeds the chat surface' },
  superagent: { chat: 'superagent thread is a chat surface' },
  settings: {
    setup: 'settings reuses the SetupView form',
    terminal: 'appearance section edits the terminal appearance store (dc7e248)',
  },
}

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

const collectEdges = (): Edge[] => {
  const edges: Edge[] = []
  for (const abs of walk(SRC)) {
    const rel = relative(SRC, abs).replaceAll('\\', '/')
    const from = layerOf(rel)
    const text = readFileSync(abs, 'utf8')
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
      if (!spec) continue
      let target: string
      if (spec.startsWith('@/')) target = spec.slice(2)
      else if (spec.startsWith('.'))
        target = relative(SRC, normalize(join(dirname(abs), spec))).replaceAll('\\', '/')
      else continue // package import
      if (target.startsWith('..')) continue // escapes src/ (none expected)
      edges.push({ file: rel, spec, from, to: layerOf(target) })
    }
  }
  return edges
}

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

  it('features do not import other features (beyond the grandfathered exceptions)', () => {
    const violations: string[] = []
    const used = new Set<string>()
    for (const e of edges) {
      if (!e.from.startsWith('feature:') || !e.to.startsWith('feature:')) continue
      const a = e.from.slice(8)
      const b = e.to.slice(8)
      if (a === b) continue
      if (EXCEPTIONS[a]?.[b]) used.add(`${a}->${b}`)
      else violations.push(`${e.file} imports '${e.spec}' (feature ${a} -> ${b})`)
    }
    expect(violations, violations.join('\n')).toEqual([])
    // Exceptions are grandfathered, not aspirational: drop entries that fell out of use.
    const declared = Object.entries(EXCEPTIONS).flatMap(([a, tos]) =>
      Object.keys(tos).map((b) => `${a}->${b}`),
    )
    expect([...used].sort()).toEqual(declared.sort())
  })

  it('lib/ and components/ui/ do not import features', () => {
    const violations = edges
      .filter(
        (e) =>
          (e.from === 'lib' || e.from === 'ui') &&
          e.to.startsWith('feature:') &&
          !/\.test\.tsx?$/.test(e.file),
      )
      .map((e) => `${e.file} imports '${e.spec}'`)
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('src root stayed unflattened (only entry-level files outside the folders)', () => {
    // The flat-src regression guard: new modules go in app/, lib/, features/*
    // or components/ui — never back into a flat src root.
    const rootFiles = readdirSync(SRC, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort()
    expect(rootFiles).toEqual(['index.css', 'styles.css', 'vite-env.d.ts'])
  })
})
