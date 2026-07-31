/**
 * DRIFT GATE on the Phase-2 release-criteria thresholds [POD-1253].
 *
 * `docs/rearchitecture-v3.md` §RELEASE-CRITERIA THRESHOLDS fixes the numbers POD-337
 * grades the programme against. Five of them are INHERITED — already committed in code
 * for a reason of their own, and adopted by the table rather than restated. A document
 * that quotes a constant starts lying silently the day the constant moves, and a lying
 * threshold table is precisely the instrument-that-cannot-say-NO this run exists to
 * catch: POD-337 would compare a real reading against a number the code abandoned.
 *
 * So this gate pins BOTH SIDES of each inherited number:
 *
 *   1. the constant still exists under its name, with that value, in its source file;
 *   2. the doc still states the same value.
 *
 * A rename or a deletion is a FAILURE, never a skip — a regex that matches nothing
 * reports the same green as a value that agrees, and the whole point of this file is
 * that it must be able to say NO. Every row asserts a match count of exactly 1 before
 * it looks at the value.
 *
 * Thresholds whose basis is a perception limit or an incident (§T1 rows 1, 3b, 6, 8, 9)
 * are NOT pinned here and cannot be: nothing in the tree holds them. That is stated in
 * the doc rather than papered over with a test that only checks the doc against itself.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const DOC = 'docs/rearchitecture-v3.md'

function read(file: string): string {
  return readFileSync(join(repoRoot, file), 'utf8')
}

/**
 * One inherited number. `pattern` must capture the value AS WRITTEN in the source, so a
 * changed expression (`14 * DAY` → `30 * DAY`) fails even when the unit is unchanged.
 * `docPhrase` is the distinctive fragment of the threshold table that carries the value —
 * matching a bare number would pass on any other row that happens to share it.
 */
interface InheritedRow {
  readonly what: string
  readonly file: string
  readonly pattern: RegExp
  readonly value: string
  readonly docPhrase: string
}

const INHERITED: readonly InheritedRow[] = [
  {
    what: 'change-log retention rows (§T1 row 2)',
    file: 'packages/sync/src/change-log.ts',
    pattern: /^export const CHANGE_KEEP_ROWS = (.+)$/m,
    value: '20_000',
    docPhrase: '**CHANGE_KEEP_ROWS (20 000)**',
  },
  {
    what: 'change-log retention age (§T1 row 2)',
    file: 'packages/sync/src/change-log.ts',
    pattern: /^export const CHANGE_MAX_AGE_MS = (.+)$/m,
    value: '3 * 24 * 60 * 60 * 1000',
    docPhrase: '`CHANGE_MAX_AGE_MS = 3 d`',
  },
  {
    what: 'outbox dead-letter horizon (§T1 row 4)',
    file: 'packages/sync/src/outbox/limits.ts',
    pattern: /^export const OUTBOX_MAX_AGE_MS = (.+)$/m,
    value: '14 * DAY',
    docPhrase: '`OUTBOX_MAX_AGE_MS = 14 d` is a horizon, not a budget',
  },
  {
    what: 'event-loop p99 budget (§T1 rows 3, 6, 7)',
    file: 'scripts/loop-split-load.integration.test.ts',
    pattern: /^const LOOP_P99_TARGET_MS = (.+)$/m,
    value: '50',
    docPhrase: 'p95 ≤ **25 ms** / p99 ≤ **50 ms**',
  },
  {
    what: 'interaction p95 budget (§T1 row 7)',
    file: 'scripts/loop-split-load.integration.test.ts',
    pattern: /^const INTERACTION_P95_TARGET_MS = (.+)$/m,
    value: '25',
    docPhrase: 'p95 ≤ **25 ms** / p99 ≤ **50 ms**',
  },
  {
    what: 'interaction p99 budget (§T1 row 7)',
    file: 'scripts/loop-split-load.integration.test.ts',
    pattern: /^const INTERACTION_P99_TARGET_MS = (.+)$/m,
    value: '50',
    docPhrase: 'p95 ≤ **25 ms** / p99 ≤ **50 ms**',
  },
  {
    what: 'representative scale — sessions (§T1 row 6)',
    file: 'scripts/loop-split-load.integration.test.ts',
    pattern: /^const SESSION_COUNT = (.+)$/m,
    value: '588',
    docPhrase: '588 sessions / 800 issues',
  },
  {
    what: 'representative scale — issues (§T1 row 6)',
    file: 'scripts/loop-split-load.integration.test.ts',
    pattern: /^const ISSUE_COUNT = (.+)$/m,
    value: '800',
    docPhrase: '588 sessions / 800 issues',
  },
  {
    what: 'warm-set cap, desktop (§T1 row 9)',
    file: 'apps/web/src/features/terminal/use-warm-set.ts',
    pattern: /^const DESKTOP_N = (.+)$/m,
    value: '8',
    docPhrase: 'with all **8** panes warm',
  },
  {
    what: 'warm-set cap, mobile (§T1 row 9b)',
    file: 'apps/web/src/features/terminal/use-warm-set.ts',
    pattern: /^const MOBILE_N = (.+)$/m,
    value: '3',
    docPhrase: '(8 desktop / 3 mobile, `use-warm-set.ts`)',
  },
  {
    what: 'health-probe grace, the server cold-start hard ceiling (§T1 row 1b)',
    file: 'scripts/podium-health-probe.sh',
    pattern: /PODIUM_HEALTH_GRACE:-(\d+)/,
    value: '120',
    docPhrase: 'hard fail **120 s**',
  },
]

describe('release-criteria thresholds do not drift from the constants they inherit', () => {
  const doc = read(DOC)

  for (const row of INHERITED) {
    describe(row.what, () => {
      const source = read(row.file)

      it(`is still declared in ${row.file} (a rename or deletion fails here, it does not skip)`, () => {
        const global = new RegExp(row.pattern.source, `${row.pattern.flags.replace('g', '')}g`)
        const matches = [...source.matchAll(global)]
        // Match count FIRST: a pattern that finds nothing would otherwise report the same
        // green as a value that agrees, and a second declaration means the one this gate
        // reads may not be the one the product uses.
        expect(
          matches.length,
          `${row.file}: expected exactly 1 declaration matching ${row.pattern}, found ${matches.length}. ` +
            `If the constant was renamed or moved, update BOTH this row and ${DOC}.`,
        ).toBe(1)
      })

      it('still holds the value the threshold table states', () => {
        const captured = source.match(row.pattern)?.[1]?.trim()
        expect(captured).toBe(row.value)
      })

      it(`is still stated in ${DOC} with that value`, () => {
        expect(
          doc.includes(row.docPhrase),
          `${DOC} no longer contains "${row.docPhrase}". The table was edited away from the code, ` +
            `or the phrase moved — either way POD-337 would grade against a number nothing holds.`,
        ).toBe(true)
      })
    })
  }

  it('the derived per-pane budget is still the ceiling divided by the desktop warm cap', () => {
    // §T1 row 9 states a ceiling AND the per-pane figure derived from it. Two numbers
    // that must agree by arithmetic drift apart the moment one is edited alone.
    const cap = Number(
      read('apps/web/src/features/terminal/use-warm-set.ts').match(
        /^const DESKTOP_N = (\d+)$/m,
      )?.[1],
    )
    expect(cap).toBeGreaterThan(0)
    const CEILING_MB = 1000 // "≤ 1.0 GB" in the table
    expect(Math.round(CEILING_MB / cap)).toBe(125)
    expect(doc).toContain('≤ **1.0 GB** ⇒ marginal ≤ **~125 MB/pane**')
  })

  it('the runbook and the threshold section are both present in the Phase 2 ledger', () => {
    // The two acceptance criteria POD-310 R1 found unwritten. Their ABSENCE is what the
    // exit gate refused on, so their presence is worth asserting mechanically rather than
    // trusting that nobody reverts a doc.
    const phase2 = doc.slice(
      doc.indexOf('### Phase 2 — One sync kernel'),
      doc.indexOf('### Phase 3 — Command registry'),
    )
    expect(phase2.length).toBeGreaterThan(0)
    expect(phase2).toContain('#### RELEASE-CRITERIA THRESHOLDS')
    expect(phase2).toContain('#### RUNBOOK — POD-310 local-topology upgrade rehearsal')
  })
})
