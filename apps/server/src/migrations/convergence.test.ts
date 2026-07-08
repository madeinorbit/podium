/**
 * Convergence proof (Phase 1, deliverable 1): a database built by the LEGACY
 * SessionStore.migrate() DDL path and then upgraded through the migration
 * chain ends up with a sqlite_master byte-identical to a database built from
 * scratch by the chain alone.
 *
 * The legacy path is simulated by executing the DDL captured verbatim from a
 * legacy-built database's sqlite_master (legacy-schema.fixture.ts) and
 * stamping schema_version = 1 (the no-op baseline every legacy DB adopted).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../store'
import { LEGACY_SCHEMA_SQL } from './legacy-schema.fixture'
import { codeSchemaVersion, dbSchemaVersion } from './index'

function schemaOf(file: string): { type: string; name: string; sql: string | null }[] {
  const db = openDatabase(file)
  const rows = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; sql: string | null }[]
  db.close()
  return rows
}

function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'podium-converge-')), name)
}

describe('schema convergence: legacy-built DB + migration chain == fresh chain', () => {
  it('produces a byte-identical sqlite_master on both paths', () => {
    // Path A: a database exactly as the legacy migrate() left it (schema_version
    // stamped 1), then opened by the current code (runs migrations 002+).
    const legacyFile = tmpDb('legacy.db')
    {
      const db = openDatabase(legacyFile)
      for (const sql of LEGACY_SCHEMA_SQL) db.exec(sql)
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        1,
        'baseline',
        '2026-01-01T00:00:00.000Z',
      )
      db.close()
    }
    new SessionStore(legacyFile).close()

    // Path B: a fresh database built entirely by the migration chain.
    const freshFile = tmpDb('fresh.db')
    new SessionStore(freshFile).close()

    const legacySchema = schemaOf(legacyFile)
    const freshSchema = schemaOf(freshFile)
    expect(legacySchema.length).toBeGreaterThan(40) // the schema actually exists
    expect(legacySchema).toEqual(freshSchema)

    // Both stamped to the full chain.
    for (const file of [legacyFile, freshFile]) {
      const db = openDatabase(file)
      expect(dbSchemaVersion(db)).toBe(codeSchemaVersion())
      db.close()
    }
  })

  it('reopening either database applies no further schema change (idempotent)', () => {
    const file = tmpDb('reopen.db')
    new SessionStore(file).close()
    const before = schemaOf(file)
    new SessionStore(file).close()
    expect(schemaOf(file)).toEqual(before)
  })
})
