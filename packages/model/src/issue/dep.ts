import { z } from 'zod'
import { IssueId } from '../ids'
import { dropNullValues, restoreNullValues, wireShape } from '../shape'

/**
 * THE issue dependency edge, as a first-class replicated entity [POD-822;
 * ADR 4 D7.1].
 *
 * ## Why an entity rather than a field on the issue
 *
 * `deps` is a RELATION (`issue_deps`, PK `(from_id, to_id, type)`), not a column
 * of `issues`. `wire.ts` and `aggregate.ts` both already refused to carry it, and
 * the refusal was not squeamishness about table shape — it is D7.2:
 *
 *   > A change to entity X may trigger recomputation only of projections of X.
 *
 * An edge belongs to TWO issues. Put it on the issue's projection and one of the
 * two must carry a field whose value depends on the other, so closing issue B
 * would have to recompute issue A's payload — the same cross-entity coupling
 * `sessions: SessionMeta[]` had, at a smaller constant. Modelling the edge as
 * its own entity is what makes an edge change cost O(1): `depAdd` upserts ONE
 * `IssueDepProjection` and nothing else re-derives server-side. The replica
 * joins the edges it holds against the issues it holds (D7.3) and computes
 * `blocked` / `ready` / `dependents` locally, where the join is free.
 *
 * ## `dependents` is not here, and cannot be
 *
 * `dependents` is the REVERSE index of `deps` — the same rows read the other way
 * round. `aggregate.ts` settled it already ("it is the REVERSE index of `deps`
 * and can only ever be replica-side"), and this entity is what makes that true
 * rather than aspirational: a replica holding the edge set can index it by
 * `toId` as cheaply as by `fromId`. Emitting a second, reversed copy would be
 * two spellings of one edge with nothing to arbitrate between them — the exact
 * defect `memberSessionIds` was deleted for (see `issue-views.ts`).
 *
 * ## No `revision`, deliberately
 *
 * Every other replicated entity carries one [ADR 2 D3]; this one does not, and
 * the asymmetry is honest rather than an oversight. An edge has NO MUTABLE
 * STATE: `(fromId, toId, type)` is the entire row AND its primary key, so there
 * is no field a write could change and no "is my write based on current truth?"
 * question to ask — the edge exists or it does not, and upsert/remove is its
 * whole lifecycle. A revision here could only ever read `1`.
 *
 * Nor is one needed for concurrency: `depAdd`/`depRemove` take
 * `expectedRevision` against the FROM ISSUE (registry.ts, `concurrency:
 * EXPECTED_REVISION`, `target: (i) => i.fromId`), which is where ADR 1's matrix
 * already puts the precondition. Minting a second token on the edge would give
 * two answers to one question.
 */

/**
 * The edge's identity — derived, not minted, from its primary key.
 *
 * A synthetic random id would be a second identity for a row that already has
 * one: sqlite keys `issue_deps` on `(from_id, to_id, type)`, and
 * `addIssueDep` is an `INSERT OR IGNORE` on exactly that key. So the same edge
 * added twice is ONE row in the store, and an id minted per-call would make it
 * two on the feed — a phantom the store can never remove, because `depRemove`
 * deletes by the key and would only ever know one of the ids.
 *
 * Deriving the id from the key makes the feed's identity and the store's the
 * same identity by construction, which also makes the emission idempotent for
 * free: re-adding an existing edge produces a byte-identical row that the
 * ledger's dedup drops (change-log.ts), so a no-op write appends no change.
 */
export const IssueDepId = z.string().min(1).brand<'IssueDepId'>()
export type IssueDepId = z.infer<typeof IssueDepId>
export const asIssueDepId = (s: string): IssueDepId => s as IssueDepId

/** The separator in a composed {@link issueDepId}. `|` is not in the id grammar
 *  (`iss_${randomUUID()}` — hex and hyphens) nor in any dep type (lowercase and
 *  hyphens), which is what {@link issueDepId} verifies rather than assumes. */
const DEP_ID_SEP = '|'

/**
 * The dep type — an OPEN string, matching the durable column.
 *
 * `@podium/protocol` lists eight known types in `ISSUE_DEP_TYPES`, but nothing
 * enforces them: `issue_deps.type` is `TEXT NOT NULL DEFAULT 'blocks'` with no
 * CHECK, `addIssueDep(from, to, type = 'blocks')` accepts any string, and the
 * `depAdd` command's input is `z.string().optional()`. So an enum here would
 * refuse durable rows this slice does not own — the same reasoning `Timestamp`
 * records for not being a strict datetime. The one type the service REJECTS
 * ('parent-child', owned by `reparent`) is rejected where that rule lives, in
 * `crud.ts`, not restated here.
 */
export const IssueDepType = z.string().min(1)
export type IssueDepType = z.infer<typeof IssueDepType>

/**
 * Compose an edge's id from its primary key. The inverse is
 * {@link parseIssueDepId}.
 *
 * Throws on a component containing the separator rather than composing an
 * ambiguous id. This is a refuse-don't-fabricate seam of the same class as
 * `projection.ts`'s missing-revision throw, and for a sharper reason: a
 * colliding id does not fail, it MERGES — two genuinely different edges would
 * land on one ledger row, and removing either would remove the other's row from
 * every replica. Ids are `iss_${randomUUID()}` in production, so this cannot
 * fire from the mint path; it guards the caller-supplied `input.id` on create
 * and any hub-mirrored id whose grammar is not ours.
 */
export function issueDepId(fromId: string, toId: string, type: string): IssueDepId {
  for (const [name, part] of [
    ['fromId', fromId],
    ['toId', toId],
    ['type', type],
  ] as const) {
    if (part.includes(DEP_ID_SEP)) {
      throw new Error(
        `issue dep ${name} ${JSON.stringify(part)} contains ${JSON.stringify(DEP_ID_SEP)}, the ` +
          'dep-id separator — refusing to compose an ambiguous edge id, which would silently ' +
          'merge two different edges onto one feed row.',
      )
    }
  }
  return `${fromId}${DEP_ID_SEP}${toId}${DEP_ID_SEP}${type}` as IssueDepId
}

/** Split a composed {@link issueDepId} back into its key. `null` when the id was
 *  not composed by `issueDepId` — a consumer that reads its parts must handle a
 *  foreign spelling rather than index blindly into a split. */
export function parseIssueDepId(id: string): { fromId: string; toId: string; type: string } | null {
  const parts = id.split(DEP_ID_SEP)
  if (parts.length !== 3) return null
  const [fromId, toId, type] = parts as [string, string, string]
  if (!fromId || !toId || !type) return null
  return { fromId, toId, type }
}

/**
 * THE dep-edge vocabulary [ADR 4 D1]. Every representation of an edge composes
 * from this one group.
 *
 * All three references are branded ids (D3.5, D7.1's "references other entities
 * by branded id only"). Note `id` is REDUNDANT with `(fromId, toId, type)` by
 * construction — it is the composed key, carried because the feed addresses
 * entities by a single id and a consumer should never have to re-derive its own
 * addressing. {@link parseIssueDepId} exists so the redundancy stays checkable.
 */
export const issueDepShape = {
  /** The composed primary key — see {@link issueDepId}. */
  id: IssueDepId,
  /** The DEPENDENT: the issue that is blocked / related / superseded. */
  fromId: IssueId,
  /** The DEPENDED-UPON: what `fromId` waits for. `blocked` means this one is not
   *  done yet. */
  toId: IssueId,
  type: IssueDepType,
} as const

/** **R1** — the canonical durable dep edge [ADR 4 D2]. One `issue_deps` row. */
export const IssueDep = z.object(issueDepShape)
export type IssueDep = z.infer<typeof IssueDep>

/** **R4** — the dep edge's wire/read projection [ADR 4 D2]. Identical to R1: the
 *  group has no nullable field, so `wireShape` is the identity here. It is
 *  applied anyway rather than skipped, so that a nullable field added to the
 *  group later gets the wire encoding by construction (D3.3) instead of by
 *  someone remembering to. */
export const IssueDepProjection = z.object(wireShape(issueDepShape))
export type IssueDepProjection = z.infer<typeof IssueDepProjection>

/**
 * **The dep-edge mapping pair** [ADR 4 D3.4 — "one documented store-row ↔ wire
 * mapping function per entity … Mapping is code, not tribal knowledge"].
 *
 * Both directions are the IDENTITY today, because the group has no nullable
 * field for the null↔absent convention to act on. They are written as the
 * convention applied (`dropNullValues` / `restoreNullValues`) rather than as
 * `x => x` for the same reason `wireShape` is applied above: the day a nullable
 * field joins `issueDepShape`, its encoding follows by construction (D3.3)
 * instead of by someone noticing that two identity functions had stopped being
 * identities.
 *
 * There is no `toStorage`/`fromStorage` half, and that is not a gap: `issue_deps`
 * columns ARE `(from_id, to_id, type)`, so R1 and R3 coincide and a pair would
 * be two more identities. The one encoding the store does not have — the
 * composed `id` — is {@link issueDepId}, whose inverse is
 * {@link parseIssueDepId}; that IS this entity's store↔wire mapping, and it is
 * the pair the round-trip test exercises.
 */
export const issueDepToWire = (dep: IssueDep): IssueDepProjection =>
  IssueDepProjection.parse(dropNullValues(dep))

/** R4 → R1. The inverse of {@link issueDepToWire}. */
export const issueDepFromWire = (projection: IssueDepProjection): IssueDep =>
  IssueDep.parse(restoreNullValues(projection, issueDepShape))
