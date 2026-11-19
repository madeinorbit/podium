import type { MachineId } from '@podium/model'
import type {
  ServerTransferManifest as ProtocolServerTransferManifest,
  ServerTransferManifestEntry as ProtocolServerTransferManifestEntry,
  ServerBindHost,
  ServerTransferProof,
  ServerTransferServingProof,
} from '@podium/protocol'
import { SERVER_TRANSFER_FORMAT_VERSION } from '@podium/protocol'

export { SERVER_TRANSFER_FORMAT_VERSION }
export const SERVER_TRANSFER_CONFIRMATION = 'TRANSFER SERVER' as const

export type TransferJournalState =
  | 'preparing'
  | 'staged'
  | 'validated'
  | 'fence-pending'
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
  targetMachineId: MachineId
  publicUrl: string
  bindHost: ServerBindHost
  port: number
  sourceMachineId: MachineId
  sourceInstanceId: string
  packageDir: string
  manifest: ServerTransferManifest | null
  idempotencyKey: string
  targetProof: boolean
  sourceConnected: boolean
  reachabilityToken?: string
  quiescedMachineIds?: MachineId[]
  endpointCommittedMachineIds?: MachineId[]
  offlineMachineIds?: MachineId[]
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
  targetMachineId: MachineId
  publicUrl: string
  bindHost: ServerBindHost
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
  targetMachineId: MachineId
  publicUrl: string
  error?: { code: string; message: string }
  cleanup?: { result: 'cleaned' | 'pending'; detail?: string }
}

export type TransferProof = ServerTransferProof
export type TargetHealthProof = ServerTransferServingProof

/** Safe projection of target-owned durable promotion metadata. */
export interface PromotedTargetMetadata {
  operationId: string
  transferId: string
  sourceMachineId: MachineId
  targetMachineId: MachineId
  publicUrl: string
  bindHost: ServerBindHost
  manifestDigest: string
  port: number
  state: 'promoted'
  proof: TargetHealthProof
}

/** Strict target-owned marker for the health-only boot window. */
export interface PromotingTargetMetadata {
  operationId: string
  transferId: string
  sourceMachineId: MachineId
  targetMachineId: MachineId
  publicUrl: string
  bindHost: ServerBindHost
  manifestDigest: string
  port: number
  state: 'promoting'
  proof: TransferProof
}

export interface ServerTransferFailure {
  code: string
  detail: string
}

export type ServerTransferRpcResult<T> =
  | ({ ok: true } & T)
  | { ok: false; state: string; error: ServerTransferFailure }

/**
 * A promote refusal can carry the target's check value for the key it was given:
 * a target that refused while still `validated` changed nothing, so the source may
 * abort cleanly (epic Task 22).
 */
export type ServerTransferPromoteRefusal = {
  ok: false
  state: string
  error: ServerTransferFailure
  vaultCheck?: string
  /**
   * The promote frame was refused at the send and never queued: no daemon link,
   * or none safe for the vault key, was live when it was to go out. The target
   * saw nothing, so the commit never began.
   */
  notSent?: true
}

/**
 * The source vault, as far as a transfer needs it; the store's `Vault` satisfies
 * it (credential management design §7, "Moving the server").
 */
export interface TransferVault {
  state(): 'ready' | 'empty' | 'locked'
  status(): { keyPath: string }
  /** The data key; null when the vault has none it can open. The caller wipes it. */
  exportDataKey(): Buffer | null
}

/** Dedicated machine-scoped port. POD-1748 owns its protocol implementation. */
export interface ServerTransferRpc {
  serverTransferPrepare(
    input: {
      transferId: string
      sourceMachineId: MachineId
      manifest: ServerTransferManifest
      publicUrl: string
      bindHost: ServerBindHost
      port: number
      reachabilityToken: string
      packageLimits: { totalBytes: number; maxChunkBytes: number }
    },
    targetMachineId: MachineId,
  ): Promise<
    ServerTransferRpcResult<{
      state: 'prepared'
      manifestDigest: string
      targetMachineId: MachineId
      targetCapability: 'server-only'
      buildVersion: string
      wireSchemaDigest: string
      receivedBytes: number
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
    targetMachineId: MachineId,
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
    targetMachineId: MachineId,
  ): Promise<ServerTransferRpcResult<{ state: 'validated'; proof: TransferProof }>>
  serverTransferPromote(
    input: {
      transferId: string
      manifestDigest: string
      publicUrl: string
      bindHost: ServerBindHost
      port: number
      targetMode: 'server'
      idempotencyKey: string
      /** SECRET: the vault's data key, base64; null when the vault has none to hand over. */
      vaultDataKey?: string | null
      /** `vaultCheckValue(dataKey, transferId)`; present exactly when a key is sent. */
      vaultCheck?: string
    },
    targetMachineId: MachineId,
  ): Promise<
    | {
        ok: true
        state: 'prepared' | 'promoted' | 'uncertain'
        proof?: TargetHealthProof
        vaultCheck?: string
      }
    | ServerTransferPromoteRefusal
  >
  serverTransferAcknowledge(
    input: { transferId: string; manifestDigest: string },
    targetMachineId: MachineId,
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
    targetMachineId: MachineId,
  ): Promise<
    ServerTransferRpcResult<{
      state: 'aborted'
      transferId: string
      manifestDigest: string
      cleanup: 'cleaned' | 'pending'
    }>
  >
  inspectServerTransfer(
    input: { transferId: string; manifestDigest: string },
    targetMachineId: MachineId,
  ): Promise<
    ServerTransferRpcResult<{
      state: 'idle' | 'prepared' | 'staging' | 'validated' | 'promoted' | 'aborted' | 'uncertain'
      transferId?: string
      manifestDigest?: string
      proof?: TargetHealthProof
      publicUrl?: string
      port?: number
      sourceConnected: boolean
      /** The check value of the data key a promoted target stored. */
      vaultCheck?: string
    }>
  >
}

export interface ServerEndpointHandoff {
  registeredMachineIds(): Promise<MachineId[]>
  onlineMachineIds(): MachineId[]
  probeCandidate(input: {
    transferId: string
    manifestDigest: string
    publicUrl: string
    reachabilityToken: string
    targetMachineId: MachineId
  }): Promise<void>
  probeMachine(
    input: {
      transferId: string
      manifestDigest: string
      publicUrl: string
      reachabilityToken: string
      targetMachineId: MachineId
    },
    machineId: MachineId,
  ): Promise<{ ok: boolean; error?: string }>
  commitMachine(
    input: {
      transferId: string
      publicUrl: string
      targetMachineId: MachineId
    },
    machineId: MachineId,
  ): Promise<{ ok: boolean; error?: string }>
  resumeMachine(transferId: string, machineId: MachineId): Promise<{ ok: boolean; error?: string }>
  /** Mint short-lived browser claims while their hashes can still enter the final snapshot. */
  prepareClientRelocations(operationId: string): Promise<void>
  cancelClientRelocations(operationId: string): Promise<void>
  relocateClients(input: { transferId: string; publicUrl: string; operationId: string }): void
}

export const TRANSFER_FAILURE_CODES = {
  ACTIVE_TRANSFER: 'active-transfer',
  INVALID_CONFIRMATION: 'invalid-confirmation',
  INVALID_URL: 'invalid-url',
  TARGET_NOT_FOUND: 'target-not-found',
  TARGET_IS_SOURCE: 'target-is-source',
  TARGET_OFFLINE: 'target-offline',
  /** POD-2700: the target runs no Podium daemon, so promotion has nothing to
   *  drive. Distinct from `TARGET_OFFLINE` because waiting cannot fix it. */
  TARGET_NO_DAEMON: 'target-no-daemon',
  TARGET_UNSUPPORTED: 'target-unsupported',
  /** The target's daemon link is `plain`: the server, its database and the vault key do
   *  not cross it (credential management design §8). */
  TARGET_LINK_NOT_ENCRYPTED: 'target-link-not-encrypted',
  /** The target refused the vault data key before promoting: its check value differs. */
  VAULT_CHECK_FAILED: 'vault-check-failed',
  SOURCE_UNHEALTHY: 'source-unhealthy',
  DISK_FULL: 'disk-full',
  SNAPSHOT_FAILED: 'snapshot-failed',
  SOURCE_CHANGED: 'source-changed',
  REAUTHORIZATION_DENIED: 'reauthorization-denied',
  TARGET_REJECTED: 'target-rejected',
  TARGET_PROOF_MISSING: 'target-proof-missing',
  TARGET_UNREACHABLE: 'target-unreachable',
  FLEET_HANDOFF_FAILED: 'fleet-handoff-failed',
  SOURCE_CONFIG_FAILED: 'source-config-failed',
  COMMIT_UNCERTAIN: 'commit-uncertain',
  HANDOFF_ORPHANED: 'handoff-orphaned',
  HANDOFF_UNSEALED: 'handoff-unsealed',
  BOOT_RECOVERY: 'boot-recovery',
  RECOVERY_REFUSED: 'recovery-refused',
  LEGACY_TRANSFER_IN_PROGRESS: 'legacy-transfer-in-progress',
  INTERNAL: 'internal',
} as const

export type TransferFailureCode =
  (typeof TRANSFER_FAILURE_CODES)[keyof typeof TRANSFER_FAILURE_CODES]
