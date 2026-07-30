/**
 * `PerUserKey` — the ONE `(userId, entityId)` key fragment (POD-365).
 *
 * ADR 4 Amendment 1 D10: state that belongs to a person *about* an entity is its
 * own R1 aggregate keyed `(userId, entityId)`, *"composed from ONE shared key
 * fragment in `packages/model`"* — not a `user_id` bolted onto one table, a JSON
 * blob on another and a singleton left behind on a third. `pins`, `tab_order`,
 * `session_drafts`, `snoozes` and the three `read_at` columns each invented their
 * own keying; under this rule they compose this fragment, so adding the user
 * dimension is one change and not five.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE DEFINES THE KEY. POD-1076 DEFINES THE FAMILY.
 * ---------------------------------------------------------------------------
 *
 * The eleven members (`readAt` × 3, snooze, tuck-away, pins × 2, tab order,
 * layout, preference keys, replica cursor) are enumerated in
 * `docs/rearch-field-schema-inventory.md` §7.1 and are POD-1076's to land, with
 * §7.2's three open questions recorded there and NOT reopened here. What POD-365
 * owes that work is exactly two things:
 *
 *   1. this fragment, so there is one convention to compose rather than a second
 *      one invented alongside it, and
 *   2. the guarantee that **not one of those members is a field on the canonical
 *      aggregates** — enforced by `aggregates/registry.test.ts`, not asserted in
 *      a comment. A leftover singleton is later a table migration PLUS a wire
 *      change PLUS a replica migration.
 *
 * THE ENCODING IS POD-301'S, NOT A NEW ONE. `userEntityKey` /
 * `parseUserEntityKey` in `../ids/keys.ts` already exist and are re-exported
 * below so a consumer reaching for "how do I key this" finds one answer. Do not
 * write a second `${userId}:${entityId}` anywhere; that is the ad-hoc composite
 * key POD-301 exists to delete.
 */

import { z } from 'zod'
import { UserIdField } from '../ids'
import { type EntityRef, parseUserEntityKey, userEntityKey } from '../ids/keys'

export { parseUserEntityKey, userEntityKey }
export type { EntityRef }

/**
 * The key fragment, generic over which entity the row is about.
 *
 * A factory rather than a fixed `entityId: string`, because the whole value of
 * the fragment is that the entity half stays BRANDED: `perUserKey(SessionIdField)`
 * and `perUserKey(IssueIdField)` produce two shapes that cannot be mixed up, over
 * one definition. Flattening it to a raw string here would reintroduce, in the
 * one shared fragment, exactly the untyped keying it exists to replace.
 *
 * Usage (POD-1076):
 *
 *   const SessionReadState = perUserKey(SessionIdField).extend({
 *     readAt: z.string().nullable(),
 *   })
 *
 * Note what is absent: no `visibility` field. Per-user state is `per-user-state`
 * by class (ADR 9 D3) and non-grantable BY CONSTRUCTION (D3 rule 4 — there is no
 * "share my read state" verb), so the class is a matrix annotation on the family
 * and never a per-row value a writer could set wrong.
 */
export const perUserKey = <T extends z.ZodTypeAny>(entityId: T) =>
  z.object({
    /** The person this row belongs to. Also its owner, resolved
     *  `the-user-in-the-key` on the matrix — the row is created by and for them. */
    userId: UserIdField,
    /** The entity the state is ABOUT. Branded by the caller's field schema. */
    entityId,
  })

/** The un-parameterised shape, for code that only needs the user half's position
 *  (the matrix row, a totality test, documentation). Prefer {@link perUserKey}. */
export const PerUserKey = z.object({ userId: UserIdField, entityId: z.string() })
export type PerUserKey = z.infer<typeof PerUserKey>
