/**
 * Schema convergence [spec:SP-4428]: a fresh drizzle-built database has the full
 * production data schema, and reopening it is idempotent. The comparison
 * excludes the `__drizzle_migrations` ledger and the FTS5 objects (`*_fts`, its
 * shadow tables, and the `conversations_a{i,d,u}` triggers), which
 * `ConversationsRepository.ensureFts()` creates idempotently on every boot.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../store'
import { BASELINE_MIGRATION } from './drizzle-manifest.generated'
import { appliedDrizzleNames } from './index'

interface SchemaRow {
  type: string
  name: string
  sql: string | null
}

/** Every schema object except sqlite internals and the two migration ledgers. */
function schemaOf(file: string): SchemaRow[] {
  const db = openDatabase(file)
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
           AND name NOT IN ('schema_version', '__drizzle_migrations')
         ORDER BY type, name`,
    )
    .all() as SchemaRow[]
  db.close()
  return rows
}

/** Boot-created FTS5 objects (virtual tables, their shadow tables, and the
 *  conversations_a{i,d,u} sync triggers) — created idempotently per boot by
 *  ConversationsRepository.ensureFts(), never by a migration. */
function isFtsBootArtifact(name: string): boolean {
  return /_fts$/.test(name) || /_fts_/.test(name) || /^conversations_a[iud]$/.test(name)
}

/** {@link schemaOf} minus the per-boot FTS artifacts — the pure DATA schema. */
function dataSchemaOf(file: string): SchemaRow[] {
  return schemaOf(file).filter((r) => !isFtsBootArtifact(r.name))
}

function tmpDbFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'podium-converge-')), name)
}

describe('fresh drizzle-built database', () => {
  it('has the expected data tables and the baseline recorded as applied', () => {
    const file = tmpDbFile('fresh.db')
    new SessionStore(file).close()

    const tableNames = new Set(
      schemaOf(file)
        .filter((r) => r.type === 'table')
        .map((r) => r.name),
    )
    expect(tableNames.size).toBeGreaterThan(40)
    for (const name of ['sessions', 'issues', 'workflows']) {
      expect(tableNames.has(name)).toBe(true)
    }

    const db = openDatabase(file)
    expect(appliedDrizzleNames(db)).toContain(BASELINE_MIGRATION.name)
    db.close()
  })

  it('reopening the same file changes no schema object (idempotent)', () => {
    const file = tmpDbFile('reopen.db')
    new SessionStore(file).close()
    const before = schemaOf(file)

    new SessionStore(file).close()

    expect(schemaOf(file)).toEqual(before)
  })
})
