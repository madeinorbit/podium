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
// The four tables the multi-user epic added, pinned INDEPENDENTLY of the sweep
// ---------------------------------------------------------------------------

/**
 * WHY THESE FOUR NEED A TEST OF THEIR OWN, when `auditRepo()` above already
 * asserts the whole inventory is exhaustive.
 *
 * Because that assertion is RED, and was red before this epic started: the sweep
 * reports findings inherited from long before these tables existed, so a fifth
 * one changes a number nobody reads. That is not a hypothetical — it is how
 * these four landed. `member_invites`, `issue_participants`, `managed_credentials`
 * and `ownership_migration_dispositions` were added undeclared, the gate went
 * from 68 findings to 72, and nothing anywhere said so. A guard that only fires
 * by making a red test redder is not a guard.
 *
 * So this block asserts the same obligation for exactly the four, and it PASSES
 * today. Delete one of their entries and this goes red on its own, with the
 * table named, while the sweep above carries on reporting its inherited 68.
 *
 * IF ONE OF THESE TABLES IS LEGITIMATELY DROPPED, delete it from this list in the
 * same commit that drops it. The list is the four this epic added, not a floor —
 * `drizzle-table-stale` is what catches a declaration outliving its table.
 */
describe('the tables the multi-user epic added are each classified', () => {
  const EPIC_TABLES = [
    'member_invites',
    'issue_participants',
    'managed_credentials',
    'ownership_migration_dispositions',
  ] as const

  const schemas = (): { file: string; source: string }[] =>
    readSources([
      'apps/server/src/migrations/schema.ts',
      'packages/sync/src/adapters/sqlite/schema.ts',
    ])

  for (const table of EPIC_TABLES) {
    it(`${table} is declared, once, and says what classifies it`, () => {
      const entries = DURABLE_STORES.filter((s) => s.store === table)
      expect(entries.length, `${table} must have exactly one entry`).toBe(1)
      const entry = entries[0] as DurableStore
      if (entry.row === null) {
        // The `null` arm is a REASON, and the gate checks it for length because
        // an empty one is a shrug. Asserted here too so the arm cannot be taken
        // by accident on a table that ought to name a row.
        expect((entry.notEntityState ?? '').length).toBeGreaterThanOrEqual(60)
      } else {
        // MEMBERSHIP, not resolution. `visibilityClassOf` would answer `personal`
        // for a row id that does not exist, which is the POD-731 hole; only the
        // index can tell a real row from a plausible string.
        expect(
          OWNERSHIP_MATRIX_INDEX.has(entry.row),
          `${table} names a row that is not on the matrix: ${entry.row}`,
        ).toBe(true)
      }
    })

    it(`${table} is what makes the gate quiet about ${table}`, () => {
      // The discriminating half. Without it the test above passes on an entry
      // that happens to sit in the array while something else is what silenced
      // the check — and then removing the entry would change nothing.
      const withoutIt = DURABLE_STORES.filter((s) => s.store !== table)
      expect(withoutIt.length).toBe(DURABLE_STORES.length - 1)
      const reported = (inventory: readonly DurableStore[]): string[] =>
        checkDrizzleTables(schemas(), inventory)
          .filter((f) => f.check === 'drizzle-table-undeclared')
          .map((f) => f.where)
      expect(reported(withoutIt).join('\n')).toContain(table)
      expect(reported(DURABLE_STORES).join('\n')).not.toContain(table)
    })
  }

  it('a typo in any of their row ids is still caught', () => {
    // The four are only safe while the row they name is real. A test that asserts
    // membership and never plants a miss cannot tell a live index from an empty
    // one, so plant the miss and its counterfactual for each named row.
    for (const table of EPIC_TABLES) {
      const entry = DURABLE_STORES.find((s) => s.store === table) as DurableStore
      if (entry.row === null) continue
      expect(
        checkMatrixMembership([{ ...entry, row: `${entry.row}x` }]).map((f) => f.check),
        `a bad row id under ${table} must be reported`,
      ).toContain('store-names-a-row-that-does-not-exist')
      expect(checkMatrixMembership([entry])).toEqual([])
    }
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

  it('ignores a CREATE TABLE inside a comment, and still reads executed SQL', () => {
    // POD-1246: `restore.ts` documents at length why `CREATE TABLE IF NOT EXISTS
    // feed_identity` is the WRONG fix and does not do it. The scanner read that
    // prose as a create site and demanded a declaration for a table the file never
    // creates — so documenting a rejected alternative became a lint failure.
    //
    // Both halves matter, and the second is the one that keeps this honest: a
    // stripper that ate too much would silently stop seeing real create sites, and
    // this whole gate would go quiet while reporting success.
    expect(runtimeTables('/* the tempting fix — CREATE TABLE IF NOT EXISTS feed_identity — */')).toEqual([])
    expect(runtimeTables('// CREATE TABLE commented_out (x)')).toEqual([])
    expect(
      runtimeTables("/* explains CREATE TABLE decoy */\ndb.exec('CREATE TABLE real_one (x)')"),
    ).toEqual(['real_one'])
    // A URL's `//` is not a line comment: eating from it to end-of-line would drop
    // whatever executed SQL shared that line.
    expect(runtimeTables("// see https://x/y\ndb.exec('CREATE TABLE after_url (x)')")).toEqual([
      'after_url',
    ])
  })
})
