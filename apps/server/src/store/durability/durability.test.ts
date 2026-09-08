import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { validateSqliteCandidate } from './bun-sqlite'
import {
  DurabilityError,
  DurabilityNotApplicableError,
  FILE_DURABILITY_CAPABILITIES,
  PLATFORM_DURABILITY_CAPABILITIES,
} from './port'
import { createTursoDurability } from './turso'

const tmpDirs: string[] = []
function trackTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function candidateDb(over: {
  machineId?: string
  feedId?: string
  epoch?: string
  schema?: string
} = {}): string {
  const path = join(trackTmp('pod3270-candidate-'), 'podium.db')
  const db = openDatabase(path)
  try {
    db.exec(`
      CREATE TABLE machines (id TEXT PRIMARY KEY);
      CREATE TABLE feed_identity (
        singleton INTEGER PRIMARY KEY,
        feed_id TEXT NOT NULL,
        epoch TEXT NOT NULL
      );
      CREATE TABLE __drizzle_migrations (name TEXT NOT NULL);
    `)
    db.prepare('INSERT INTO machines (id) VALUES (?)').run(over.machineId ?? 'target-machine')
    db.prepare('INSERT INTO feed_identity (singleton, feed_id, epoch) VALUES (1, ?, ?)').run(
      over.feedId ?? 'feed-1',
      over.epoch ?? 'epoch-1',
    )
    db.prepare('INSERT INTO __drizzle_migrations (name) VALUES (?)').run(over.schema ?? 'schema-1')
  } finally {
    db.close()
  }
  return path
}

const MATCHING = {
  targetMachineId: 'target-machine',
  expectedFeedId: 'feed-1',
  expectedFeedEpoch: 'epoch-1',
  expectedSchemaVersion: 'schema-1',
}

describe('Turso durability capabilities', () => {
  const queries = {
    latestMigrationName: async () => '20260715135845_baseline',
    feedIdentity: async () => ({ feedId: 'feed-1', epoch: 'epoch-1' }),
  }
  const port = createTursoDurability(queries)

  it('reports platform-managed backup and snapshot, and not-applicable fence work', () => {
    expect(port.capabilities).toEqual(PLATFORM_DURABILITY_CAPABILITIES)
    expect(port.capabilities.backup).toBe('platform-managed')
    expect(port.capabilities.snapshot).toBe('platform-managed')
    expect(port.capabilities.checkpoint).toBe('not-applicable')
    expect(port.capabilities.transferFence).toBe('not-applicable')
    expect(port.capabilities.candidateValidation).toBe('not-applicable')
    expect(port.capabilities).not.toEqual(FILE_DURABILITY_CAPABILITIES)
  })

  it('exposes migration head and feed identity through the query port', async () => {
    expect(await port.schemaVersion()).toBe('20260715135845_baseline')
    expect(await port.feedIdentity()).toEqual({ feedId: 'feed-1', epoch: 'epoch-1' })
  })

  it('refuses when the query port has no migration identity', async () => {
    const empty = createTursoDurability({
      latestMigrationName: async () => undefined,
      feedIdentity: async () => undefined,
    })
    await expect(empty.schemaVersion()).rejects.toThrow(/migration identity is unavailable/)
    await expect(empty.feedIdentity()).rejects.toThrow(DurabilityError)
  })

  it('does not take a file snapshot', async () => {
    expect(await port.snapshot('0.4.1', '0.4.2')).toBeUndefined()
    expect(await port.verifiedSnapshot('0.4.1', '0.4.2')).toMatchObject({
      ok: false,
      code: 'platform-managed',
    })
    expect(port.latestSnapshot()).toBeUndefined()
    expect(port.discoverSnapshots()).toBe(false)
  })

  it('rejects checkpoint, transfer fence and candidate-file validation as not applicable', async () => {
    await expect(port.checkpoint()).rejects.toThrow(DurabilityNotApplicableError)
    await expect(port.beginTransferFence()).rejects.toThrow(DurabilityNotApplicableError)
    await expect(port.endTransferFence()).rejects.toThrow(DurabilityNotApplicableError)
    expect(port.transferFenceActive).toBe(false)
    await expect(
      port.validateCandidate({ databasePath: '/no/such.db', ...MATCHING }),
    ).rejects.toThrow(DurabilityNotApplicableError)
  })

  it('close is a no-op', async () => {
    await expect(port.close()).resolves.toBeUndefined()
  })
})

describe('bun:sqlite candidate validation', () => {
  it('accepts a candidate whose integrity, feed identity, epoch and migration head match', () => {
    const databasePath = candidateDb()
    expect(validateSqliteCandidate({ databasePath, ...MATCHING })).toEqual({
      feedId: 'feed-1',
      feedEpoch: 'epoch-1',
      schemaVersion: 'schema-1',
    })
  })

  it('refuses a feed-identity mismatch as identity-mismatch', () => {
    const databasePath = candidateDb({ feedId: 'other-feed' })
    expect(() => validateSqliteCandidate({ databasePath, ...MATCHING })).toThrow(DurabilityError)
    try {
      validateSqliteCandidate({ databasePath, ...MATCHING })
    } catch (error) {
      expect((error as DurabilityError).code).toBe('identity-mismatch')
    }
  })

  it('refuses a schema-ledger mismatch as candidate-invalid', () => {
    const databasePath = candidateDb({ schema: 'schema-other' })
    try {
      validateSqliteCandidate({ databasePath, ...MATCHING })
    } catch (error) {
      expect(error).toBeInstanceOf(DurabilityError)
      expect((error as DurabilityError).code).toBe('candidate-invalid')
      return
    }
    throw new Error('expected candidate-invalid')
  })

  it('refuses a missing target machine as identity-mismatch', () => {
    const databasePath = candidateDb({ machineId: 'other-machine' })
    try {
      validateSqliteCandidate({ databasePath, ...MATCHING })
    } catch (error) {
      expect(error).toBeInstanceOf(DurabilityError)
      expect((error as DurabilityError).code).toBe('identity-mismatch')
      return
    }
    throw new Error('expected identity-mismatch')
  })
})

describe('store facade file-system boundary', () => {
  it('keeps node:fs and backupDatabase out of the store facade', () => {
    const source = readFileSync(fileURLToPath(new URL('../../store.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/from ['"]node:fs['"]/)
    expect(source).not.toMatch(/\bbackupDatabase\b/)
    expect(source).not.toMatch(/\bcheckpointStore\b/)
    expect(source).not.toMatch(/\bsetStoreTransferFence\b/)
    expect(source).not.toMatch(/\blatestAppliedMigration\b/)
  })
})
