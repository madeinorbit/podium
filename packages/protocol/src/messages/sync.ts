import {
  AutomationRunWire,
  AutomationWire,
  ChangeCursorSeqField,
  ChangeEntityIdField,
  ChangeSeqField,
  ConversationDiagnosticWire,
  ConversationSummaryWire,
  GlobalChangeOpField,
  IssueWire,
  SessionMeta,
} from '@podium/model'
import { z } from 'zod'
import { changeRowArm } from './change-row'

// ---- Metadata oplog (docs/spec/oplog-read-path.md) ----
// One row of the server's metadata change log. `seq` is server-assigned and
// globally monotonic across all entities (one stream, one cursor). `value` is the
// entity's WIRE shape — the oplog speaks protocol, not DB rows. Present iff
// op === 'upsert' (zod can't express that cross-field rule; producers guarantee it,
// consumers treat a missing value on upsert as a drop-this-change).
/**
 * The op vocabulary a GLOBAL change row may carry — `@podium/model`'s, not a
 * second copy (POD-305). `evict` is deliberately not a member: it is a
 * per-principal fact and never a row in the one global log (ADR 2 Am1 D14.5).
 */
export const MetadataChangeOp = GlobalChangeOpField
export type MetadataChangeOp = z.infer<typeof MetadataChangeOp>

/**
 * ONE arm of the change union (POD-305).
 *
 * The five arms below used to restate `seq`/`entity`/`id`/`op`/`value` verbatim,
 * and so did `UnknownMetadataChange` — six copies of one field list, which is the
 * restatement POD-305's acceptance criterion 3 and the `change-row-typings` audit
 * item target. The FIELDS now come from `@podium/model`'s change vocabulary and
 * the ARM SHAPE is composed here exactly once.
 *
 * Key ORDER is preserved exactly as it was (`seq`, `entity`, `id`, `op`, `value`):
 * zod emits parsed keys in shape order, so a reordering here would change the
 * serialization of every change row on the wire — a silent break in a refactor
 * that is supposed to have none. `wire-golden.json` is the gate on that.
 *
 * `value` is present iff `op === 'upsert'`. Zod cannot express that cross-field
 * rule; producers guarantee it and consumers treat a missing value on an upsert as
 * a drop-this-change.
 */
const metadataChangeArm = <E extends z.ZodTypeAny, V extends z.ZodTypeAny>(entity: E, value: V) =>
  changeRowArm('id', entity, MetadataChangeOp, value)

export const MetadataChange = z.discriminatedUnion('entity', [
  metadataChangeArm(z.literal('session'), SessionMeta),
  metadataChangeArm(z.literal('issue'), IssueWire),
  metadataChangeArm(z.literal('conversation'), ConversationSummaryWire),
  metadataChangeArm(z.literal('automation'), AutomationWire),
  metadataChangeArm(z.literal('automationRun'), AutomationRunWire),
])
export type MetadataChange = z.infer<typeof MetadataChange>
export const MetadataEntityKind = z.enum([
  'session',
  'issue',
  'conversation',
  'automation',
  'automationRun',
])
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
export const UnknownMetadataChange = metadataChangeArm(
  // Not a `z.literal`, but the same POSITION in the same arm shape: an unknown
  // kind is a change row like any other, and composing it here is what stops the
  // catch-all from drifting away from the strict arms it has to stay parallel to.
  z.string().refine((e) => !MetadataEntityKind.options.includes(e as MetadataEntityKind), {
    message: 'known entity kinds must parse through the strict MetadataChange union',
  }),
  z.unknown(),
)
export type UnknownMetadataChange = z.infer<typeof UnknownMetadataChange>

export const MetadataChangeLenient = z.union([MetadataChange, UnknownMetadataChange])
export type MetadataChangeLenient = MetadataChange | UnknownMetadataChange

/** Narrow a leniently parsed change to the known union. `false` means "a newer
 *  server sent a kind this build doesn't know": ignore the row (NEVER fold it
 *  into some other entity's list) but still advance the cursor past it. */
export function isKnownMetadataChange(change: MetadataChangeLenient): change is MetadataChange {
  return MetadataEntityKind.options.includes(change.entity as MetadataEntityKind)
}

// A batch of oplog changes, sent only to clients that sent `caps: ['metadataDelta']`.
// A view-filtered producer includes `fromExclusive`: omitted rows inside that
// explicit global source range are authorized-hidden, not transport loss.
export const MetadataDeltaMessage = z.object({
  type: z.literal('metadataDelta'),
  seq: z.number().int().positive(),
  fromExclusive: z.number().int().nonnegative().optional(),
  changes: z.array(MetadataChange),
})
export type MetadataDeltaMessage = z.infer<typeof MetadataDeltaMessage>

/** {@link MetadataDeltaMessage} as CONSUMERS parse it (kind-tolerant — see the
 *  lenient-parsing note above MetadataChangeLenient). Producers still emit and
 *  validate the strict shape. */
export const MetadataDeltaMessageLenient = z.object({
  type: z.literal('metadataDelta'),
  seq: z.number().int().positive(),
  fromExclusive: z.number().int().nonnegative().optional(),
  changes: z.array(MetadataChangeLenient),
})
export type MetadataDeltaMessageLenient = z.infer<typeof MetadataDeltaMessageLenient>

// Result of the `sync.changesSince` catch-up query (defined here so the web app and
// SocketHub share one type without importing server internals). `snapshot` is
// returned for a null cursor (bootstrap) or a cursor older than the retained log
// (compaction) — it carries the full durable-entity state plus the cursor AS OF the
// read, taken in the same tick, so no change falls between snapshot and stream.
/**
 * The delta arm, parameterized by how strictly its elements parse (POD-305).
 *
 * The strict and lenient results used to restate this arm and the whole snapshot
 * arm side by side, which is how they drifted: the lenient copy already listed its
 * keys in a different order from the strict one. One factory per arm means the two
 * results differ in exactly the one thing they are supposed to differ in — element
 * strictness — and in nothing else.
 */
const changesSinceDeltaArm = <C extends z.ZodTypeAny>(change: C) =>
  z.object({
    kind: z.literal('delta'),
    fromExclusive: ChangeCursorSeqField.optional(),
    changes: z.array(change),
    cursor: ChangeCursorSeqField,
  })

/** The snapshot arm. Identical in both results — it is full durable state, and
 *  there is no lenient reading of an entity list this build must render. */
const changesSinceSnapshotArm = () =>
  z.object({
    kind: z.literal('snapshot'),
    sessions: z.array(SessionMeta),
    issues: z.array(IssueWire),
    conversations: z.array(ConversationSummaryWire),
    diagnostics: z.array(ConversationDiagnosticWire),
    automations: z.array(AutomationWire).optional(),
    automationRuns: z.array(AutomationRunWire).optional(),
    cursor: ChangeCursorSeqField,
  })

export const SyncChangesSinceResult = z.discriminatedUnion('kind', [
  changesSinceDeltaArm(MetadataChange),
  changesSinceSnapshotArm(),
])
export type SyncChangesSinceResult = z.infer<typeof SyncChangesSinceResult>

/** {@link SyncChangesSinceResult} as CONSUMERS type it (kind-tolerant): the
 *  delta arm's changes may contain unknown entity kinds from a newer server.
 *  The strict result is assignable to it, so producers/tests need no changes.
 *  Consumers must not trust the transport's compile-time type alone — validate
 *  the fetched value through {@link parseChangesSinceResult}. */
export type SyncChangesSinceResultLenient =
  | {
      kind: 'delta'
      changes: MetadataChangeLenient[]
      fromExclusive?: number
      cursor: number
    }
  | Extract<SyncChangesSinceResult, { kind: 'snapshot' }>

/** Runtime schema for {@link SyncChangesSinceResultLenient} ([spec:SP-3fe2]
 *  #247). The delta arm validates element-wise through MetadataChangeLenient:
 *  the strict known-kind arms validate VALUES, and the catch-all admits only
 *  UNKNOWN kinds — so a known-kind row with a malformed value fails the whole
 *  parse (it must never install, and the cursor must never advance past it
 *  silently). The snapshot arm is strict. */
export const SyncChangesSinceResultLenientSchema = z.discriminatedUnion('kind', [
  changesSinceDeltaArm(MetadataChangeLenient),
  changesSinceSnapshotArm(),
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
    /** The cursor the caller requested changes SINCE. When a number and the
     *  delta is non-empty, the first change must be exactly fromCursor + 1 —
     *  the server's contiguity contract; anything else is a hole the caller
     *  would silently skip by advancing to the result cursor. When EXPLICITLY
     *  null (bootstrap — distinguished from omitted via `'fromCursor' in
     *  opts`), only a snapshot is acceptable: the contract says a null cursor
     *  yields the full state, and a delta here has nothing to be relative to. */
    fromCursor?: number | null
  },
): SyncChangesSinceResultLenient | null {
  const parsed = SyncChangesSinceResultLenientSchema.safeParse(input)
  if (!parsed.success) return null
  const result = parsed.data
  if (result.kind !== 'delta') return result
  // Explicit-null cursor ([spec:SP-3fe2] #247 round 3): the caller asked for a
  // BOOTSTRAP snapshot — accepting a delta would install changes relative to
  // state the client doesn't have and stamp its cursor as if it did.
  const hasFrom = opts !== undefined && 'fromCursor' in opts
  if (hasFrom && opts.fromCursor === null) return null
  // A scoped producer names the complete GLOBAL source range explicitly. Rows
  // omitted inside it are hidden by authority, so gaps and an empty visible set
  // are valid; the range itself is what authorizes cursor advancement.
  if (result.fromExclusive !== undefined) {
    if (
      result.fromExclusive > result.cursor ||
      (hasFrom && typeof opts.fromCursor === 'number' && result.fromExclusive !== opts.fromCursor)
    ) {
      return null
    }
    let previous = result.fromExclusive
    for (const change of result.changes) {
      if (change.seq <= previous || change.seq > result.cursor) return null
      previous = change.seq
      if (!isKnownMetadataChange(change) || change.op !== 'upsert' || change.value === undefined) {
        continue
      }
      const embeddedId =
        change.entity === 'session'
          ? (change.value as { sessionId: string }).sessionId
          : (change.value as { id: string }).id
      if (embeddedId !== change.id) return null
    }
    return result
  }

  // An EMPTY delta must not move the cursor (#247 round 3): its cursor must
  // equal the requested fromCursor — anything later silently skips the changes
  // between them forever (both consumers persist the advanced cursor).
  if (hasFrom && typeof opts.fromCursor === 'number' && result.changes.length === 0) {
    return result.cursor === opts.fromCursor ? result : null
  }
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
