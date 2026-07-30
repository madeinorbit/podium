/**
 * THE GRANT EDGE — `(entityRef, granteeUserId, verb)` (POD-1075).
 *
 * ADR 9 D2: *"an edge table `(entityRef, granteeUserId, verb)`. A grant WIDENS
 * what a grantee may do; it can never widen past the granter's own rights, and
 * it never widens past the entity's visibility class rules."* ADR 1's matrix
 * carries it as `ROW.grantEdge` and `fields/ownership.ts` already recorded that
 * the aggregate is this issue's: *"a grant is its OWN aggregate, not a field on
 * the granted row, which is why `Ownership` has no `grants` member — sessions
 * and issues REFERENCE grants, they never embed them (ADR 4 D7.1)."*
 *
 * ---------------------------------------------------------------------------
 * AN EDGE IS NOT A CAPABILITY, AND THE DIFFERENCE IS THE WHOLE FILE
 * ---------------------------------------------------------------------------
 *
 * ADR 9 D2 rule 4 states it in one sentence: *"A grant is not a copy of rights.
 * It is evaluated live against the granter's CURRENT rights, for the same reason
 * D5/A1 gives for delegation: a frozen grant survives the revocation of the
 * person who issued it."*
 *
 * So what is stored here is deliberately thin: WHO gave WHOM WHICH VERB on WHAT.
 * It is an input to a decision, never the decision. Concretely, three fields
 * that a "grants" table usually grows are absent, each on purpose:
 *
 *   - no `effectiveRights` / `allowed` / resolved permission set. That is the
 *     snapshot ADR 9 D5 A1 rejects by name; the answer is computed at every apply
 *     from this edge, the entity's current owner, and the granter's current
 *     standing (ADR 3 D8).
 *   - no `expiresAt`. An expiry is a second revocation path with its own reaper
 *     to write and to forget. Revocation is removing the edge, and the removal
 *     is itself a durable change with a global `seq` — which is exactly what the
 *     Phase 2 watermark/rescope signal anchors on (the matrix row says so).
 *   - no `inheritedFrom`. Whether a child inherits its parent's grants is ADR 9
 *     §3 **O4**, open and per-class; the matrix carries the annotation column
 *     (`inheritanceOnCreate`) and answering it here would pre-empt it.
 *
 * ---------------------------------------------------------------------------
 * THE VERB SET IS ADR 9's, NOT A NEW ONE
 * ---------------------------------------------------------------------------
 *
 * {@link GrantVerbField} derives from `GRANT_VERBS` in
 * `../annotations/ownership.ts` — the same list the matrix annotates rows with —
 * so "there is one verb vocabulary" is structural rather than a convention two
 * files agree to follow. `use` is a CODE-EXECUTION boundary (ADR 9 D6 M2) and
 * must never be treated as a louder `read`: it means arbitrary execution on
 * someone's hardware with their SSH keys, `gh` identity and checked-out private
 * repositories. Which verbs a class admits is the matrix's `grants` column, and
 * `grantVerbsOf` resolves it; this schema is what a granted edge LOOKS like.
 */

import { z } from 'zod'
import { GRANT_VERBS } from '../annotations/ownership'
import { Attribution } from '../fields/attribution'
import { Ownership } from '../fields/ownership'
import { UserIdField } from '../ids'
import { ENTITY_KINDS } from '../ids/keys'

/**
 * ADR 9 D2 / D6's five verbs, in field position.
 *
 * Named `GrantVerbField` rather than `GrantVerb` because the TYPE of that name
 * is already exported by `../annotations/ownership.ts` and there must be exactly
 * one of it — the same naming split `VisibilityClassField` uses, and for the
 * same reason.
 */
export const GrantVerbField = z.enum(GRANT_VERBS)

/**
 * WHAT a grant is on. A flat `(kind, id)` pair rather than a schema for
 * `EntityRef`, and that is deliberate: `ids/keys.ts` records that `EntityRef` is
 * *"A TYPE, NOT A SCHEMA, and deliberately so"* — a second zod enum of entity
 * kinds would be the drift class Phase 1 exists to delete. This derives its
 * members from `ENTITY_KINDS`, the SAME list `EntityRef` and the key
 * constructors are checked against, so a kind added there is admitted here
 * automatically and one removed there stops parsing here.
 *
 * The flat pair also matches the stored key: `subjectResourceKey` encodes
 * `[subject.kind, subject.id, resource.kind, resource.id]`, so this schema is
 * the parsed form of the key the edge is stored under rather than a second
 * description of the same thing.
 */
export const GrantResource = z.object({
  resourceKind: z.enum(ENTITY_KINDS),
  resourceId: z.string(),
})
export type GrantResource = z.infer<typeof GrantResource>

/**
 * The canonical durable grant edge — ADR 1 matrix row `grant-edge`.
 *
 * ---------------------------------------------------------------------------
 * THE GRANTER IS THE `owner`, AND IS NOT A SECOND COLUMN
 * ---------------------------------------------------------------------------
 *
 * The matrix resolves this row's owner as `granter`, with the reason attached:
 * *"a grant may never exceed its granter's own rights (ADR 9 D2 rule 4), so the
 * GRANTER is the accountable party."* So the granter is stored in the ONE place
 * every owned class stores its accountable person — the composed `Ownership`
 * group — rather than in a `granter` field beside it.
 *
 * A first draft of this file had both, and `registry.test.ts` caught it: two
 * columns holding one fact is precisely the drift this phase exists to delete,
 * and the failure mode is not hypothetical — the day they disagree, the live
 * evaluation reads one of them and the audit trail shows the other. "Who is the
 * granter" is answered by `owner`, and WHY that is the granter is the matrix's
 * `resolves: 'granter'` annotation, which is where a per-class rule belongs.
 *
 * What is stored is not a right. It is the identity whose CURRENT standing the
 * live evaluation must consult, which is what makes "this grant was issued by
 * someone who has since been revoked" answerable at apply time (ADR 3 D8);
 * without it the edge would be indistinguishable from one issued by the instance
 * itself, and would survive its issuer.
 */
export const GrantEdge = GrantResource.extend(Ownership.shape).extend({
  /** WHOM. ADR 9 D2 defers group grantees as *"an additive change to the
   *  grantee column"*, so this is a `UserId` today; `ids/keys.ts`'s
   *  `GrantSubject` is the discriminated-union-of-one that makes adding a
   *  `group` arm a compile error at every match rather than a silent widening. */
  grantee: UserIdField,
  /** WHICH VERB (ADR 9 D2 / D6 M1). */
  verb: GrantVerbField,
  createdAt: z.string(),
  /** WHICH PRINCIPAL performed the share. Distinct from `owner` (the granter)
   *  and not redundant with it: an agent may perform a share on behalf of its
   *  human, in which case the ACTOR is the agent and the granter is the human
   *  (ADR 9 D5 A3/A4). Collapsing them would make "did a person or an agent
   *  share this?" unanswerable — the question the attribution pair exists for,
   *  and the one place where the actor and the accountable party genuinely
   *  differ on this row. */
  createdBy: Attribution,
})
export type GrantEdge = z.infer<typeof GrantEdge>
