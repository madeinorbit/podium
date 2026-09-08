import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalMigrationName,
  instanceDatabasePath,
  isAbsentTursoDatabaseError,
  readAppliedMigrations,
  readInstanceAppliedMigrations,
} from './migration-ledger'
import { openDatabase } from './sqlite'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function scratch(): string {
  dir = mkdtempSync(join(tmpdir(), 'podium-migration-ledger-'))
  return dir
}

function ledgerAt(path: string, names: string[]): void {
  const db = openDatabase(path)
  db.exec(
    `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text)`,
  )
  const insert = db.prepare(
    `INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)`,
  )
  for (const [index, name] of names.entries()) insert.run(`h${index}`, index, name)
  db.close()
}

describe('readAppliedMigrations', () => {
  it('answers undefined for a machine that holds no database, and creates nothing', () => {
    const path = join(scratch(), 'podium.db')
    expect(readAppliedMigrations(path)).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('reads the migration names the ledger records', () => {
    const path = join(scratch(), 'podium.db')
    ledgerAt(path, ['20260715135845_baseline', '20260809112031_transcript-segment-incarnations'])
    expect(readAppliedMigrations(path)).toEqual([
      '20260715135845_baseline',
      '20260809112031_transcript-segment-incarnations',
    ])
  })

  it('answers an empty list for a database that carries no drizzle ledger', () => {
    const path = join(scratch(), 'podium.db')
    const db = openDatabase(path)
    db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)')
    db.close()
    expect(readAppliedMigrations(path)).toEqual([])
  })
})

describe('canonicalMigrationName', () => {
  it('resolves a migration deployed under its pre-rebase name to the canonical one', () => {
    expect(canonicalMigrationName('20260722210552_session-spawn-failure')).toBe(
      '20260724134702_session-spawn-failure',
    )
  })

  it('leaves every other name exactly as it is', () => {
    expect(canonicalMigrationName('20260715135845_baseline')).toBe('20260715135845_baseline')
  })
})

describe('isAbsentTursoDatabaseError', () => {
  it('treats a missing database as absence and a network failure as not', () => {
    expect(isAbsentTursoDatabaseError(new Error('database does not exist'))).toBe(true)
    expect(isAbsentTursoDatabaseError(new Error('HTTP 404'))).toBe(true)
    expect(isAbsentTursoDatabaseError(new Error('fetch failed'))).toBe(false)
    expect(isAbsentTursoDatabaseError(new Error('UNAUTHORIZED'))).toBe(false)
  })
})

describe('readInstanceAppliedMigrations', () => {
  it('on sqlite still answers undefined for a missing file and creates nothing', async () => {
    const path = join(scratch(), 'podium.db')
    expect(await readInstanceAppliedMigrations({ kind: 'sqlite' }, path)).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })
})

describe('instanceDatabasePath', () => {
  it('names podium.db below the state root it is given', () => {
    expect(instanceDatabasePath('/state/root')).toBe(join('/state/root', 'podium.db'))
  })
})
