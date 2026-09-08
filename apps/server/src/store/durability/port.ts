/**
 * Durability port [POD-3270, spec §3.7].
 *
 * Self-hosted bun:sqlite owns backup, snapshot, `wal_checkpoint` and the
 * in-process transfer fence as file operations on the live handle. Turso's
 * platform owns backup, replication and point-in-time restore, so that backend
 * reports those as platform-managed and rejects a transfer fence or a candidate
 * file as not applicable. A transfer between hosted machines is a change of
 * connection string, not a file copy.
 *
 * Callers branch on {@link DurabilityCapabilities}, never on a driver name.
 * Live-handle file operations run through the scheduler's exclusive lane;
 * snapshot proof of a retained copy does not (spec §6 rule 67).
 */

import type { SnapshotVerification } from '../../migrations/snapshot-verifier'

export type SnapshotCapability = 'file' | 'platform-managed'
export type CheckpointCapability = 'file' | 'not-applicable'
export type TransferFenceCapability = 'in-process' | 'not-applicable'
export type CandidateCapability = 'file' | 'not-applicable'

export interface DurabilityCapabilities {
  readonly backup: SnapshotCapability
  readonly snapshot: SnapshotCapability
  readonly checkpoint: CheckpointCapability
  readonly transferFence: TransferFenceCapability
  readonly candidateValidation: CandidateCapability
}

export const FILE_DURABILITY_CAPABILITIES: DurabilityCapabilities = {
  backup: 'file',
  snapshot: 'file',
  checkpoint: 'file',
  transferFence: 'in-process',
  candidateValidation: 'file',
}

export const PLATFORM_DURABILITY_CAPABILITIES: DurabilityCapabilities = {
  backup: 'platform-managed',
  snapshot: 'platform-managed',
  checkpoint: 'not-applicable',
  transferFence: 'not-applicable',
  candidateValidation: 'not-applicable',
}

export type DurabilityFailureCode =
  | 'not-applicable'
  | 'candidate-invalid'
  | 'identity-mismatch'
  | 'unavailable'

export class DurabilityError extends Error {
  constructor(
    readonly code: DurabilityFailureCode,
    message: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** Transfer fence, checkpoint, or candidate-file validation on a backend that has none. */
export class DurabilityNotApplicableError extends DurabilityError {
  constructor(operation: string) {
    super('not-applicable', `${operation} is not applicable on this backend`)
  }
}

export interface FeedIdentity {
  readonly feedId: string
  readonly epoch: string
}

/**
 * Queries the Turso backend uses for the update flow's proofs. Ordinary
 * statements, not file opens: the platform has no candidate file to inspect.
 */
export interface DurabilityIdentityQueries {
  latestMigrationName(): Promise<string | undefined>
  feedIdentity(): Promise<FeedIdentity | undefined>
}

export interface CandidateValidationRequest {
  readonly databasePath: string
  readonly targetMachineId: string
  readonly expectedFeedId: string
  readonly expectedFeedEpoch: string
  readonly expectedSchemaVersion: string
}

export interface CandidateValidationProof {
  readonly feedId: string
  readonly feedEpoch: string
  readonly schemaVersion: string
}

export interface DurabilityPort {
  readonly capabilities: DurabilityCapabilities

  schemaVersion(): Promise<string>
  feedIdentity(): Promise<FeedIdentity>

  checkpoint(): Promise<void>

  snapshot(fromVersion: string, targetVersion: string): Promise<string | undefined>
  verifiedSnapshot(fromVersion: string, targetVersion: string): Promise<SnapshotVerification>
  latestSnapshot(): string | undefined
  discoverSnapshots(): boolean

  beginTransferFence(): Promise<void>
  endTransferFence(): Promise<void>
  readonly transferFenceActive: boolean

  validateCandidate(request: CandidateValidationRequest): Promise<CandidateValidationProof>

  /** Abort a detached snapshot proof so it cannot outlive the database (rule 67). */
  close(): Promise<void>
}
