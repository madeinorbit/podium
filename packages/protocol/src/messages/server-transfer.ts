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

export const ServerTransferPrepareRequestMessage = z.object({
  type: z.literal('serverTransferPrepareRequest'),
  requestId,
  transferId,
  manifest: z.array(ServerTransferManifestEntry).max(20_000),
  manifestDigest: digest,
  totalBytes: z
    .number()
    .int()
    .nonnegative()
    .max(512 * 1024 * 1024),
})
export type ServerTransferPrepareRequestMessage = z.infer<
  typeof ServerTransferPrepareRequestMessage
>

export const ServerTransferChunkRequestMessage = z.object({
  type: z.literal('serverTransferChunkRequest'),
  requestId,
  transferId,
  path: z.string().min(1).max(1024),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(512 * 1024 * 1024),
  data: z.string().max(8 * 1024 * 1024),
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
})
export type ServerTransferPromoteRequestMessage = z.infer<
  typeof ServerTransferPromoteRequestMessage
>

export const ServerTransferAbortRequestMessage = z.object({
  type: z.literal('serverTransferAbortRequest'),
  requestId,
  transferId,
  reason: z.string().max(500).optional(),
})
export type ServerTransferAbortRequestMessage = z.infer<typeof ServerTransferAbortRequestMessage>

export const ServerTransferOperation = z.enum(['prepare', 'chunk', 'validate', 'promote', 'abort'])
export type ServerTransferOperation = z.infer<typeof ServerTransferOperation>

export const ServerTransferState = z.enum([
  'prepared',
  'staging',
  'validated',
  'promoted',
  'aborted',
  'uncertain',
])
export type ServerTransferState = z.infer<typeof ServerTransferState>

/** All target-daemon replies use one result family so correlation is single-path. */
export const ServerTransferResultMessage = z.object({
  type: z.literal('serverTransferResult'),
  requestId,
  transferId,
  operation: ServerTransferOperation,
  ok: z.boolean(),
  state: ServerTransferState,
  manifestDigest: digest.optional(),
  path: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  receivedBytes: z.number().int().nonnegative().optional(),
  error: z.string().max(2_000).optional(),
})
export type ServerTransferResultMessage = z.infer<typeof ServerTransferResultMessage>

/** Stable bytes used for manifest authentication and cross-runtime comparison. */
export const canonicalServerTransferManifest = (entries: ServerTransferManifestEntry[]): string =>
  JSON.stringify([...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
