import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { exclusiveLockFromAnotherProcess } from '../test-support/sqlite-locks'
import { copySnapshotFile } from './snapshot-copy'

describe('the transfer copy of the live database [POD-6263]', () => {
  it('holds committed WAL rows and leaves no sidecars or partial files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod6263-copy-wal-'))
    const path = join(dir, 'podium.db')
    const db = openDatabase(path)
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO t VALUES (1, 'committed in WAL')",
      )
      const copy = copySnapshotFile({
        kind: 'copy',
        dbPath: path,
        destination: join(dir, 'copy.db'),
        correlationId: 'wal',
      })
      const read = openDatabase(copy, { readOnly: true })
      try {
        expect(read.prepare('SELECT * FROM t').all()).toEqual([
          { id: 1, value: 'committed in WAL' },
        ])
      } finally {
        read.close()
      }
      expect(readdirSync(dir).filter((name) => name.startsWith('copy.db'))).toEqual(['copy.db'])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copies an unchanged database byte for byte, so a transfer can reuse its staged package', () => {
    // The server transfer compares its fenced final snapshot with the writable
    // initial one and re-stages only when the digests differ. A copy must
    // therefore depend on the database's content alone.
    const dir = mkdtempSync(join(tmpdir(), 'pod6263-copy-'))
    const path = join(dir, 'podium.db')
    const db = openDatabase(path)
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO t VALUES (1, 'one'), (2, 'two')",
      )
      const digest = (file: string): string =>
        createHash('sha256').update(readFileSync(file)).digest('hex')
      const first = copySnapshotFile({
        kind: 'copy',
        dbPath: path,
        destination: join(dir, 'first.db'),
        correlationId: 'first',
      })
      const second = copySnapshotFile({
        kind: 'copy',
        dbPath: path,
        destination: join(dir, 'second.db'),
        correlationId: 'second',
      })
      expect(digest(second)).toBe(digest(first))
      // A second SQLite connection in this process left the live one's locks alone.
      expect(exclusiveLockFromAnotherProcess(path)).toBe('refused')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
