import { IssueDepProjection, IssueProjection, RepoProjection } from '@podium/model'
import { z } from 'zod'
import { AutomationRunWire, AutomationWire } from './automations'
import { ConversationDiagnosticWire, ConversationSummaryWire } from './discovery'
import { IssueWire } from './issues'
import { SessionMeta } from './runtime-state'

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
export { IssueDepProjection, IssueProjection, RepoProjection }

// ---- Metadata oplog (docs/spec/oplog-read-path.md) ----
// One row of the server's metadata change log. `seq` is server-assigned and
// globally monotonic across all entities (one stream, one cursor). `value` is the
// entity's WIRE shape — the oplog speaks protocol, not DB rows. Present iff
// op === 'upsert' (zod can't express that cross-field rule; producers guarantee it,
// consumers treat a missing value on upsert as a drop-this-change).
export const MetadataChangeOp = z.enum(['upsert', 'remove'])
export type MetadataChangeOp = z.infer<typeof MetadataChangeOp>

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
  /** The NORMALIZED issue projection [POD-796, ADR 4 D7.1] — a SECOND kind
   *  alongside 'issue', not a reshaping of it, and that is the whole transition
   *  strategy.
   *
   *  The ledger stores one value per (kind, id), so 'issue' cannot carry two
   *  payload shapes at once: flipping it in place would break every delta client
   *  whose build still expects `IssueWire` — and a lagging PWA bundle is exactly
   *  that client (see version.ts on rolling upgrades). A new kind is the
   *  mechanism this file's own lenient-parsing note was written for: an older
   *  build's `MetadataEntityKind` does not list 'issueProjection', so these rows
   *  fall to {@link UnknownMetadataChange}, get ignored with a debug log, and the
   *  cursor ADVANCES past them — no quarantine, no heal loop. Additive per ADR 2
   *  D4; `WIRE_VERSION` stays 1.
   *
   *  Emitted only when the server's `issues-normalized-wire` feature flag is on;
   *  consumed only by a client that offered CAP_ISSUES_NORMALIZED. Both sides
   *  opt in, so the old path stays exactly one flag away. */
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('issueProjection'),
    id: z.string(),
    op: MetadataChangeOp,
    value: IssueProjection.optional(),
  }),
  /** An issue dependency EDGE [POD-822, ADR 4 D7.1] — `issue_deps` rows as
   *  first-class entities, keyed by their own primary key (`issueDepId`).
   *
   *  The relation the feed never carried. `IssueProjection` cannot hold `deps`
   *  without re-acquiring the cross-entity coupling it exists to shed (an edge
   *  belongs to two issues; see model's `issue/dep.ts`), so the edge is its own
   *  kind and the replica joins it. That is what makes `depAdd` cost O(1)
   *  server-side and still move `blocked` on both endpoints.
   *
   *  Same additive contract as 'issueProjection': gated on the server's
   *  `issues-normalized-wire` flag + the client's CAP_ISSUES_NORMALIZED, and
   *  invisible to a build whose `MetadataEntityKind` predates it — those rows
   *  fall to {@link UnknownMetadataChange}, are ignored, and the cursor advances.
   *  `WIRE_VERSION` stays 1 (ADR 2 D4). */
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('issueDep'),
    id: z.string(),
    op: MetadataChangeOp,
    value: IssueDepProjection.optional(),
  }),
  /** A logical repo [POD-822] — today just `(repoId, prefix)`, the join input
   *  for `displayRef`.
   *
   *  `prefix` is a function of the REPO, so materializing it onto every issue
   *  would make a prefix change rewrite every issue in the repo on the write
   *  path (D7.2). One repo row instead; the replica joins `issue.repoId →
   *  repo.prefix` and every `POD-13` in the repo moves at once. Same additive
   *  contract as the two kinds above. */
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('repo'),
    id: z.string(),
    op: MetadataChangeOp,
    value: RepoProjection.optional(),
  }),
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('conversation'),
    id: z.string(),
    op: MetadataChangeOp,
    value: ConversationSummaryWire.optional(),
  }),
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('automation'),
    id: z.string(),
    op: MetadataChangeOp,
    value: AutomationWire.optional(),
  }),
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('automationRun'),
    id: z.string(),
    op: MetadataChangeOp,
    value: AutomationRunWire.optional(),
  }),
])
export type MetadataChange = z.infer<typeof MetadataChange>
export const MetadataEntityKind = z.enum([
  'session',
  'issue',
  'issueProjection',
  'issueDep',
  'repo',
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
// Feed identity (ADR 2 D1/D5) rides every frame, but only for clients that sent
// `caps: ['syncFeedIdentity']` — a client without the cap gets today's frame
// byte-for-byte. Optional in the SCHEMA because the schema is also the consumer
// parser, and a consumer must accept a frame from an authority that predates
// this. Producers are strict: the server stamps all three or none.
export const MetadataDeltaMessage = z.object({
  type: z.literal('metadataDelta'),
  seq: z.number().int().positive(),
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
  changes: z.array(MetadataChangeLenient),
  ...FeedIdShape,
})
export type MetadataDeltaMessageLenient = z.infer<typeof MetadataDeltaMessageLenient>

// Result of the `sync.changesSince` catch-up query (defined here so the web app and
// SocketHub share one type without importing server internals). `snapshot` is
// returned for a null cursor (bootstrap) or a cursor older than the retained log
// (compaction) — it carries the full durable-entity state plus the cursor AS OF the
// read, taken in the same tick, so no change falls between snapshot and stream.
// Feed identity (ADR 2 D1/D5) rides BOTH arms, unconditionally: unlike the WS
// delta frame there is no hello here and therefore no caps to gate on, and
// stamping it is additive — an older client's zod parse STRIPS the unknown keys.
// The snapshot arm needs it most: a re-bootstrap is exactly where a replica
// learns which generation it is now on (D7 rungs 2-6 all terminate here).
export const SyncChangesSinceResult = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('delta'),
    changes: z.array(MetadataChange),
    cursor: z.number().int().nonnegative(),
    ...FeedIdShape,
  }),
  z.object({
    kind: z.literal('snapshot'),
    sessions: z.array(SessionMeta),
    issues: z.array(IssueWire),
    conversations: z.array(ConversationSummaryWire),
    diagnostics: z.array(ConversationDiagnosticWire),
    automations: z.array(AutomationWire).optional(),
    automationRuns: z.array(AutomationRunWire).optional(),
    cursor: z.number().int().nonnegative(),
    ...FeedIdShape,
  }),
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
      cursor: number
      feedId?: string
      epoch?: string
      minAvailableSeq?: number
    }
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
    ...FeedIdShape,
  }),
  z.object({
    kind: z.literal('snapshot'),
    sessions: z.array(SessionMeta),
    issues: z.array(IssueWire),
    conversations: z.array(ConversationSummaryWire),
    diagnostics: z.array(ConversationDiagnosticWire),
    automations: z.array(AutomationWire).optional(),
    automationRuns: z.array(AutomationRunWire).optional(),
    cursor: z.number().int().nonnegative(),
    ...FeedIdShape,
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
