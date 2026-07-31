/**
 * THE MEMBERSHIP GATE, RUN WHERE CI WILL SEE IT — POD-1211.
 *
 * `scripts/audit-durable-classes.ts` is a CLI, and CI runs `bun run test`, not a
 * list of auditors. A gate in a mode nobody invokes proves nothing, so the gate
 * runs here: the repo audit itself, plus the probe that proves every check can
 * report a PRESENCE and not only an absence.
 *
 * The cases below are the ones the CLI's `--probe` cannot express, because they
 * need the REAL matrix rather than a fixture: that the shipped inventory is
 * exhaustive against the shipped schemas, and — the one that matters — that the
 * gate reports the exact defect POD-385 found, when it is put back.
 */

import { describe, expect, it } from 'vitest'
import { OWNERSHIP_MATRIX_INDEX } from '../packages/model/src/annotations/matrix'
import {
  auditRepo,
  checkDrizzleTables,
  checkMatrixMembership,
  checkRuntimeTables,
  checkWriteSites,
  DURABLE_STORES,
  type DurableStore,
  probe,
  readSources,
  runtimeTables,
  sourceFiles,
} from './audit-durable-classes'

describe('the shipped repo passes its own membership gate', () => {
  it('has every durable store on the matrix or explained', () => {
    expect(auditRepo()).toEqual([])
  })

  it('classifies every store it lists — nothing rides the default-closed backstop', () => {
    // The point of the whole exercise: `visibilityClassOf` answers `personal`
    // for a class nobody classified, so "it resolves to something" is not
    // evidence. Membership in the INDEX is.
    for (const store of DURABLE_STORES) {
      if (store.row === null) continue
      expect(
        OWNERSHIP_MATRIX_INDEX.has(store.row),
        `${store.store} names a row that is not on the matrix: ${store.row}`,
      ).toBe(true)
    }
  })
})

describe('every check can say YES', () => {
  it('finds its planted fixture and spares the clean one, for all nine', () => {
    expect(probe()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The defect this gate exists for, put back one class at a time
// ---------------------------------------------------------------------------

describe('the gate reports POD-385’s finding when it is restored', () => {
  /** The three shapes the sweep found, one per population it lives in. */
  const restored: readonly { readonly name: string; readonly store: string }[] = [
    // A table with no row: the original fourteen.
    { name: 'a drizzle table nobody classified', store: 'notification_facts' },
    // A table drizzle never sees: the half a schema-keyed gate would miss.
    { name: 'a runtime-created table nobody classified', store: 'conversation_cache' },
    // A store with no table at all: pspec, the class that started this.
    { name: 'a filesystem store nobody classified', store: '<repo>/pspec/SP-xxxx.html' },
  ]

  for (const { name, store } of restored) {
    it(`catches ${name}`, () => {
      const withoutIt = DURABLE_STORES.filter((s) => s.store !== store)
      expect(withoutIt.length).toBe(DURABLE_STORES.length - 1)
      const files = readSources(sourceFiles())
      const schemas = readSources([
        'apps/server/src/migrations/schema.ts',
        'packages/sync/src/adapters/sqlite/schema.ts',
      ])
      const findings = [
        ...checkDrizzleTables(schemas, withoutIt),
        ...checkRuntimeTables(files, withoutIt),
        ...checkWriteSites(files, withoutIt),
      ]
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.map((f) => f.where).join('\n')).toContain(
        store.startsWith('<repo>') ? 'apps/server/src/pspec.ts' : store,
      )
    })
  }

  it('catches a MISTYPED row id, which `visibilityClassOf` cannot (POD-731)', () => {
    const typo: DurableStore[] = [{ store: 'x', kind: 'drizzle-table', row: 'advisory-lock' }]
    const findings = checkMatrixMembership(typo)
    expect(findings.map((f) => f.check)).toContain('store-names-a-row-that-does-not-exist')
    // And the counterfactual that makes the assertion mean something: the
    // correctly-spelled id is accepted, so the check is discriminating between
    // the two spellings rather than rejecting everything.
    expect(
      checkMatrixMembership([{ store: 'x', kind: 'drizzle-table', row: 'advisory-locks' }]),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The scanner's own blind spots, pinned
// ---------------------------------------------------------------------------

describe('the runtime-table scanner reads the forms the repo actually uses', () => {
  it('reads the `${CONST}` form the mobile replica writes all four of its tables in', () => {
    const source = readSources(['packages/sync/src/adapters/mobile-sqlite/schema.ts'])[0]
      ?.source as string
    expect(runtimeTables(source).sort()).toEqual(['entities', 'meta', 'outbox', 'schema_version'])
  })

  it('reads the FTS form, and does not mistake a SQL keyword for a table name', () => {
    expect(
      runtimeTables('CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(x)'),
    ).toEqual(['transcript_fts'])
    // Prose in a comment: `CREATE TABLE IF NOT EXISTS` with no name after it must
    // not be read as a table called `IF`, which is what the first draft did.
    expect(runtimeTables('created at runtime with `CREATE TABLE IF NOT EXISTS`')).toEqual([])
  })
})
