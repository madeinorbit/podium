/**
 * A consistent copy of the live database at an exact path, written in the
 * snapshot child process: the server transfer's portable `podium.db` (POD-6263).
 *
 * Never copy the live database or its sidecars through filesystem descriptors:
 * closing even a read-only descriptor drops the owning process's POSIX SQLite
 * locks, allowing another connection to truncate a still-mapped -shm. The child
 * opens its own read-only connection and runs `VACUUM INTO`, a consistent read
 * transaction that includes committed WAL pages. It runs in a separate process
 * so the server's event loop stays free while a large database is copied, and
 * a stuck copy can be killed.
 */
import { openDatabase } from '@podium/runtime/sqlite'
import { vacuumIntoPublished } from './backup'

export interface CopySnapshotRequest {
  kind: 'copy'
  dbPath: string
  /** Where the copy is published. Must not exist yet. */
  destination: string
  correlationId: string
}

export type CopySnapshotResult =
  | { ok: true; correlationId: string; path: string }
  | { ok: false; correlationId: string; detail: string }

/** Publish a consistent copy of the live database at `request.destination`. */
export function copySnapshotFile(request: CopySnapshotRequest): string {
  const db = openDatabase(request.dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    vacuumIntoPublished(db, request.destination)
  } finally {
    db.close()
  }
  return request.destination
}
