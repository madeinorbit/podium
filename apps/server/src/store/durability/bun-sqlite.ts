/**
 * bun:sqlite durability [POD-3270]. The current file-level behaviour, moved
 * behind the port and unchanged: backup copies the database plus -wal/-shm,
 * snapshot proof runs in a child, `wal_checkpoint` and the transfer fence take
 * exclusive, candidate validation opens a different file.
 */

import { randomUUID } from 'node:crypto'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { backupDatabase } from '../../migrations/backup'
import { latestAppliedMigration } from '../../migrations/index'
import {
  type SnapshotVerification,
  SnapshotVerifier,
  type SnapshotVerifierDeps,
} from '../../migrations/snapshot-verifier'
import { checkpointStore, setStoreTransferFence } from '../../migrations/store-lifecycle'
import type { QueryClient, RootStoreExecutor } from '../executor'
import {
  type CandidateValidationProof,
  type CandidateValidationRequest,
  DurabilityError,
  type DurabilityPort,
  FILE_DURABILITY_CAPABILITIES,
  type FeedIdentity,
} from './port'

export interface BunSqliteDurabilityOptions {
  database: SqlDatabase
  path: string
  executor: RootStoreExecutor<QueryClient>
  snapshotVerifierDeps?: SnapshotVerifierDeps
}

export function createBunSqliteDurability(options: BunSqliteDurabilityOptions): DurabilityPort {
  return new BunSqliteDurability(options)
}

class BunSqliteDurability implements DurabilityPort {
  readonly capabilities = FILE_DURABILITY_CAPABILITIES
  private transferFenceHeld = false
  private readonly snapshotVerifier: SnapshotVerifier

  constructor(private readonly options: BunSqliteDurabilityOptions) {
    this.snapshotVerifier = new SnapshotVerifier(options.path, options.snapshotVerifierDeps ?? {})
  }

  private get database(): SqlDatabase {
    return this.options.database
  }

  private get path(): string {
    return this.options.path
  }

  private get executor(): RootStoreExecutor<QueryClient> {
    return this.options.executor
  }

  async schemaVersion(): Promise<string> {
    return await this.executor.exclusive(async () => {
      const name = latestAppliedMigration(this.database)
      if (name === undefined) throw new Error('database migration identity is unavailable')
      return name
    })
  }

  async feedIdentity(): Promise<FeedIdentity> {
    return await this.executor.exclusive(async () => readLiveFeedIdentity(this.database))
  }

  async checkpoint(): Promise<void> {
    await this.executor.exclusive(async (session) => {
      await checkpointStore(session)
    })
  }

  async snapshot(fromVersion: string, targetVersion: string): Promise<string | undefined> {
    return await this.executor.exclusive(async () =>
      this.stageUpdateSnapshot(fromVersion, targetVersion),
    )
  }

  private stageUpdateSnapshot(fromVersion: string, targetVersion: string): string | undefined {
    if (this.path === ':memory:') return undefined
    const safe = (version: string): string => version.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
    const snapshot = backupDatabase(
      this.database,
      this.path,
      `update-${safe(fromVersion)}-to-${safe(targetVersion)}`,
      undefined,
      undefined,
      () => this.snapshotVerifier.verifiedFallbackPath(),
    )
    // Staged, not proved. The record is published before anything can await the
    // proof so a crash in between is legible as "staged and never verified".
    if (snapshot) this.snapshotVerifier.recordStaged(snapshot, randomUUID())
    return snapshot
  }

  async verifiedSnapshot(fromVersion: string, targetVersion: string): Promise<SnapshotVerification> {
    const staged = await this.snapshot(fromVersion, targetVersion)
    if (!staged) {
      return {
        ok: false,
        code: 'no-snapshotable-file',
        detail: 'the database has no snapshotable file',
        durationMs: 0,
      }
    }
    let expectedSchemaVersion: string | undefined
    try {
      expectedSchemaVersion = await this.schemaVersion()
    } catch {
      // A store with no migration identity still gets a quick_check proof; the
      // schema comparison is the part that is skipped, not the verification.
    }
    return await this.snapshotVerifier.verify(staged, expectedSchemaVersion)
  }

  latestSnapshot(): string | undefined {
    if (this.path === ':memory:') return undefined
    return this.snapshotVerifier.verifiedFallbackPath()
  }

  discoverSnapshots(): boolean {
    if (this.path === ':memory:') return false
    return this.snapshotVerifier.discoverAndQueue()
  }

  get transferFenceActive(): boolean {
    return this.transferFenceHeld
  }

  async beginTransferFence(): Promise<void> {
    await this.executor.exclusive(async (session) => {
      if (this.transferFenceHeld) throw new Error('transfer fence is already held')
      await setStoreTransferFence(session, true)
      this.transferFenceHeld = true
    })
  }

  async endTransferFence(): Promise<void> {
    await this.executor.exclusive(async (session) => {
      if (!this.transferFenceHeld) return
      await setStoreTransferFence(session, false)
      this.transferFenceHeld = false
    })
  }

  async validateCandidate(request: CandidateValidationRequest): Promise<CandidateValidationProof> {
    // A different file, not the live handle — exclusive would only block readers.
    return validateSqliteCandidate(request)
  }

  close(): Promise<void> {
    return this.snapshotVerifier.close()
  }
}

function readLiveFeedIdentity(database: SqlDatabase): FeedIdentity {
  const row = database
    .prepare('SELECT feed_id, epoch FROM feed_identity WHERE singleton = 1')
    .get() as { feed_id?: string; epoch?: string } | undefined
  if (!row?.feed_id || !row.epoch) {
    throw new DurabilityError('unavailable', 'database has no feed identity')
  }
  return { feedId: row.feed_id, epoch: row.epoch }
}

/**
 * The database half of daemon candidate-file validation, moved here so both
 * the live store and (at E.5) the daemon go through the port. Enrollment
 * ledger checks stay with the daemon: they are not a database file.
 */
export function validateSqliteCandidate(
  request: CandidateValidationRequest,
): CandidateValidationProof {
  let db: SqlDatabase | undefined
  try {
    db = openDatabase(request.databasePath, { readOnly: true })
    const integrity = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined
    if (integrity?.integrity_check !== 'ok') {
      throw new DurabilityError('candidate-invalid', 'candidate database failed integrity_check')
    }
    const target = db.prepare('SELECT id FROM machines WHERE id = ?').get(request.targetMachineId)
    if (!target) {
      throw new DurabilityError(
        'identity-mismatch',
        'target machine is absent from the candidate database',
      )
    }
    const feed = db.prepare('SELECT feed_id, epoch FROM feed_identity WHERE singleton = 1').get() as
      | { feed_id?: string; epoch?: string }
      | undefined
    if (!feed?.feed_id || !feed.epoch) {
      throw new DurabilityError('candidate-invalid', 'candidate database has no feed identity')
    }
    const schema = db
      .prepare('SELECT name FROM __drizzle_migrations ORDER BY name DESC LIMIT 1')
      .get() as { name?: string } | undefined
    if (!schema?.name) {
      throw new DurabilityError('candidate-invalid', 'candidate database has no schema ledger')
    }
    if (feed.feed_id !== request.expectedFeedId || feed.epoch !== request.expectedFeedEpoch) {
      throw new DurabilityError(
        'identity-mismatch',
        'candidate feed identity does not match transfer manifest',
      )
    }
    if (schema.name !== request.expectedSchemaVersion) {
      throw new DurabilityError(
        'candidate-invalid',
        'candidate schema does not match transfer manifest',
      )
    }
    return {
      feedId: feed.feed_id,
      feedEpoch: feed.epoch,
      schemaVersion: schema.name,
    }
  } catch (error) {
    if (error instanceof DurabilityError) throw error
    throw new DurabilityError('candidate-invalid', 'candidate database schema is not supported')
  } finally {
    db?.close()
  }
}
