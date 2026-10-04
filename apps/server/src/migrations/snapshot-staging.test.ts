import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { stageSnapshotFile } from './snapshot-staging'

describe('SQLite-consistent snapshot staging [POD-5290]', () => {
  it('includes committed WAL rows without checkpointing or copying live sidecars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod5290-staging-'))
    const path = join(dir, 'live.db')
    const db = openDatabase(path)
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO t VALUES (1, 'committed in WAL')",
      )
      const snapshot = stageSnapshotFile({
        kind: 'stage',
        dbPath: path,
        label: 'update-test',
        correlationId: 'stage',
      })!
      const copy = openDatabase(snapshot, { readOnly: true })
      try {
        expect(copy.prepare('SELECT * FROM t').all()).toEqual([
          { id: 1, value: 'committed in WAL' },
        ])
      } finally {
        copy.close()
      }
      expect(existsSync(`${snapshot}-wal`)).toBe(false)
      expect(existsSync(`${snapshot}-shm`)).toBe(false)
      expect(readdirSync(dir).some((name) => name.includes('.partial-'))).toBe(false)
      db.exec("INSERT INTO t VALUES (2, 'after snapshot')")
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2 })
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses insufficient disk before creating any candidate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod5290-preflight-'))
    const path = join(dir, 'live.db')
    const db = openDatabase(path)
    try {
      db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)')
      expect(() =>
        stageSnapshotFile(
          { kind: 'stage', dbPath: path, label: 'update-test', correlationId: 'stage' },
          () => 0,
        ),
      ).toThrow('Free disk space and retry the update')
      expect(readdirSync(dir).some((name) => name.includes('.backup-v'))).toBe(false)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
