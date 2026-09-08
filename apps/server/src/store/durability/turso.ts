/**
 * Turso durability [POD-3270]. The platform owns backup, replication and
 * point-in-time restore, so backup and snapshot report platform-managed. A
 * transfer fence and a candidate file do not exist: moving a hosted tenant is a
 * connection-string change. Migration head and feed identity are ordinary
 * queries so the update flow's proofs still work.
 */

import type { SnapshotVerification } from '../../migrations/snapshot-verifier'
import {
  DurabilityError,
  DurabilityNotApplicableError,
  type DurabilityIdentityQueries,
  type DurabilityPort,
  type FeedIdentity,
  PLATFORM_DURABILITY_CAPABILITIES,
  type CandidateValidationProof,
  type CandidateValidationRequest,
} from './port'

export function createTursoDurability(queries: DurabilityIdentityQueries): DurabilityPort {
  return new TursoDurability(queries)
}

class TursoDurability implements DurabilityPort {
  readonly capabilities = PLATFORM_DURABILITY_CAPABILITIES

  constructor(private readonly queries: DurabilityIdentityQueries) {}

  async schemaVersion(): Promise<string> {
    const name = await this.queries.latestMigrationName()
    if (name === undefined) throw new Error('database migration identity is unavailable')
    return name
  }

  async feedIdentity(): Promise<FeedIdentity> {
    const identity = await this.queries.feedIdentity()
    if (!identity) throw new DurabilityError('unavailable', 'database has no feed identity')
    return identity
  }

  async checkpoint(): Promise<void> {
    throw new DurabilityNotApplicableError('checkpoint')
  }

  async snapshot(_fromVersion: string, _targetVersion: string): Promise<string | undefined> {
    return undefined
  }

  async verifiedSnapshot(
    _fromVersion: string,
    _targetVersion: string,
  ): Promise<SnapshotVerification> {
    return {
      ok: false,
      code: 'platform-managed',
      detail: 'backup and snapshot are owned by the platform',
      durationMs: 0,
    }
  }

  latestSnapshot(): string | undefined {
    return undefined
  }

  discoverSnapshots(): boolean {
    return false
  }

  get transferFenceActive(): boolean {
    return false
  }

  async beginTransferFence(): Promise<void> {
    throw new DurabilityNotApplicableError('transfer fence')
  }

  async endTransferFence(): Promise<void> {
    throw new DurabilityNotApplicableError('transfer fence')
  }

  async validateCandidate(_request: CandidateValidationRequest): Promise<CandidateValidationProof> {
    throw new DurabilityNotApplicableError('candidate-file validation')
  }

  async close(): Promise<void> {}
}
