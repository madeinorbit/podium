/**
 * Regression for the irreversible removal of the superseded sync_feed table.
 *
 * The real migration chain and real backup/restore path are intentional here:
 * rollback for a table drop is the pre-migration backup, not a down migration.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'
import { restoreDatabase } from './restore'

const DROP_MIGRATION = 'drop-dead-sync-feed'
const PLENTY = () => Number.MAX_SAFE_INTEGER
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function hasTable(db: SqlDatabase, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  )
}

function revision(db: SqlDatabase): number {
  return (
    db.prepare("SELECT revision FROM issues WHERE id = 'iss_keep_revision'").get() as {
      revision: number
    }
  ).revision
}

describe('the dead sync_feed migration', () => {
  it('drops only the dead table and can roll back through its pre-migration backup', () => {
    const cut = DRIZZLE_MIGRATIONS.findIndex((migration) => migration.name.includes(DROP_MIGRATION))
    expect(cut).toBeGreaterThan(0)
    const migration = DRIZZLE_MIGRATIONS[cut]
    if (!migration) throw new Error('drop migration is missing')

    const dir = mkdtempSync(join(tmpdir(), 'podium-drop-sync-feed-'))
    dirs.push(dir)
    const dbPath = join(dir, 'podium.sqlite')
    const db = openDatabase(dbPath)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))

    db.prepare('INSERT INTO sync_feed (id, feed_id, epoch) VALUES (1, ?, ?)').run(
      'dead-feed',
      'dead-epoch',
    )
    db.prepare(
      'INSERT INTO feed_identity (singleton, feed_id, epoch, minted_at) VALUES (1, ?, ?, ?)',
    ).run('live-feed', 'live-epoch', 1)
    db.prepare(
      'INSERT INTO issues (id, repo_path, seq, title, stage, default_agent, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('iss_keep_revision', '/repo', 1, 'Keep revision', 'backlog', 'codex', 9, 't', 't')

    expect(hasTable(db, 'sync_feed')).toBe(true)
    expect(revision(db)).toBe(9)

    expect(runDrizzleMigrations(db, DRIZZLE_MIGRATIONS, { dbPath })).toEqual([migration.name])
    expect(hasTable(db, 'sync_feed')).toBe(false)
    expect(hasTable(db, 'feed_identity')).toBe(true)
    expect(revision(db)).toBe(9)
    db.close()

    const backups = readdirSync(dir).filter(
      (name) =>
        name.startsWith('podium.sqlite.backup-v') &&
        !name.endsWith('-wal') &&
        !name.endsWith('-shm'),
    )
    expect(backups).toHaveLength(1)
    const backupPath = join(dir, backups[0] ?? '')
    const restored = restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })

    const reopened = openDatabase(dbPath)
    expect(reopened.prepare('SELECT feed_id, epoch FROM sync_feed').get()).toEqual({
      feed_id: 'dead-feed',
      epoch: 'dead-epoch',
    })
    expect(revision(reopened)).toBe(9)
    expect(restored.feedId).toBe('live-feed')
    expect(restored.previousEpoch).toBe('live-epoch')
    expect(restored.epoch).not.toBe('live-epoch')

    expect(runDrizzleMigrations(reopened, DRIZZLE_MIGRATIONS)).toEqual([migration.name])
    expect(hasTable(reopened, 'sync_feed')).toBe(false)
    expect(hasTable(reopened, 'feed_identity')).toBe(true)
    expect(revision(reopened)).toBe(9)
    reopened.close()
  })
})
