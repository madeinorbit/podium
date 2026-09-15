/** HTTP sync v1: UTF-8 NDJSON. See docs/spec/sync-http-stream.md. */
import { z } from 'zod'
import { WIRE_VERSION } from '../version'
import {
  CertifiedRangeFields,
  FeedBootstrapMessage,
  FeedBootstrapMessageLenient,
  FeedDeltaMessage,
  FeedDeltaMessageLenient,
  validateFeedFrame,
  type FeedFrameViolation,
} from './feed'

// Structural WHATWG contracts keep this package's ES-only typecheck DOM-free.
const utf8 = globalThis as unknown as { TextEncoder: new () => { encode(input: string): Uint8Array } }
const encoder = new utf8.TextEncoder()
export interface SyncQueryParams { getAll(name: string): string[] }

export const SYNC_CONTENT_TYPE = 'application/x-ndjson'
export const SYNC_LINE_MAX_BYTES = 16 * 1024 * 1024
export const SYNC_BATCH_TARGET_BYTES = 1024 * 1024
export const SYNC_BATCH_MAX_ROWS = 500
export const SYNC_REFUSAL_STATUS = {
  unauthenticated: 401,
  noFeedPrincipal: 403,
  bootstrapRequired: 409,
  unsupportedWireVersion: 426,
  admissionFull: 503,
} as const
export const SYNC_RETRY_AFTER_HEADER = 'Retry-After'

// The recovery protocol permits any reason string; keep its existing
// spellings here while closing the vocabulary for the HTTP endpoint.
export const SyncBootstrapRequiredReason = z.enum([
  'feed-identity-mismatch', 'compacted-or-unknown', 'corrupt-payload', 'rescope', 'future-cursor', 'invalid-target',
])
export type SyncBootstrapRequiredReason = z.infer<typeof SyncBootstrapRequiredReason>
export const SyncBootstrapRequired = z.object({
  kind: z.literal('bootstrap-required'),
  reason: SyncBootstrapRequiredReason,
})
export type SyncBootstrapRequired = z.infer<typeof SyncBootstrapRequired>
export const SyncErrorReason = z.enum([
  'compressor-failed', 'read-failed', 'deadline', 'cancelled', 'row-too-large',
  'server-shutdown', 'authorization-changed',
])
export type SyncErrorReason = z.infer<typeof SyncErrorReason>

const Count = z.number().int().nonnegative().safe()
const TransferId = z.string().min(1)
const SyncMetaShape = z.object({
  type: z.literal('syncMeta'),
  formatVersion: z.literal(1),
  mode: z.enum(['snapshot', 'delta']),
  transferId: TransferId,
  feedId: CertifiedRangeFields.feedId,
  epoch: CertifiedRangeFields.epoch,
  seq: CertifiedRangeFields.seq,
  fromSeq: CertifiedRangeFields.fromSeq.optional(),
  minAvailableSeq: CertifiedRangeFields.minAvailableSeq,
  wireVersion: z.literal(WIRE_VERSION),
  wireSchemaDigest: z.string().regex(/^[0-9a-f]{16}$/),
  totalRows: Count.optional(),
})
export type SyncMeta = z.infer<typeof SyncMetaShape>
export const SyncMeta = SyncMetaShape.refine(validMeta, { message: 'invalid meta range or mode' })
export const SyncComplete = z.object({
  type: z.literal('syncComplete'), transferId: TransferId,
  seq: CertifiedRangeFields.seq, records: Count, rows: Count,
})
export type SyncComplete = z.infer<typeof SyncComplete>
export const SyncError = z.object({
  type: z.literal('syncError'), transferId: TransferId, reason: SyncErrorReason,
})
export type SyncError = z.infer<typeof SyncError>

function validMeta(meta: SyncMeta): boolean {
  return meta.mode === 'snapshot'
    ? meta.fromSeq === undefined
    : meta.fromSeq !== undefined && meta.fromSeq <= meta.seq
}

/** Producer vocabulary reuses the existing strict entity schemas unchanged. */
export const SyncRecord = z.discriminatedUnion('type', [
  SyncMetaShape, FeedBootstrapMessage, FeedDeltaMessage, SyncComplete, SyncError,
]).refine((record) => record.type !== 'syncMeta' || validMeta(record), {
  message: 'fromSeq is required in delta mode, absent in snapshot mode, and cannot exceed seq',
})
export type SyncRecord = z.infer<typeof SyncRecord>
export const SyncRecordLenient = z.discriminatedUnion('type', [
  SyncMetaShape, FeedBootstrapMessageLenient, FeedDeltaMessageLenient, SyncComplete, SyncError,
]).refine((record) => record.type !== 'syncMeta' || validMeta(record), {
  message: 'invalid meta range or mode',
})
export type SyncRecordLenient = z.infer<typeof SyncRecordLenient>

export type SyncRecordParseResult =
  | { kind: 'record'; record: SyncRecordLenient }
  | { kind: 'ignored'; type: string }
  | { kind: 'refused'; reason: 'line-too-large' | 'invalid-json' | 'invalid-record' }

/** Input excludes the terminating LF. Unknown types are ignored, not certified. */
export function parseSyncRecord(line: string): SyncRecordParseResult {
  if (encoder.encode(line).byteLength > SYNC_LINE_MAX_BYTES) {
    return { kind: 'refused', reason: 'line-too-large' }
  }
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return { kind: 'refused', reason: 'invalid-json' } }
  if (!raw || typeof raw !== 'object' || !('type' in raw) || typeof raw.type !== 'string') {
    return { kind: 'refused', reason: 'invalid-record' }
  }
  if (!['syncMeta', 'feedBootstrap', 'feedDelta', 'syncComplete', 'syncError'].includes(raw.type)) {
    return { kind: 'ignored', type: raw.type }
  }
  const parsed = SyncRecordLenient.safeParse(raw)
  return parsed.success
    ? { kind: 'record', record: parsed.data }
    : { kind: 'refused', reason: 'invalid-record' }
}

const QuerySeq = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).pipe(Count)
/** One shared feedId/epoch identifies both cursors. Duplicate parameters fail. */
export const SyncDeltaQuery = z.object({
  feedId: CertifiedRangeFields.feedId,
  epoch: CertifiedRangeFields.epoch,
  from: QuerySeq,
  to: QuerySeq.optional(),
}).refine((query) => query.to === undefined || query.to >= query.from, {
  message: 'to must be greater than or equal to from', path: ['to'],
})
export type SyncDeltaQuery = z.infer<typeof SyncDeltaQuery>
export function parseSyncDeltaQuery(query: SyncQueryParams): ReturnType<typeof SyncDeltaQuery.safeParse> {
  const fields: Record<string, unknown> = {}
  for (const key of ['feedId', 'epoch', 'from', 'to']) {
    const values = query.getAll(key)
    if (values.length) fields[key] = values.length === 1 ? values[0] : values
  }
  return SyncDeltaQuery.safeParse(fields)
}

export type SyncDeltaChainViolation = FeedFrameViolation
  | 'meta-required' | 'delta-required' | 'identity-mismatch' | 'non-chaining'
  | 'target-exceeded' | 'incomplete-range' | 'complete-required'
  | 'transfer-mismatch' | 'complete-seq-mismatch' | 'count-mismatch'

/** Validate a complete, parsed delta transfer; [] means success. Unknown record
 * types must be filtered with parseSyncRecord before calling this helper. */
export function validateSyncDeltaChain(lines: readonly SyncRecordLenient[]): SyncDeltaChainViolation[] {
  const meta = lines[0]
  if (meta?.type !== 'syncMeta' || meta.mode !== 'delta' || !validMeta(meta)) return ['meta-required']
  const violations: SyncDeltaChainViolation[] = []
  let cursor = meta.fromSeq!
  let records = 0
  let rows = 0
  for (const line of lines.slice(1, -1)) {
    if (line.type !== 'feedDelta') { violations.push('delta-required'); continue }
    if (line.feedId !== meta.feedId || line.epoch !== meta.epoch) violations.push('identity-mismatch')
    if (line.fromSeq !== cursor) violations.push('non-chaining')
    if (line.seq > meta.seq) violations.push('target-exceeded')
    violations.push(...validateFeedFrame(line))
    cursor = line.seq
    records++
    rows += line.changes.length
  }
  if (cursor !== meta.seq) violations.push('incomplete-range')
  const complete = lines[lines.length - 1]
  if (complete?.type !== 'syncComplete') violations.push('complete-required')
  else {
    if (complete.transferId !== meta.transferId) violations.push('transfer-mismatch')
    if (complete.seq !== meta.seq) violations.push('complete-seq-mismatch')
    if (complete.records !== records || complete.rows !== rows) violations.push('count-mismatch')
  }
  return [...new Set(violations)]
}
