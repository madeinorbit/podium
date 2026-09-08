import { describe, expect, it } from 'vitest'
import {
  type LibsqlMigrationSession,
  runLibsqlMigrationsOn,
} from './libsql'
import type { DrizzleMigration } from './index'

const A: DrizzleMigration = {
  name: '20260101000000_a',
  sql: 'CREATE TABLE a (id TEXT PRIMARY KEY);',
}
const B: DrizzleMigration = {
  name: '20260101000001_b',
  sql: 'CREATE TABLE b (id TEXT PRIMARY KEY);',
}

function fakeSession(applied: string[] = []): LibsqlMigrationSession & {
  executed: string[]
  batched: string[]
} {
  const tables = new Set<string>(applied.length > 0 ? ['__drizzle_migrations'] : [])
  const ledger = [...applied]
  const executed: string[] = []
  const batched: string[] = []
  return {
    executed,
    batched,
    async execute(sql, args) {
      executed.push(sql)
      if (sql.includes('sqlite_master') && args?.[0] === '__drizzle_migrations') {
        return { rows: tables.has('__drizzle_migrations') ? [{ name: '__drizzle_migrations' }] : [] }
      }
      if (sql.startsWith('SELECT name FROM __drizzle_migrations')) {
        return { rows: ledger.map((name) => ({ name })) }
      }
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS __drizzle_migrations')) {
        tables.add('__drizzle_migrations')
        return { rows: [] }
      }
      if (sql.startsWith('PRAGMA')) return { rows: [] }
      return { rows: [] }
    },
    async batch(statements) {
      for (const statement of statements) {
        batched.push(statement.sql)
        if (statement.sql.startsWith('INSERT INTO __drizzle_migrations')) {
          const name = statement.args?.[2]
          if (typeof name === 'string') ledger.push(name)
        }
      }
    },
  }
}

describe('runLibsqlMigrationsOn', () => {
  it('applies pending migrations as one batch and writes the bun ledger shape', async () => {
    const session = fakeSession()
    const applied = await runLibsqlMigrationsOn(session, [A, B], { skipSchemaRepair: true })
    expect(applied).toEqual([A.name, B.name])
    expect(session.executed.some((sql) => sql.startsWith('PRAGMA foreign_keys = OFF'))).toBe(true)
    expect(session.executed.some((sql) => sql.startsWith('PRAGMA foreign_keys = ON'))).toBe(true)
    expect(session.batched).toEqual([
      A.sql,
      'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)',
      B.sql,
      'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)',
    ])
  })

  it('refuses a ledger this build does not define', async () => {
    const session = fakeSession(['20990101000000_from-the-future'])
    await expect(runLibsqlMigrationsOn(session, [A], { skipSchemaRepair: true })).rejects.toThrow(
      /newer than this build/,
    )
  })

  it('does not backup — backup is platform-managed', async () => {
    const session = fakeSession([A.name])
    const applied = await runLibsqlMigrationsOn(session, [A, B], { skipSchemaRepair: true })
    expect(applied).toEqual([B.name])
    expect(session.executed.join('\n')).not.toMatch(/backup|VACUUM INTO|journal_mode/i)
  })
})
