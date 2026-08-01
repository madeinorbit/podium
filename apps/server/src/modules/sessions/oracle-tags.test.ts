/**
 * ORACLE — the tag ratchet (POD-379 acceptance criterion 4).
 *
 * "Each characterization is tagged must-not-change or will-change; every
 * will-change tag names the superseding issue." That is only true if it stays
 * true, so it is enforced here rather than reviewed by eye.
 *
 * Scope: EVERY oracle file, including the one outside apps/server
 * (packages/client-core/src/engine/outbox-coverage.oracle.test.ts). A ratchet
 * that scans one directory silently exempts the other.
 *
 * Parser: matches every vitest declaration form — `it(`, `test(`, and the
 * `.each`/`.only`/`.skip`/`.concurrent`/`.fails` variants — because a rule that
 * only knows `it(` is bypassed by writing `test(`.
 *
 * Reading the SOURCE (rather than vitest's collected names) is deliberate: it
 * catches a hand-typed tag string that would render identically but drift from
 * the helper the migration greps for.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MUST_NOT_CHANGE, PROVISIONAL_REFERENCES, SUPERSEDING_ISSUES } from './oracle-support'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../../..')

/** Oracle files OUTSIDE this directory. Listed explicitly so adding one without
 *  tagging it is a conscious act, not an accident of where it was filed. */
const EXTERNAL_ORACLES = ['packages/client-core/src/engine/outbox-coverage.oracle.test.ts']

const ORACLE_FILES: { label: string; path: string }[] = [
  ...readdirSync(here)
    .filter((f) => f.startsWith('oracle-') && f.endsWith('.test.ts') && f !== 'oracle-tags.test.ts')
    .sort()
    .map((f) => ({ label: f, path: join(here, f) })),
  ...EXTERNAL_ORACLES.map((rel) => ({ label: rel, path: join(repoRoot, rel) })),
]

/**
 * Every test DECLARATION in a file, with its 1-based line. Covers `it(`,
 * `test(` and any modifier chain (`it.each([...])(`, `test.skip(`, …).
 */
function testOpenings(source: string): { line: number; text: string }[] {
  const declaration = /^\s*(it|test)(\.[a-zA-Z]+(\([^)]*\))?)*\s*(\(|`)/
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => declaration.test(text))
}

/** Local consts a file may hoist a tag into — only if built from a tag helper. */
function hoistedTags(source: string): Set<string> {
  return new Set(
    [
      ...source.matchAll(
        /const\s+([A-Z][A-Z0-9_]*)\s*=\s*(willChange\(|provisional\(|MUST_NOT_CHANGE)/g,
      ),
    ].map((m) => m[1] as string),
  )
}

function namedIssues(source: string): string[] {
  return [...source.matchAll(/willChange\(\s*'([^']+)'/g)].map((m) => m[1] as string)
}

function namedProvisionalReferences(source: string): string[] {
  return [...source.matchAll(/provisional\(\s*'([^']+)'/g)].map((m) => m[1] as string)
}

describe('oracle tag ratchet', () => {
  it('scans every oracle file, in apps/server AND outside it', () => {
    expect(ORACLE_FILES.length).toBeGreaterThanOrEqual(7)
    expect(ORACLE_FILES.map((f) => f.label)).toContain('oracle-handoff.test.ts')
    expect(ORACLE_FILES.map((f) => f.label)).toContain(
      'packages/client-core/src/engine/outbox-coverage.oracle.test.ts',
    )
    // Every listed path must actually exist — a moved file must not silently
    // drop out of the ratchet's reach.
    for (const file of ORACLE_FILES)
      expect(readFileSync(file.path, 'utf8').length).toBeGreaterThan(0)
  })

  for (const file of ORACLE_FILES) {
    it(`${file.label}: every characterization opens with a tag helper`, () => {
      const source = readFileSync(file.path, 'utf8')
      const openings = testOpenings(source)
      expect(openings.length).toBeGreaterThan(0)

      const hoisted = hoistedTags(source)
      const untagged = openings.filter(({ text }) => {
        if (
          text.includes('${MUST_NOT_CHANGE}') ||
          text.includes('${willChange(') ||
          text.includes('${provisional(')
        )
          return false
        const local = /\$\{([A-Z][A-Z0-9_]*)\}/.exec(text)?.[1]
        return !(local && hoisted.has(local))
      })
      expect(untagged.map((o) => `${file.label}:${o.line}`)).toEqual([])
    })
  }

  it('a file that re-declares the tag locally must use the canonical literal', () => {
    // The client-core oracle cannot import from apps/server (boundary rule 4), so
    // it declares its own MUST_NOT_CHANGE. That is only safe while the literal
    // matches — a drifted spelling would render fine and grep differently.
    for (const file of ORACLE_FILES) {
      const source = readFileSync(file.path, 'utf8')
      for (const match of source.matchAll(/const\s+MUST_NOT_CHANGE\s*=\s*'([^']*)'/g)) {
        expect(`${file.label}: ${match[1]}`).toBe(`${file.label}: ${MUST_NOT_CHANGE}`)
      }
    }
  })

  it('the parser sees test(), it.each() and modifier chains, not only bare it()', () => {
    const sample = [
      '  it(`${MUST_NOT_CHANGE}: a`, () => {})',
      '  test(`untagged b`, () => {})',
      '  it.each([1])(`untagged c`, () => {})',
      '  test.skip(`untagged d`, () => {})',
      '  it.concurrent(`${MUST_NOT_CHANGE}: e`, () => {})',
      '  const notATest = iterate(`x`)',
    ].join('\n')

    expect(testOpenings(sample).map((o) => o.line)).toEqual([1, 2, 3, 4, 5])
  })

  it('every will-change tag names a superseding issue from the declared set', () => {
    const named = new Set(
      ORACLE_FILES.flatMap((file) => namedIssues(readFileSync(file.path, 'utf8'))),
    )

    expect(named.size).toBeGreaterThan(0)
    for (const issue of named) {
      expect(SUPERSEDING_ISSUES as readonly string[]).toContain(issue)
    }
  })

  it('every provisional tag names an authoritative open decision or split issue', () => {
    const named = new Set(
      ORACLE_FILES.flatMap((file) => namedProvisionalReferences(readFileSync(file.path, 'utf8'))),
    )

    expect(named.size).toBeGreaterThan(0)
    for (const reference of named) {
      expect(PROVISIONAL_REFERENCES as readonly string[]).toContain(reference)
    }
  })

  it('the known will-change classes are all represented — a missing one means a characterization was dropped', () => {
    const named = new Set(
      ORACLE_FILES.flatMap((file) => namedIssues(readFileSync(file.path, 'utf8'))),
    )

    // POD-1073 human-vs-human authz, POD-1075 user principal + attribution,
    // POD-1079 machines as owned compute.
    //
    // TWO ISSUES HAVE LEFT THIS LIST BY LANDING, and the removals are the record
    // that their characterizations were REPLACED rather than dropped:
    //   - POD-642: handoff now single-flights duplicate dispatch;
    //   - POD-1076: session `readAt` is stored per user, so the characterization
    //     that measured it as one instance-wide value is now a pinned
    //     must-not-change about the unscoped FEED (oracle-presence.test.ts).
    // This list is what is still PENDING; a landed issue left in it would keep
    // asserting that its characterization has not been replaced yet.
    expect([...named].sort()).toEqual(['POD-1073', 'POD-1075', 'POD-1079'])
  })
})
