/** SQLite-consistent update snapshots. Called only in the snapshot child process. */
import { fsyncPath } from '@podium/runtime/fsync'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '@podium/logger'
import { openDatabase } from '@podium/runtime/sqlite'
import { freeDiskBytes, pruneBackups } from './backup'

const log = createLogger('server:snapshot-staging')

export interface StageSnapshotRequest {
  kind: 'stage'
  dbPath: string
  label: string
  activeFallback?: string
  correlationId: string
}

export type StageSnapshotResult =
  | { ok: true; correlationId: string; path?: string }
  | { ok: false; correlationId: string; detail: string }

/**
 * VACUUM INTO owns a consistent SQLite read transaction, including committed
 * WAL pages. Never copy the live database or its sidecars through filesystem
 * descriptors: closing even a read-only descriptor drops this process's POSIX
 * SQLite locks, allowing another connection to truncate a still-mapped -shm.
 * A thread would share those locks too; staging belongs in a separate process.
 */
export function stageSnapshotFile(
  request: StageSnapshotRequest,
  freeBytes: (dir: string) => number = freeDiskBytes,
): string | undefined {
  const { dbPath } = request
  if (!existsSync(dbPath)) return undefined
  const dir = dirname(dbPath)
  const needed =
    statSync(dbPath).size + (existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0)
  const required = Math.ceil(needed * 1.1)
  const available = freeBytes(dir)
  if (available < required) {
    throw new Error(
      `Not enough disk space for the update database snapshot in ${dir}: ` +
        `need ~${required} bytes, only ${available} bytes free. Free disk space and retry the update.`,
    )
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = `${dbPath}.backup-v${request.label}-${stamp}`
  const partial = `${path}.partial-${randomUUID()}`
  try {
    const db = openDatabase(dbPath, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.prepare('VACUUM INTO ?').run(partial)
    } finally {
      db.close()
    }
    fsyncPath(partial)
    renameSync(partial, path)
    fsyncPath(dir)
  } catch (error) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(`${partial}${suffix}`, { force: true })
      rmSync(`${path}${suffix}`, { force: true })
    }
    throw error
  }
  try {
    pruneBackups(dbPath, request.activeFallback)
  } catch (error) {
    log.warn('database snapshot retention could not be applied', { path: dbPath, err: error })
  }
  return path
}
