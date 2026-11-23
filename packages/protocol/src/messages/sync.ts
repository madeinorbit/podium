import {
  GlobalChangeOpField,
  IssueDepProjection,
  IssueEventWire,
  IssueGitStateProjection,
  IssueProjection,
  IssueUserStateWire,
  MachineProjection,
  RECORD_KINDS,
  RECORDS,
  RepoProjection,
  SessionUserStateWire,
} from '@podium/model'
import { ShipLaneProjection, ShipOrderProjection } from '@podium/model/shipping-projection'
import { z } from 'zod'
import { changeRowArm } from './change-row'

/**
 * Re-exported from `@podium/model` [POD-796, POD-822].
 *
 * Each of these is an arm of {@link MetadataChange}, so each IS a wire shape,
 * and a peer that parses the feed must be able to name it without taking a
 * dependency this layer does not permit it: `@podium/terminal-client` depends on
 * protocol ONLY (ADR 8; protocol is the one near-leaf allowed to import model —
 * see RESTRICTED_PACKAGE_DEPS in scripts/check-boundaries.ts). Re-exporting here
 * keeps the vocabulary single-sourced in model while letting protocol's
 * consumers stay on protocol.
 */
export {
  IssueDepProjection,
  IssueEventWire,
  IssueGitStateProjection,
  IssueProjection,
  IssueUserStateWire,
  MachineProjection,
  RepoProjection,
  SessionUserStateWire,
  ShipLaneProjection,
  ShipOrderProjection,
}

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

// ---- Feed identity (ADR 2 D1) ----
//
// A cursor is meaningless without it. `seq` alone cannot distinguish "you are
// up to date" from "you hold entities off a timeline that no longer exists":
// restore the authority from a backup whose log ends at 400 while a client
// holds 500, let the authority write 100 more changes, and `changesSince(500)`
// finds cursor === max and answers `[]` — "up to date" — forever. The client's
// 401..500 are phantoms from the dead timeline and nothing can ever detect it.
// A replica's cursor is therefore the TRIPLE (feedId, epoch, seq); any mismatch
// on either id is a RESET (re-bootstrap), never a heal.
//
// Both ids are OPAQUE and compared by EQUALITY ONLY. The epoch is a minted,
// never-reused id — deliberately NOT a counter. The epoch lives in the database,
// so restoring a backup restores the OLD epoch with the old seqs and the bump
// must happen at restore time on the restored value: restore `epoch=3` → bump →
// 4; restore THE SAME backup again → 3 again → bump → 4 AGAIN, a different
// timeline wearing an epoch clients already accepted. A counter silently
// re-collides in exactly the situation the epoch exists to catch. Ordering is
// never needed — a replica only asks "is this the generation I hold?".
const FeedIdShape = {
  /** Stable identity of the feed — minted once per authority database. Changes
   *  ONLY when the database is genuinely a different feed. This is also the
   *  federation seam's authority/feed identity [spec:SP-0371]. */
  feedId: z.string().min(1).optional(),
  /** Identity of the current seq-continuity generation. The authority mints a
   *  NEW one whenever it cannot guarantee its seqs continue the ones clients
   *  hold: restore from backup, DB rebuild, any operator action that rewinds
   *  `changes`.
   *
   *  NOT `SessionMeta.epoch`, which is an unrelated per-session PTY generation
   *  counter living inside a change's `value`. This one identifies the FEED and
   *  is a string precisely because it is never counted or ordered. The two never
   *  meet — different scopes, different types — but they read alike at a glance,
   *  so: this is the feed's, that one is a session's. */
  epoch: z.string().min(1).optional(),
  /** The lowest seq the authority can still DELIVER (ADR 2 D5) — the retention
   *  horizon, published so a replica can tell it must re-bootstrap BEFORE
   *  asking rather than after being refused.
   *
   *  Exactly: `minChangeSeq() ?? maxChangeSeq() + 1`. The fallback is what makes
   *  the number total — a fully-pruned log can deliver nothing that exists, and
   *  the next change it writes will be max + 1, which is true and precise.
   *  Always >= 1 (seqs are 1-based).
   *
   *  The precise replica predicate is `cursor + 1 < minAvailableSeq` ⇒
   *  re-bootstrap, which is the authority's own servability rule: it can serve
   *  a cursor iff every change in (cursor, max] is retained, i.e. iff
   *  cursor + 1 >= minAvailableSeq. (ADR 2 D7 rung 2 states the shorthand
   *  `cursor < minAvailableSeq`; that is the same rule off by one, and errs
   *  toward one needless re-bootstrap — safe, since the authority's answer is
   *  the authority either way, but the exact form is free.) */
  minAvailableSeq: z.number().int().positive().optional(),
} as const

/** The arm {@link metadataChangeArm} builds for one declared record type. */
type MetadataChangeArmOf<D extends (typeof RECORDS)[number]> = ReturnType<
  typeof metadataChangeArm<z.ZodLiteral<D['kind']>, D['schema']>
>
type MetadataChangeArms<T extends readonly (typeof RECORDS)[number][]> = {
  -readonly [I in keyof T]: T[I] extends infer D extends (typeof RECORDS)[number]
    ? MetadataChangeArmOf<D>
    : never
}

/**
 * One change row of each synced record type, GENERATED from the record
 * declarations in `@podium/model` (`records/declarations.ts`, POD-7084): one
 * arm per declared type, in declaration order, its value the type's wire
 * schema. Until POD-7084 this list was written out here by hand, beside a
 * second hand-written list of the kind names; `record-list.test.ts` holds the
 * generated list to that last hand-written one.
 *
 * Every kind is additive on the wire: a build whose list predates a kind
 * parses its rows as {@link UnknownMetadataChange}, ignores them and advances
 * its cursor (ADR 2 D4). Why each kind exists, and how its rows are keyed, is
 * written on its declaration.
 */
export const MetadataChange = z.discriminatedUnion(
  'entity',
  RECORDS.map((record) =>
    metadataChangeArm(z.literal(record.kind), record.schema),
  ) as unknown as MetadataChangeArms<typeof RECORDS>,
)
export type MetadataChange = z.infer<typeof MetadataChange>
/** The synced record kinds, in declaration order: generated, like {@link MetadataChange}. */
export const MetadataEntityKind = z.enum(RECORD_KINDS)
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
  ...FeedIdShape,
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
  ...FeedIdShape,
})
export type MetadataDeltaMessageLenient = z.infer<typeof MetadataDeltaMessageLenient>
