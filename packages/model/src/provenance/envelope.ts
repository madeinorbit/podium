/**
 * The replica provenance envelope — POD-304, implementing ADR 4 D3.8 ("provenance
 * is not entity payload") and ADR 1 D7's envelope clause.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND THE ONE LINE THAT DECIDES WHAT MAY LIVE HERE
 * ---------------------------------------------------------------------------
 *
 * An envelope answers **how did this row reach this replica**. That is a fact
 * about a *delivery*, not about the row: it is computed at a replica boundary,
 * it is different for two replicas holding the same revision, and it is
 * legitimately DROPPABLE — a replica that forgets it has lost a UI hint, not a
 * piece of truth.
 *
 * Therefore, normatively (ADR 4 Amendment 1 D9.4, and the brief's obligation 9):
 *
 *   `owner`, `visibility`, `actor` and `on-behalf-of` MUST NOT live here.
 *
 * Those are authoritative facts ABOUT the row. They must survive bootstrap,
 * export and re-replication, and an authorization input that can be dropped at
 * a boundary is an authorization input that fails open. The same reasoning
 * settles the needs-human placement question POD-304 inherited:
 * `humanQuestionAskedBy` / `humanQuestionAskedAt` are **server-authoritative
 * attribution**, so they stay ENTITY data (they are already on the issue's
 * needs-human field group, and ADR 1's matrix §3 homes that group on the
 * server) — the envelope is the wrong lifetime for them. `envelope.test.ts`
 * holds that as an executable rule, not a comment.
 *
 * ---------------------------------------------------------------------------
 * THE FLAT ENCODING, AND WHY IT IS NOT A COMPROMISE
 * ---------------------------------------------------------------------------
 *
 * On today's wire the three flags ride FLAT on `SessionMeta` / `IssueWire`.
 * Nesting them under an `envelope` key is a wire change, and a wire change in
 * Phase 1 is exactly what POD-360's golden fixtures exist to stop: the
 * protocol cutover is POD-308's (Phase 2), and paying for it twice is the
 * failure this programme exists to end.
 *
 * So the split lands where it actually matters — at the DEFINITION sites:
 *
 *   - the entity schemas (`SessionMetaEntity`, `IssueWireEntity`) are
 *     provenance-free, which is the acceptance criterion;
 *   - the three flags are declared ONCE, here, instead of twice (they were
 *     hand-restated on both entities, with the doc comment on one pointing at
 *     the other — the drift pattern ADR 4 deletes);
 *   - the current wire projections compose entity + this group, keeping key
 *     ORDER identical, so `wire-golden.json` still passes untouched;
 *   - replica read sites go through {@link provenanceOf} and the predicates
 *     below rather than reaching into an entity field, so the read sites are
 *     already envelope-shaped when POD-308 nests the carrier.
 *
 * {@link ReplicatedEnvelope} is the nested target shape, defined and usable
 * now; {@link FLAT_PROVENANCE_KEYS} is what the wire carries until POD-308.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// The field group — one definition site.
// ---------------------------------------------------------------------------

/**
 * True for a row mirrored FROM this replica's upstream hub (node⇄hub sync,
 * `docs/spec/node-hub-sync.md` §2.3, `docs/spec/node-hub-issues.md` §2.1).
 * Stamped at ingest, never on locally-homed rows.
 */
const viaHub = z.boolean().optional()

/**
 * True when a `viaHub` row is last-known state from an UNREACHABLE hub —
 * retained, not blanked (spec §2.3 staleness semantics). Only ever set
 * alongside `viaHub`; locally-homed rows never carry it.
 */
const upstreamStale = z.boolean().optional()

/**
 * True while a replica-side edit of a `viaHub` row sits queued in the replica's
 * upstream outbox (hub unreachable) — the value shown is the replica's
 * optimistic patch; the hub's next delta/snapshot overwrites with truth and
 * clears this (`docs/spec/node-hub-issues.md` §2.2). Only ever set alongside
 * `viaHub`.
 */
const pendingSync = z.boolean().optional()

/**
 * The full provenance vocabulary. Every flag is optional and absent means
 * "locally homed, nothing to say" — the shape a replica with no upstream sees.
 */
export const ReplicatedProvenance = z.object({ viaHub, upstreamStale, pendingSync })
export type ReplicatedProvenance = z.infer<typeof ReplicatedProvenance>

/**
 * The flat encoding the wire carries TODAY, spread into an entity's shape at
 * its historical key position so the encoding is byte-identical.
 *
 * `SESSION_*` is deliberately narrower than `ISSUE_*`: `SessionMeta` has never
 * carried `pendingSync`, and widening a wire contract is not a refactor. Both
 * are `.pick()`s of one group, so the *meanings* cannot drift apart even while
 * the two encodings differ.
 */
export const ISSUE_FLAT_PROVENANCE_SHAPE = ReplicatedProvenance.shape
export const SESSION_FLAT_PROVENANCE_SHAPE = ReplicatedProvenance.pick({
  viaHub: true,
  upstreamStale: true,
}).shape

/** Every key the flat encoding may occupy on an entity payload. */
export const FLAT_PROVENANCE_KEYS = ['viaHub', 'upstreamStale', 'pendingSync'] as const
export type FlatProvenanceKey = (typeof FLAT_PROVENANCE_KEYS)[number]

// ---------------------------------------------------------------------------
// The envelope — the nested target shape (POD-308 moves the wire onto it).
// ---------------------------------------------------------------------------

/**
 * A row as a replica holds it: the entity, plus how it got here.
 *
 * Generic in the entity so there is ONE envelope for every replicated class
 * rather than a per-entity provenance story (the brief: "a single
 * `ReplicatedEnvelope<T>` type used at replica boundaries").
 */
export interface ReplicatedEnvelope<T> {
  readonly entity: T
  readonly provenance: ReplicatedProvenance
}

/** The zod builder for an envelope over a concrete entity schema. */
export const replicatedEnvelope = <S extends z.ZodTypeAny>(entity: S) =>
  z.object({ entity, provenance: ReplicatedProvenance })

// ---------------------------------------------------------------------------
// Replica read accessors — the boundary the UI reads through.
// ---------------------------------------------------------------------------

/** A row in either carrier: flat (today's wire) or nested (POD-308's). */
export type MaybeEnveloped<T> = T | ReplicatedEnvelope<T>

const isEnveloped = <T>(row: MaybeEnveloped<T>): row is ReplicatedEnvelope<T> =>
  typeof row === 'object' && row !== null && 'entity' in row && 'provenance' in row

/**
 * The provenance of a row, whichever carrier it arrived in. Accepts an
 * unknown-shaped row on purpose: a replica must be able to ask this of a
 * payload from a peer that predates (or postdates) the nesting.
 */
export function provenanceOf<T>(row: MaybeEnveloped<T>): ReplicatedProvenance {
  if (isEnveloped(row)) return row.provenance
  const flat = row as Partial<Record<FlatProvenanceKey, unknown>>
  const out: { -readonly [K in FlatProvenanceKey]?: boolean } = {}
  for (const key of FLAT_PROVENANCE_KEYS) {
    if (typeof flat?.[key] === 'boolean') out[key] = flat[key] as boolean
  }
  return out
}

/** The entity of a row, whichever carrier it arrived in. */
export function entityOf<T>(row: MaybeEnveloped<T>): T {
  return isEnveloped(row) ? row.entity : row
}

/** Split a flat row into the envelope shape POD-308 will carry. */
export function toEnvelope<T extends object>(row: MaybeEnveloped<T>): ReplicatedEnvelope<T> {
  if (isEnveloped(row)) return row
  const provenance = provenanceOf(row)
  const entity = { ...row } as Record<string, unknown>
  for (const key of FLAT_PROVENANCE_KEYS) delete entity[key]
  return { entity: entity as T, provenance }
}

/**
 * The three questions the UI actually asks. Named predicates rather than raw
 * field reads so the staleness indicators do not have to change again when the
 * carrier does.
 */
export const isViaHub = (row: MaybeEnveloped<unknown>): boolean =>
  provenanceOf(row).viaHub === true
export const isUpstreamStale = (row: MaybeEnveloped<unknown>): boolean =>
  provenanceOf(row).upstreamStale === true
export const isPendingSync = (row: MaybeEnveloped<unknown>): boolean =>
  provenanceOf(row).pendingSync === true
