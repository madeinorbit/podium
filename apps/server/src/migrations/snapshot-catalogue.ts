/**
 * The small, cheap-to-read catalogue of recovery-snapshot verification results.
 *
 * Verifying a snapshot means opening a multi-hundred-megabyte SQLite file and
 * running `PRAGMA quick_check`. That is recovery work, not request work
 * (POD-3068): `updates.start` used to do it inline for every retained file and
 * spent ~80 seconds on the server's event loop. So the expensive answer is
 * computed once, out of process, and PUBLISHED here — a JSON file beside the
 * database that a request path can read and `stat` against in microseconds.
 *
 * Every record is keyed by the candidate's IDENTITY (size, mtime and the same
 * facts for its -wal/-shm sidecars). That is what makes a stale answer harmless:
 * a result that arrives for an identity the file no longer has is rejected
 * rather than published, and a published record whose file has since moved on
 * stops matching and is simply not used.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '@podium/logger'

const log = createLogger('server:migrations')

/**
 * Sidecars whose presence and size are part of a snapshot's identity.
 *
 * `-shm` is deliberately NOT one of them. It is SQLite's derived shared-memory
 * index, not snapshot content, and merely OPENING the snapshot read-only — which
 * is exactly what verifying it does — rewrites its mtime. Including it made
 * every verification invalidate the candidate it had just proved.
 */
export const SNAPSHOT_SIDECARS = ['-wal'] as const

/** Catalogue shape version — an older or unknown file is discarded, not guessed at. */
export const SNAPSHOT_CATALOGUE_VERSION = 1

/**
 * Everything about a candidate that can be established with `stat` alone.
 * Cheap enough for a request path; strong enough that a rewritten file cannot
 * keep wearing an older file's verdict.
 */
export interface SnapshotIdentity {
  path: string
  size: number
  mtimeMs: number
  /** Canonical `-wal`/`-shm` description; `missing` is itself part of the identity. */
  sidecars: string
}

export type SnapshotOutcome = 'pending' | 'verified' | 'invalid' | 'failed'

export interface SnapshotRecord extends SnapshotIdentity {
  outcome: SnapshotOutcome
  /** Correlates a record with the verifier run that produced it. */
  correlationId: string
  recordedAtMs: number
  /** Migration identity read out of the snapshot itself, on success. */
  schemaVersion?: string
  /** Safe, non-secret failure summary for operators. */
  diagnostic?: string
}

export interface SnapshotCatalogue {
  version: number
  records: SnapshotRecord[]
}

/** Where the catalogue for `dbPath` lives — a sibling inside the instance state dir. */
export function snapshotCataloguePath(dbPath: string): string {
  return `${dbPath}.snapshots.json`
}

/** Stat-only identity of a snapshot main file, or `undefined` when it is gone. */
export function snapshotIdentity(path: string): SnapshotIdentity | undefined {
  try {
    const stats = statSync(path)
    // Size, not mtime: a snapshot is staged after `wal_checkpoint(TRUNCATE)`, so
    // its WAL is empty by construction and any change in size is a real change
    // in content — while its mtime moves for reasons that are not content.
    const sidecars = SNAPSHOT_SIDECARS.map((suffix) => {
      const sidecar = `${path}${suffix}`
      if (!existsSync(sidecar)) return `${suffix}:missing`
      return `${suffix}:${statSync(sidecar).size}`
    }).join('|')
    return { path, size: stats.size, mtimeMs: stats.mtimeMs, sidecars }
  } catch {
    return undefined
  }
}

/** Do two identities describe the same bytes at the same place? */
export function sameSnapshotIdentity(
  a: SnapshotIdentity | undefined,
  b: SnapshotIdentity | undefined,
): boolean {
  if (!a || !b) return false
  return (
    a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs && a.sidecars === b.sidecars
  )
}

function isRecord(value: unknown): value is SnapshotRecord {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.path === 'string' &&
    typeof row.size === 'number' &&
    typeof row.mtimeMs === 'number' &&
    typeof row.sidecars === 'string' &&
    (row.outcome === 'pending' ||
      row.outcome === 'verified' ||
      row.outcome === 'invalid' ||
      row.outcome === 'failed') &&
    typeof row.correlationId === 'string' &&
    typeof row.recordedAtMs === 'number'
  )
}

/**
 * Read the catalogue. A missing, unparsable or foreign-version file is not an
 * error: it means "nothing is known yet", which is exactly the honest,
 * non-blocking answer the boot path is allowed to give.
 */
export function readSnapshotCatalogue(dbPath: string): SnapshotRecord[] {
  const path = snapshotCataloguePath(dbPath)
  try {
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return []
    const catalogue = parsed as Partial<SnapshotCatalogue>
    if (catalogue.version !== SNAPSHOT_CATALOGUE_VERSION) return []
    if (!Array.isArray(catalogue.records)) return []
    return catalogue.records.filter(isRecord)
  } catch (err) {
    log.warn('snapshot verification catalogue could not be read', { path, err })
    return []
  }
}

/**
 * Publish the catalogue atomically: a temporary sibling is written and fsynced,
 * then renamed over the real name. A reader never observes a half-written file,
 * and a crash mid-publication leaves the previous verified answer intact.
 */
export function writeSnapshotCatalogue(dbPath: string, records: readonly SnapshotRecord[]): void {
  const path = snapshotCataloguePath(dbPath)
  const temp = `${path}.partial-${randomUUID()}`
  const body: SnapshotCatalogue = { version: SNAPSHOT_CATALOGUE_VERSION, records: [...records] }
  try {
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`)
    const fd = openSync(temp, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
    const dirFd = openSync(dirname(path), 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch (err) {
    rmSync(temp, { force: true })
    log.warn('snapshot verification catalogue could not be published', { path, err })
  }
}

/**
 * Replace any record for the same path, keep the rest, newest first.
 *
 * Identity is not consulted here — a record for a REPLACED file at the same path
 * legitimately supersedes the old one. Rejecting a late result for a superseded
 * candidate is the verifier's job (it compares the identity it was launched
 * against with the identity on disk now) and happens before this is called.
 */
export function upsertSnapshotRecord(
  records: readonly SnapshotRecord[],
  record: SnapshotRecord,
): SnapshotRecord[] {
  return [record, ...records.filter((row) => row.path !== record.path)].sort(
    (a, b) => b.recordedAtMs - a.recordedAtMs || b.path.localeCompare(a.path),
  )
}

/**
 * The newest verified record whose file still matches its recorded identity.
 *
 * `identify` is injectable so a test can prove the stat-only contract; production
 * passes {@link snapshotIdentity}.
 */
export function verifiedFallback(
  records: readonly SnapshotRecord[],
  identify: (path: string) => SnapshotIdentity | undefined = snapshotIdentity,
): SnapshotRecord | undefined {
  return [...records]
    .filter((row) => row.outcome === 'verified')
    .sort((a, b) => b.recordedAtMs - a.recordedAtMs || b.path.localeCompare(a.path))
    .find((row) => sameSnapshotIdentity(row, identify(row.path)))
}

/**
 * Records worth verifying now: everything not yet decided, plus a previously
 * decided record whose file has changed underneath it. Newest first, because a
 * background pass takes at most one.
 */
export function verificationCandidates(
  records: readonly SnapshotRecord[],
  identify: (path: string) => SnapshotIdentity | undefined = snapshotIdentity,
): SnapshotRecord[] {
  return [...records]
    .sort((a, b) => b.recordedAtMs - a.recordedAtMs || b.path.localeCompare(a.path))
    .filter((row) => {
      const current = identify(row.path)
      if (!current) return false
      if (!sameSnapshotIdentity(row, current)) return true
      return row.outcome === 'pending'
    })
}

/**
 * Finite retention over the catalogue itself.
 *
 * The active verified fallback is never dropped merely because a newer target
 * was prepared: losing the record would lose the only cheap proof that a usable
 * restore point exists, which is the whole reason the catalogue is here.
 */
export function retainSnapshotRecords(
  records: readonly SnapshotRecord[],
  keep: number,
  activePath: string | undefined,
): SnapshotRecord[] {
  const ordered = [...records].sort(
    (a, b) => b.recordedAtMs - a.recordedAtMs || b.path.localeCompare(a.path),
  )
  const kept = ordered.slice(0, Math.max(0, keep))
  const active = ordered.find((row) => row.path === activePath)
  if (active && !kept.includes(active)) kept.push(active)
  return kept
}
