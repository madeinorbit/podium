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

// ---- Kind-tolerant (lenient) consumer parsing ([spec:SP-3fe2] #258) ----
// Forward-compat prep for future entity kinds ('machine', 'settings', …):
// producers NEVER emit unknown kinds today — every SERVER-side schema stays
// strict — but consumers parse the change stream LENIENTLY, so a NEWER server
// can add a kind without quarantining OLDER clients. Under the strict
// discriminatedUnion an unknown-kind row fails parse; a quarantined delta
// element is an invisible cursor gap, so the client heals via changesSince —
// which returns the same unknown rows and loops forever. The lenient union
// lets those rows through with `value: unknown`; consumers apply the known
// kinds, IGNORE the unknown ones (with a debug log), and advance the cursor.

/** The catch-all arm: a change row whose entity kind this build doesn't know.
 *  Known kinds are EXCLUDED — a known-kind row with an invalid value must
 *  still fail parse (quarantine → heal), never sneak through the catch-all. */
export const UnknownMetadataChange = z.object({
  seq: z.number().int().positive(),
  entity: z.string().refine((e) => !MetadataEntityKind.options.includes(e as MetadataEntityKind), {
    message: 'known entity kinds must parse through the strict MetadataChange union',
  }),
  id: z.string(),
  op: MetadataChangeOp,
  value: z.unknown().optional(),
})
export type UnknownMetadataChange = z.infer<typeof UnknownMetadataChange>

export const MetadataChangeLenient = z.union([MetadataChange, UnknownMetadataChange])
export type MetadataChangeLenient = MetadataChange | UnknownMetadataChange

/** Narrow a leniently parsed change to the known union. `false` means "a newer
 *  server sent a kind this build doesn't know": ignore the row (NEVER fold it
 *  into some other entity's list) but still advance the cursor past it. */
export function isKnownMetadataChange(change: MetadataChangeLenient): change is MetadataChange {
  return MetadataEntityKind.options.includes(change.entity as MetadataEntityKind)
}

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

/** {@link MetadataDeltaMessage} as CONSUMERS parse it (kind-tolerant — see the
 *  lenient-parsing note above MetadataChangeLenient). Producers still emit and
 *  validate the strict shape. */
export const MetadataDeltaMessageLenient = z.object({
  type: z.literal('metadataDelta'),
  seq: z.number().int().positive(),
  changes: z.array(MetadataChangeLenient),
})
export type MetadataDeltaMessageLenient = z.infer<typeof MetadataDeltaMessageLenient>

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

/** {@link SyncChangesSinceResult} as CONSUMERS type it (kind-tolerant): the
 *  delta arm's changes may contain unknown entity kinds from a newer server.
 *  The strict result is assignable to it, so producers/tests need no changes.
 *  Consumers must not trust the transport's compile-time type alone — validate
 *  the fetched value through {@link parseChangesSinceResult}. */
export type SyncChangesSinceResultLenient =
  | { kind: 'delta'; changes: MetadataChangeLenient[]; cursor: number }
  | Extract<SyncChangesSinceResult, { kind: 'snapshot' }>

/** Runtime schema for {@link SyncChangesSinceResultLenient} ([spec:SP-3fe2]
 *  #247). The delta arm validates element-wise through MetadataChangeLenient:
 *  the strict known-kind arms validate VALUES, and the catch-all admits only
 *  UNKNOWN kinds — so a known-kind row with a malformed value fails the whole
 *  parse (it must never install, and the cursor must never advance past it
 *  silently). The snapshot arm is strict. */
export const SyncChangesSinceResultLenientSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('delta'),
    changes: z.array(MetadataChangeLenient),
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

/**
 * Validate a fetched `sync.changesSince` result ([spec:SP-3fe2] #247). The WS
 * delta frames already parse leniently (codec.ts), but the HTTP heal result
 * used to be consumed on trust: a known-kind row with a malformed value slid
 * past `isKnownMetadataChange` (an entity-string check) into mirrors/UI, and
 * the cursor skipped it permanently. Returns null when the result is
 * malformed — a delta carrying an invalid KNOWN-kind element, or an invalid
 * snapshot. Callers must treat null as a failed heal and escalate to a
 * snapshot heal (null-cursor refetch — the same fallback the server uses for
 * a corrupt log row), never install, never advance the cursor past it.
 */
export function parseChangesSinceResult(
  input: unknown,
  opts?: {
    /** The cursor the caller requested changes SINCE. When provided and the
     *  delta is non-empty, the first change must be exactly fromCursor + 1 —
     *  the server's contiguity contract; anything else is a hole the caller
     *  would silently skip by advancing to the result cursor. */
    fromCursor?: number | null
  },
): SyncChangesSinceResultLenient | null {
  const parsed = SyncChangesSinceResultLenientSchema.safeParse(input)
  if (!parsed.success) return null
  const result = parsed.data
  if (result.kind !== 'delta') return result
  // Semantic validation beyond shapes ([spec:SP-3fe2] #247 round 2): a
  // shape-valid delta can still lie — an embedded wire id disagreeing with the
  // change id would install an entity under the wrong identity (a later remove
  // of the change id could never remove it), and a seq sequence that skips or
  // stops short of the result cursor is a permanent gap once the caller
  // advances. Reject → the caller escalates to a snapshot heal.
  let prevSeq = opts?.fromCursor ?? null
  for (const change of result.changes) {
    if (prevSeq !== null && change.seq !== prevSeq + 1) return null
    prevSeq = change.seq
    if (!isKnownMetadataChange(change) || change.op !== 'upsert' || change.value === undefined) {
      continue
    }
    const embeddedId =
      change.entity === 'session'
        ? (change.value as { sessionId: string }).sessionId
        : (change.value as { id: string }).id
    if (embeddedId !== change.id) return null
  }
  if (result.changes.length > 0) {
    const last = result.changes[result.changes.length - 1]
    if (last !== undefined && last.seq !== result.cursor) return null
  }
  return result
}
