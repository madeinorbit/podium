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
