import { z } from 'zod'

/** Files safe to move between Podium state roots. Identity and config remain local. */
export const ServerTransferManifestEntry = z.object({
  path: z.string().min(1).max(1024),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(512 * 1024 * 1024),
  mode: z.number().int().min(0).max(0o777),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export type ServerTransferManifestEntry = z.infer<typeof ServerTransferManifestEntry>

const transferId = z.string().uuid()
const requestId = z.string().min(1).max(200)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const machineId = z.string().min(1).max(200)

export const SERVER_TRANSFER_MAX_CHUNK_BYTES = 512 * 1024
export const SERVER_TRANSFER_CAPACITY_MARGIN = 0.1

export const SERVER_TRANSFER_FORMAT_VERSION = 1

/** Identity-bound portable package. Its canonical digest covers every field. */
export const ServerTransferManifest = z.object({
  formatVersion: z.literal(SERVER_TRANSFER_FORMAT_VERSION),
  transferId,
  sourceInstanceId: z.string().min(1).max(200),
  sourceMachineId: machineId,
  targetMachineId: machineId,
  sourceFeedId: z.string().min(1).max(200),
  sourceFeedEpoch: z.string().min(1).max(200),
  appVersion: z.string().min(1).max(200),
  schemaVersion: z.string().min(1).max(200),
  packageBytes: z
    .number()
    .int()
    .nonnegative()
    .max(512 * 1024 * 1024),
  files: z.array(ServerTransferManifestEntry).max(20_000),
})
export type ServerTransferManifest = z.infer<typeof ServerTransferManifest>

export const ServerTransferErrorCode = z.enum([
  'unknown-transfer',
  'conflicting-digest',
  'unsafe-path',
  'digest-mismatch',
  'size-mismatch',
  'offset-gap',
  'offset-overlap',
  'oversized-chunk',
  'unknown-file',
  'capacity-exceeded',
  'aborted',
  'committed',
  'uncertain-commit',
  'refused',
  'invalid-request',
  'candidate-invalid',
  'identity-mismatch',
  'timeout',
  'internal',
])
export type ServerTransferErrorCode = z.infer<typeof ServerTransferErrorCode>

export const ServerTransferSpaceProof = z.object({
  availableBytes: z.number().int().nonnegative(),
  requiredBytes: z.number().int().nonnegative(),
  sufficient: z.boolean(),
})
export type ServerTransferSpaceProof = z.infer<typeof ServerTransferSpaceProof>

export const ServerTransferTargetCapability = z.literal('server-only')
export type ServerTransferTargetCapability = z.infer<typeof ServerTransferTargetCapability>

/** Read-only evidence that the staged/imported instance matches the requested transfer. */
export const ServerTransferProof = z.object({
  transferId,
  manifestDigest: digest,
  targetMachineId: machineId,
  feedId: z.string().min(1).max(200),
  feedEpoch: z.string().min(1).max(200),
  schemaVersion: z.string().min(1).max(200),
  buildVersion: z.string().min(1).max(200),
})
export type ServerTransferProof = z.infer<typeof ServerTransferProof>
/** Proof created only after the promoted server has passed its serving callback. */
export const ServerTransferServingProof = ServerTransferProof.extend({
  publicUrl: z.string().min(1).max(2048),
  health: z.literal('serving'),
})
export type ServerTransferServingProof = z.infer<typeof ServerTransferServingProof>

export const ServerTransferPrepareRequestMessage = z.object({
  type: z.literal('serverTransferPrepareRequest'),
  requestId,
  transferId,
  manifest: ServerTransferManifest,
  manifestDigest: digest,
})
export type ServerTransferPrepareRequestMessage = z.infer<
  typeof ServerTransferPrepareRequestMessage
>

export const ServerTransferChunkRequestMessage = z.object({
  type: z.literal('serverTransferChunkRequest'),
  requestId,
  transferId,
  manifestDigest: digest,
  path: z.string().min(1).max(1024),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(512 * 1024 * 1024),
  data: z.string().max(Math.ceil(SERVER_TRANSFER_MAX_CHUNK_BYTES / 3) * 4),
  expectedLength: z.number().int().positive().max(SERVER_TRANSFER_MAX_CHUNK_BYTES),
})
export type ServerTransferChunkRequestMessage = z.infer<typeof ServerTransferChunkRequestMessage>

export const ServerTransferValidateRequestMessage = z.object({
  type: z.literal('serverTransferValidateRequest'),
  requestId,
  transferId,
  manifestDigest: digest,
})
export type ServerTransferValidateRequestMessage = z.infer<
  typeof ServerTransferValidateRequestMessage
>

export const ServerTransferPromoteRequestMessage = z.object({
  type: z.literal('serverTransferPromoteRequest'),
  requestId,
  transferId,
  manifestDigest: digest,
  publicUrl: z.string().min(1).max(2048),
  targetMode: z.literal('server'),
  idempotencyKey: z.string().min(1).max(200),
})
export type ServerTransferPromoteRequestMessage = z.infer<
  typeof ServerTransferPromoteRequestMessage
>

export const ServerTransferAbortRequestMessage = z.object({
  type: z.literal('serverTransferAbortRequest'),
  requestId,
  transferId,
  reason: z.string().max(500).optional(),
  manifestDigest: digest,
})
export type ServerTransferAbortRequestMessage = z.infer<typeof ServerTransferAbortRequestMessage>

export const ServerTransferStatusRequestMessage = z.object({
  type: z.literal('serverTransferStatusRequest'),
  requestId,
  transferId: transferId.optional(),
  manifestDigest: digest.optional(),
})
export type ServerTransferStatusRequestMessage = z.infer<typeof ServerTransferStatusRequestMessage>
export const ServerTransferAcknowledgeRequestMessage = z.object({
  type: z.literal('serverTransferAcknowledgeRequest'),
  requestId,
  transferId,
  manifestDigest: digest,
})
export type ServerTransferAcknowledgeRequestMessage = z.infer<
  typeof ServerTransferAcknowledgeRequestMessage
>

export const ServerTransferOperation = z.enum([
  'prepare',
  'chunk',
  'validate',
  'promote',
  'abort',
  'status',
  'acknowledge',
])
export type ServerTransferOperation = z.infer<typeof ServerTransferOperation>

export const ServerTransferState = z.enum([
  'prepared',
  'staging',
  'idle',
  'validated',
  'promoting',
  'promoted',
  'aborted',
  'uncertain',
])
export type ServerTransferState = z.infer<typeof ServerTransferState>

/** All target-daemon replies use one result family so correlation is single-path. */
export const ServerTransferResultMessage = z.object({
  type: z.literal('serverTransferResult'),
  requestId,
  transferId: transferId.optional(),
  operation: ServerTransferOperation,
  ok: z.boolean(),
  state: ServerTransferState,
  manifestDigest: digest.optional(),
  sourceMachineId: machineId.optional(),
  publicUrl: z.string().min(1).max(2048).optional(),
  path: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  receivedBytes: z.number().int().nonnegative().optional(),
  idempotent: z.boolean().optional(),
  cleaned: z.boolean().optional(),
  acknowledged: z.boolean().optional(),
  targetCapability: ServerTransferTargetCapability.optional(),
  buildVersion: z.string().min(1).max(200).optional(),
  wireSchemaDigest: z.string().min(1).max(200).optional(),
  space: ServerTransferSpaceProof.optional(),
  proof: ServerTransferProof.optional(),
  servingProof: ServerTransferServingProof.optional(),
  errorCode: ServerTransferErrorCode.optional(),
  error: z.string().max(2_000).optional(),
})
export type ServerTransferResultMessage = z.infer<typeof ServerTransferResultMessage>

/** Stable bytes used for manifest authentication and cross-runtime comparison. */
export function canonicalServerTransferManifest(
  manifest: ServerTransferManifest | ServerTransferManifestEntry[],
): string {
  if (Array.isArray(manifest))
    throw new TypeError('full identity-bound server transfer manifest is required')
  return JSON.stringify({
    formatVersion: manifest.formatVersion,
    transferId: manifest.transferId,
    sourceInstanceId: manifest.sourceInstanceId,
    sourceMachineId: manifest.sourceMachineId,
    targetMachineId: manifest.targetMachineId,
    sourceFeedId: manifest.sourceFeedId,
    sourceFeedEpoch: manifest.sourceFeedEpoch,
    appVersion: manifest.appVersion,
    schemaVersion: manifest.schemaVersion,
    packageBytes: manifest.packageBytes,
    files: [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  })
}
