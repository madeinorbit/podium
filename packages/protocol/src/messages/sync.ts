import { z } from 'zod'
import { ConversationDiagnosticWire, ConversationSummaryWire } from './discovery'
import { IssueWire } from './issues'
import { SessionMeta } from './runtime-state'

// ---- Metadata oplog (docs/spec/oplog-read-path.md) ----
// One row of the server's metadata change log. `seq` is server-assigned and
// globally monotonic across all entities (one stream, one cursor). `value` is the
// entity's WIRE shape — the oplog speaks protocol, not DB rows. Present iff
// op === 'upsert' (zod can't express that cross-field rule; producers guarantee it,
// consumers treat a missing value on upsert as a drop-this-change).
export const MetadataChangeOp = z.enum(['upsert', 'remove'])
export type MetadataChangeOp = z.infer<typeof MetadataChangeOp>
export const MetadataChange = z.discriminatedUnion('entity', [
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('session'),
    id: z.string(),
    op: MetadataChangeOp,
    value: SessionMeta.optional(),
  }),
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('issue'),
    id: z.string(),
    op: MetadataChangeOp,
    value: IssueWire.optional(),
  }),
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('conversation'),
    id: z.string(),
    op: MetadataChangeOp,
    value: ConversationSummaryWire.optional(),
  }),
])
export type MetadataChange = z.infer<typeof MetadataChange>
export const MetadataEntityKind = z.enum(['session', 'issue', 'conversation'])
export type MetadataEntityKind = z.infer<typeof MetadataEntityKind>

// A batch of oplog changes, sent only to clients that sent `caps: ['metadataDelta']`
// in their hello. Changes are in seq order; `seq` mirrors the LAST change's seq so a
// client can advance its cursor without scanning. Gap rule: if the first change's
// seq !== cursor + 1, the client must NOT apply and instead heal via the
// `sync.changesSince` tRPC query.
export const MetadataDeltaMessage = z.object({
  type: z.literal('metadataDelta'),
  seq: z.number().int().positive(),
  changes: z.array(MetadataChange),
})
export type MetadataDeltaMessage = z.infer<typeof MetadataDeltaMessage>

// Result of the `sync.changesSince` catch-up query (defined here so the web app and
// SocketHub share one type without importing server internals). `snapshot` is
// returned for a null cursor (bootstrap) or a cursor older than the retained log
// (compaction) — it carries the full durable-entity state plus the cursor AS OF the
// read, taken in the same tick, so no change falls between snapshot and stream.
export const SyncChangesSinceResult = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('delta'),
    changes: z.array(MetadataChange),
    cursor: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('snapshot'),
    sessions: z.array(SessionMeta),
    issues: z.array(IssueWire),
    conversations: z.array(ConversationSummaryWire),
    diagnostics: z.array(ConversationDiagnosticWire),
    cursor: z.number().int().nonnegative(),
  }),
])
export type SyncChangesSinceResult = z.infer<typeof SyncChangesSinceResult>
