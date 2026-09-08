import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from './sqlite'
import { SqliteCandidateError, validateSqliteCandidate } from './sqlite-candidate'

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function candidateDb(over: {
  machineId?: string
  feedId?: string
  epoch?: string
  schema?: string
} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'pod3272-candidate-'))
  tmpDirs.push(dir)
  const path = join(dir, 'podium.db')
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

describe('validateSqliteCandidate', () => {
  it('returns feed identity and schema when the candidate matches', () => {
    expect(validateSqliteCandidate({ databasePath: candidateDb(), ...MATCHING })).toEqual({
      feedId: 'feed-1',
      feedEpoch: 'epoch-1',
      schemaVersion: 'schema-1',
    })
  })

  it('refuses an identity mismatch rather than returning a success-shaped result', () => {
    expect(() =>
      validateSqliteCandidate({
        databasePath: candidateDb({ feedId: 'other-feed' }),
        ...MATCHING,
      }),
    ).toThrow(SqliteCandidateError)
  })
})
