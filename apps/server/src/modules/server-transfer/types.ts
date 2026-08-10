import { SERVER_TRANSFER_FORMAT_VERSION } from '@podium/protocol'
import type {
  ServerTransferManifest as ProtocolServerTransferManifest,
  ServerTransferManifestEntry as ProtocolServerTransferManifestEntry,
  ServerTransferProof,
  ServerTransferServingProof,
} from '@podium/protocol'

export { SERVER_TRANSFER_FORMAT_VERSION }
export const SERVER_TRANSFER_CONFIRMATION = 'TRANSFER SERVER' as const

export type TransferJournalState =
  | 'preparing'
  | 'staged'
  | 'validated'
  | 'source-fenced'
  | 'committing'
  | 'committed'
  | 'aborted'
  | 'commit-uncertain'

export type ServerTransferOutcomeState = 'aborted' | 'committed' | 'commit-uncertain'
export type ServerTransferPhase =
  | 'preparing'
  | 'copying'
  | 'validating'
  | 'switching'
  | 'connected'
  | 'aborted'
  | 'commit-uncertain'

export type ServerTransferManifestEntry = ProtocolServerTransferManifestEntry
export type ServerTransferManifestBody = ProtocolServerTransferManifest
export type ServerTransferManifest = ProtocolServerTransferManifest & { digest: string }

export interface TransferRecord {
  operationId: string
  phase: ServerTransferPhase
  bytesCopied: number
  totalBytes: number
  transferId: string
  targetMachineId: string
  publicUrl: string
  port?: number
  sourceMachineId: string
  sourceInstanceId: string
  packageDir: string
  manifest: ServerTransferManifest | null
  idempotencyKey: string
  targetProof: boolean
  sourceConnected: boolean
  probe?: { transferId: string; manifestDigest: string }
}

export interface TransferJournalEntry {
  formatVersion: typeof SERVER_TRANSFER_FORMAT_VERSION
  state: TransferJournalState
  record: TransferRecord
  error?: { code: string; message: string }
  cleanup?: { result: 'cleaned' | 'pending'; detail?: string }
  createdAt: string
  updatedAt: string
}

export interface ServerTransferInput {
  targetMachineId: string
  publicUrl: string
  port?: number
  confirmation: typeof SERVER_TRANSFER_CONFIRMATION
}

export type ServerTransferApplyPhase = 'prepare' | 'stage' | 'validate' | 'fence' | 'commit'

export interface ServerTransferAuthorization {
  reauthorize(phase: ServerTransferApplyPhase): void | Promise<void>
}

export interface ServerTransferOutcome {
  ok: boolean
  transferId: string
  state: ServerTransferOutcomeState
  targetMachineId: string
  publicUrl: string
  error?: { code: string; message: string }
  cleanup?: { result: 'cleaned' | 'pending'; detail?: string }
}

export type TransferProof = ServerTransferProof
export type TargetHealthProof = ServerTransferServingProof

/** Safe projection of target-owned durable promotion metadata. */
export interface PromotedTargetMetadata {
  transferId: string
  sourceMachineId: string
  targetMachineId: string
  publicUrl: string
  manifestDigest: string
  state: 'promoted'
  proof: TargetHealthProof
}

export interface ServerTransferFailure {
  code: string
  detail: string
}

export type ServerTransferRpcResult<T> =
  | ({ ok: true } & T)
  | { ok: false; state: string; error: ServerTransferFailure }

/** Dedicated machine-scoped port. POD-1748 owns its protocol implementation. */
export interface ServerTransferRpc {
  serverTransferPrepare(
    input: {
      transferId: string
      sourceMachineId: string
      manifest: ServerTransferManifest
      packageLimits: { totalBytes: number; maxChunkBytes: number }
    },
    targetMachineId: string,
  ): Promise<
    ServerTransferRpcResult<{
      state: 'prepared'
      manifestDigest: string
      targetMachineId: string
      targetCapability: 'server-only'
      buildVersion: string
      wireSchemaDigest: string
      space: { availableBytes: number; requiredBytes: number; sufficient: boolean }
    }>
  >
  serverTransferChunk(
    input: {
      transferId: string
      manifestDigest: string
      fileIndex: number
      offset: number
      expectedLength: number
      data: Buffer
    },
    targetMachineId: string,
  ): Promise<
    ServerTransferRpcResult<{
      state: 'staging'
      manifestDigest: string
      path: string
      offset: number
      receivedBytes: number
    }>
  >
  serverTransferValidate(
    input: { transferId: string; manifestDigest: string },
    targetMachineId: string,
  ): Promise<ServerTransferRpcResult<{ state: 'validated'; proof: TransferProof }>>
  serverTransferPromote(
    input: {
      transferId: string
      manifestDigest: string
      publicUrl: string
      port?: number
      targetMode: 'server'
      idempotencyKey: string
    },
    targetMachineId: string,
  ): Promise<
    ServerTransferRpcResult<{
      state: 'prepared' | 'promoted' | 'uncertain'
      proof?: TargetHealthProof
    }>
  >
  serverTransferAcknowledge(
    input: { transferId: string; manifestDigest: string },
    targetMachineId: string,
  ): Promise<
    ServerTransferRpcResult<{
      state: 'promoted'
      transferId: string
      manifestDigest: string
      acknowledged: true
    }>
  >
  serverTransferAbort(
    input: { transferId: string; manifestDigest: string; reason: string },
    targetMachineId: string,
  ): Promise<
    ServerTransferRpcResult<{
      state: 'aborted'
      transferId: string
      manifestDigest: string
      cleanup: 'cleaned' | 'pending'
    }>
  >
  serverTransferStatus(
    input: { transferId: string; manifestDigest: string },
    targetMachineId: string,
  ): Promise<
    ServerTransferRpcResult<{
      state: 'idle' | 'prepared' | 'staging' | 'validated' | 'promoted' | 'aborted' | 'uncertain'
      transferId?: string
      manifestDigest?: string
      proof?: TargetHealthProof
      sourceConnected: boolean
    }>
  >
}

export const TRANSFER_FAILURE_CODES = {
  ACTIVE_TRANSFER: 'active-transfer',
  INVALID_CONFIRMATION: 'invalid-confirmation',
  INVALID_URL: 'invalid-url',
  TARGET_NOT_FOUND: 'target-not-found',
  TARGET_IS_SOURCE: 'target-is-source',
  TARGET_OFFLINE: 'target-offline',
  TARGET_UNSUPPORTED: 'target-unsupported',
  SOURCE_UNHEALTHY: 'source-unhealthy',
  DISK_FULL: 'disk-full',
  SNAPSHOT_FAILED: 'snapshot-failed',
  SOURCE_CHANGED: 'source-changed',
  REAUTHORIZED_DENIED: 'reauthorization-denied',
  TARGET_REJECTED: 'target-rejected',
  TARGET_PROOF_MISSING: 'target-proof-missing',
  SOURCE_CONFIG_FAILED: 'source-config-failed',
  COMMIT_UNCERTAIN: 'commit-uncertain',
  INTERNAL: 'internal',
} as const

export type TransferFailureCode =
  (typeof TRANSFER_FAILURE_CODES)[keyof typeof TRANSFER_FAILURE_CODES]
