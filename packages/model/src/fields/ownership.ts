/**
 * `Ownership` — the owner + visibility-class field group (POD-365).
 *
 * ADR 4 Amendment 1 D9.2: *"An ownership field group (owner + visibility class +
 * the grant edge shape) is ONE field group, composed by every representation of
 * an owned class."* ADR 9 D2 owns what the words mean; ADR 1's amended matrix
 * owns the per-class values; this file owns only the shape.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DEFINE, AND WHY THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * - **The visibility-class vocabulary.** It already exists, as the closed
 *   five-member ADR 9 D3 set POD-304 landed in `../annotations/ownership.ts`
 *   together with `visibilityClassOf`'s default-closed resolver. This file
 *   derives its zod enum from that one list ({@link VISIBILITY_CLASSES}) rather
 *   than restating five string literals, so "there is one visibility vocabulary"
 *   is a structural fact and not a convention two files agree to follow.
 *
 * - **The grant edge.** ADR 9 D2 makes a grant `(entityRef, granteeUserId,
 *   verb)` — its OWN aggregate, not a field on the granted row, which is why
 *   `Ownership` has no `grants` member: sessions and issues reference grants,
 *   they never embed them (ADR 4 D7.1). Its aggregate is POD-1075's; its key
 *   encoding already exists as `subjectResourceKey` / `parseSubjectResourceKey`
 *   in `../ids/keys.ts`, and its verb vocabulary as `GrantVerb` in
 *   `../annotations/ownership.ts`. Defining a second grant shape here to
 *   "unblock" the aggregates would be exactly the fork this issue was told not
 *   to make — and nothing here needs one.
 *
 * - **Any effective-capability snapshot.** See the directory README rule 4.
 *   Effective rights are resolved live at apply time (ADR 9 D5 A1 / ADR 3 D8);
 *   a serializable one is a privilege leak with no cleanup trigger.
 *
 * - **An instance partition.** ADR 1 D5 stands and ADR 9 §1.2 restates it: the
 *   dimension multi-user adds is OWNER, not tenant. There is no `instanceId`
 *   here, and `annotations/matrix.test.ts` already fails a row that smuggles one
 *   in as a column value.
 */

import { z } from 'zod'
import { VISIBILITY_CLASSES, type VisibilityClass } from '../annotations/ownership'
import { UserIdField } from '../ids'

/**
 * ADR 9 D3's five visibility classes, in field position.
 *
 * Named `VisibilityClassField` rather than `VisibilityClass` because the TYPE of
 * that name is already exported by `../annotations/ownership.ts` and there must
 * be exactly one of it: `z.infer<typeof VisibilityClassField>` IS that type,
 * pinned below rather than asserted in a comment.
 *
 * There is no `unset` member and no `.optional()` on the field it lands in. An
 * entity class that fails to declare resolves to `personal` through
 * `visibilityClassOf` (ADR 9 D4), which is a resolution rule for a MISSING
 * declaration — never a sixth value a row can carry.
 */
export const VisibilityClassField = z.enum(VISIBILITY_CLASSES)

/** Compile-time pin: the zod enum and the annotation vocabulary are one set.
 *  Widening either without the other stops this assignment from typechecking. */
const _visibilityClassIsOneVocabulary: VisibilityClass = null as unknown as z.infer<
  typeof VisibilityClassField
>
void _visibilityClassIsOneVocabulary

/**
 * The ownership field group, composed by every owned aggregate.
 *
 * `owner` is REQUIRED HERE — on the canonical R1 aggregate, where "an owned row
 * has exactly one owner" (ADR 9 D2) is unconditionally true. That is deliberately
 * not a claim about every projection of it: a scoped R4 shape that suppresses the
 * owner composes `Ownership.partial()` or omits the key, and its own golden
 * fixtures are the gate. See the directory README rule 2 — hardcoding a field as
 * required *everywhere* is precisely how principal-dependent projection would
 * have been made inexpressible.
 *
 * `visibility` is likewise required and non-nullable: a class that could carry
 * "no declared visibility" on the wire would fail OPEN the moment a reader
 * treated absence as permissive, which is the failure mode ADR 9 D4 exists to
 * prevent.
 */
export const Ownership = z.object({
  /** Exactly one person (ADR 9 D2). For anything an agent created this is its
   *  `onBehalfOf` human, never the agent — D5 A4, so your own agent's work shows
   *  on your sidebar and retiring an agent session does not orphan its issues. */
  owner: UserIdField,
  /** Which of ADR 9 D3's five classes this row belongs to. Answers "who may see
   *  this at all", before any grant is consulted (D2 rule 2). */
  visibility: VisibilityClassField,
})
export type Ownership = z.infer<typeof Ownership>

/**
 * THE OWNER, AS EVERY SURFACE SPELLS IT: `assignee`.
 *
 * ADR 9 Amendment 1 D1/D10: there is ONE accountable human per task, it is
 * {@link Ownership.owner}, and the word the product uses for it is **Assignee**.
 * This function is the whole of that projection, and it exists so the rename has
 * exactly one home.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS HERE INSTEAD, AND WHY A FUNCTION REPLACED IT
 * ---------------------------------------------------------------------------
 *
 * `IssueTriage.assignee` — an INDEPENDENTLY MUTABLE OPTIONAL `UserId`, stored in
 * its own `issues.assignee` column, beside `issues.owner_user_id`. Two columns,
 * two write paths, one question. Storage let them diverge and two of the live
 * writers made sure they did:
 *
 *   - `IssueService.claim` set `{ assignee, stage }` together, so an AGENT
 *     claiming work reassigned the accountable human as a side effect of saying
 *     "I am working on this" — the exact act D2 forbids ("agents never reassign
 *     humans");
 *   - `IssueService.start` wrote `asUserId(\`agent:${defaultAgent}\`)` into it —
 *     an agent LABEL cast into the branded user id space, standing where a person
 *     belongs. The cast carried a comment saying the adjudication was somebody
 *     else's. This is that adjudication: it is not a user, it never was, and the
 *     slot it was written into is gone.
 *
 * The fix is not validation on the second column. It is that there is no second
 * column: `assignee` is now a READ of `owner`, so "owner and assignee disagree"
 * is not a state the storage layer can hold, and no API path can put an agent
 * label in it because no API path writes it at all.
 *
 * Deliberately NOT a schema. A zod `AssigneeField` would be a second FIELD
 * DEFINITION for the same fact, which is the shape this issue deletes — and a
 * projection that merely renames a key needs a function, not a type. Wire shapes
 * that carry the key compose `Ownership.shape.owner` itself (see
 * `entities/issue.ts`), so the brand and the instance are the same one.
 */
export const assigneeOf = (row: Pick<Ownership, 'owner'>): Ownership['owner'] => row.owner

/**
 * THE WIRE'S SPELLING OF THE OWNER — `assignee`, optional, wrapping the SAME
 * schema instance.
 *
 * `.optional()` and not required, and the reason is tolerance rather than
 * doctrine. `Ownership.owner` is required on R1 and `issues.owner_user_id` is
 * `NOT NULL`, so a current server always sends a value. What a required wire
 * field would break is everything that ALREADY EXISTS without one: payloads
 * cached by a client before this landed, and peers still on the previous wire
 * version. Making those fail to parse would turn a projection into an outage, and
 * `fields/README.md` rule 2 is explicit that requiredness is declared at R1 where
 * the fact is unconditionally true, never inherited as a constraint on every
 * projection.
 *
 * Absent therefore means "this payload predates the projection", never
 * "unassigned" — there is no such state. A reader that renders absence as
 * *Unassigned* is showing an artefact of its own cache.
 *
 * DEFINED HERE AND EXPORTED, rather than spelled `Ownership.shape.owner.optional()`
 * at the wire, because each such call builds a NEW `ZodOptional`. Two wire shapes
 * that each built their own would be two definitions of one fact — the exact fork
 * this file's header refuses — and no `toBe` assertion anywhere could see it,
 * since both wrap the same inner schema and encode identically. One instance, and
 * `issue-composition.test.ts` pins BOTH that the wire key is this instance and
 * that `.unwrap()` is `Ownership.shape.owner` itself.
 */
export const OwnerAsAssigneeField = Ownership.shape.owner.optional()

/**
 * The one sentence every surface that renders "Assignee" is written against,
 * named so it can be cited from a store, a projection and a migration without
 * three paraphrases of it.
 */
export const ASSIGNEE_IS_THE_OWNER =
  'Assignee IS the canonical owner (ADR 9 Amendment 1 D1/D10). There is no second owner field: the ' +
  'independently mutable `issues.assignee` column was retired by A2 after its legacy values were ' +
  'inventoried, and the wire key is a projection of `owner`. An agent label is not a person and ' +
  'never becomes one; agents never reassign humans (D2).'
