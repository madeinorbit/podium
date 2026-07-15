/**
 * Schema convergence [spec:SP-4428]: a fresh drizzle-built database and an
 * existing (pre-drizzle) database bridged onto drizzle end up with the same
 * DATA schema, and the bridge never re-runs the baseline it stamps.
 *
 * The comparison excludes the two migration ledgers (`schema_version`,
 * `__drizzle_migrations`) — a bridged DB keeps the legacy `schema_version`
 * table (never dropped) and gains the stamped baseline; a fresh DB never has
 * `schema_version` at all. Those ledgers legitimately differ; the data schema
 * must not. The bridge comparison additionally excludes the FTS5 objects
 * (`*_fts`, its shadow tables, and the `conversations_a{i,d,u}` triggers) —
 * `ConversationsRepository.ensureFts()` creates those idempotently on every
 * boot, so a pre-boot snapshot never has them yet.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../store'
import { BASELINE_MIGRATION } from './drizzle-manifest.generated'
import { appliedDrizzleNames, BASELINE_LEGACY_VERSION } from './index'

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

describe('bridging an existing (pre-drizzle) database onto drizzle', () => {
  it('preserves the existing data schema and data, and stamps (never re-executes) the baseline', () => {
    const file = tmpDbFile('bridge.db')
    {
      const db: SqlDatabase = openDatabase(file)
      for (const stmt of BASELINE_MIGRATION.sql.split('--> statement-breakpoint')) {
        db.exec(stmt)
      }
      db.exec(
        `CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)`,
      )
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        BASELINE_LEGACY_VERSION,
        'session-geometry',
        new Date().toISOString(),
      )
      db.prepare(
        `INSERT INTO sessions
           (id, agent_kind, cwd, title, origin_kind, status, durable_label, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'sess_seed',
        'claude-code',
        '/tmp/x',
        'seed session',
        'spawn',
        'exited',
        'seed',
        't',
        't',
      )
      db.close()
    }

    const before = dataSchemaOf(file)

    const store = new SessionStore(file)
    store.close()

    const db = openDatabase(file)
    const seeded = db.prepare('SELECT title FROM sessions WHERE id = ?').get('sess_seed') as
      | { title: string }
      | undefined
    expect(seeded?.title).toBe('seed session')
    // The legacy schema_version ledger survives untouched (never dropped)...
    expect(db.prepare(`SELECT version FROM schema_version`).get()).toEqual({
      version: BASELINE_LEGACY_VERSION,
    })
    // ...and the baseline is now recorded in the drizzle ledger too, by STAMP —
    // its DDL never re-ran (the seeded row above proves the table wasn't rebuilt).
    expect(appliedDrizzleNames(db)).toEqual(new Set([BASELINE_MIGRATION.name]))
    db.close()

    expect(dataSchemaOf(file)).toEqual(before)
  })
})
