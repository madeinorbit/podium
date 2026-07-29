/**
 * ORACLE — the tag ratchet (POD-379 acceptance criterion 4).
 *
 * "Each characterization is tagged must-not-change or will-change; every
 * will-change tag names the superseding issue." That is only true if it stays
 * true, so it is enforced here rather than reviewed by eye: every `it(...)` in
 * an oracle file must open with one of the two tag helpers, and a will-change
 * tag must name an issue from SUPERSEDING_ISSUES.
 *
 * Reading the SOURCE (rather than vitest's collected names) is deliberate: it
 * catches a hand-typed tag string that would render identically but drift from
 * the helper the migration greps for.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SUPERSEDING_ISSUES } from './oracle-support'

const here = dirname(fileURLToPath(import.meta.url))
const ORACLE_FILES = readdirSync(here)
  .filter((f) => f.startsWith('oracle-') && f.endsWith('.test.ts') && f !== 'oracle-tags.test.ts')
  .sort()

/** Every `it(` opening in a file, with its 1-based line number. */
function testOpenings(source: string): { line: number; text: string }[] {
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => /^\s*it\(/.test(text))
}

describe('oracle tag ratchet', () => {
  it('finds every oracle file (the ratchet is not silently scanning nothing)', () => {
    expect(ORACLE_FILES.length).toBeGreaterThanOrEqual(6)
    expect(ORACLE_FILES).toContain('oracle-handoff.test.ts')
  })

  for (const file of ORACLE_FILES) {
    it(`${file}: every characterization opens with a tag helper`, () => {
      const source = readFileSync(join(here, file), 'utf8')
      const openings = testOpenings(source)
      expect(openings.length).toBeGreaterThan(0)

      // A file may hoist a tag into a local const, but ONLY if that const is
      // itself built from a tag helper — an arbitrary uppercase string is not a
      // tag, and must not read as one.
      const hoisted = new Set(
        [...source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*(willChange\(|MUST_NOT_CHANGE)/g)].map(
          (m) => m[1] as string,
        ),
      )
      const untagged = openings.filter(({ text }) => {
        if (text.includes('${MUST_NOT_CHANGE}') || text.includes('${willChange(')) return false
        const local = /\$\{([A-Z][A-Z0-9_]*)\}/.exec(text)?.[1]
        return !(local && hoisted.has(local))
      })
      expect(untagged.map((o) => `${file}:${o.line}`)).toEqual([])
    })
  }

  it('every will-change tag names a superseding issue from the declared set', () => {
    const named = new Set<string>()
    for (const file of ORACLE_FILES) {
      const source = readFileSync(join(here, file), 'utf8')
      for (const match of source.matchAll(/willChange\(\s*'([^']+)'/g)) {
        named.add(match[1] as string)
      }
    }

    expect(named.size).toBeGreaterThan(0)
    for (const issue of named) {
      expect(SUPERSEDING_ISSUES as readonly string[]).toContain(issue)
    }
  })

  it('the known will-change classes are all represented — a missing one means a characterization was dropped', () => {
    const named = new Set<string>()
    for (const file of ORACLE_FILES) {
      const source = readFileSync(join(here, file), 'utf8')
      for (const match of source.matchAll(/willChange\(\s*'([^']+)'/g)) {
        named.add(match[1] as string)
      }
    }

    // POD-1076 per-user state, POD-1073 human-vs-human authz, POD-1075 user
    // principal + attribution, POD-1079 machines as owned compute.
    expect([...named].sort()).toEqual(['POD-1073', 'POD-1075', 'POD-1076', 'POD-1079'])
  })
})
