/**
 * PER-USER STATE FAMILY — the personal PREFERENCE half (POD-1213).
 *
 * ---------------------------------------------------------------------------
 * THE MEMBER POD-1076 RECORDED AS ABSENT, AND WHY IT ARRIVES HERE
 * ---------------------------------------------------------------------------
 * `family.ts`'s {@link PER_USER_STATE_NON_MEMBERS} carried `personalPreferenceKeys`
 * with the reason *"one instance-wide `PodiumSettings` blob … splitting personal
 * keys from instance keys is POD-352's secrets/preferences work (Phase 3,
 * POD-418–421), which owns that surface"*. That boundary was right and it is the
 * one being honoured: POD-418 split the SHAPES, POD-419 moved the SECRETS,
 * POD-420 contracted the WRITES, and this issue moves the personal preference
 * VALUES. The non-member entry is deleted rather than amended, because the family
 * is a totality list and a member that has arrived must be counted by it.
 *
 * ---------------------------------------------------------------------------
 * THE ENTITY HALF IS A PREFERENCE PATH, NOT AN ENTITY ID
 * ---------------------------------------------------------------------------
 * Every other member keys `(userId, <some entity>)`. Here the second half is the
 * dotted settings path (`sidebar.repoSort`, `roles.coding.model`) — an address in
 * a vocabulary rather than a row in another table — so it composes
 * {@link perUserKeyOfString}, the same declined-brand wrapper `pin` and `tabOrder`
 * already use for a filesystem path. It is deliberately NOT a second
 * `z.object({ userId, key })`: the point of the shared fragment is that the user
 * half has ONE definition and ONE position.
 *
 * KEY-AT-A-TIME, NOT A PER-USER BLOB. One row per (person, path) rather than one
 * JSON document per person, for the reason this whole programme exists: a blob is
 * how twenty-four leaves came to share one authorization answer, one conflict
 * rule and one visibility class. Per-key rows make `roles.coding.model` and
 * `notifications.ntfyTopic` independently writable and independently
 * last-writer-wins, which is what ADR 4 Amendment 1 D10's field-LWW note asks of
 * a preference.
 *
 * WHICH KEYS MAY APPEAR IS NOT RESTATED HERE. The admissible set is
 * `settingsPathsInTier('personal-preference')` — POD-418's DERIVED classification —
 * and this schema deliberately does not re-enumerate it. A second list of paths is
 * the fork the classification was built to end; a validator that carried its own
 * copy would answer "is this personal" differently from the command contracts the
 * moment a leaf is added to `PersonalPreferences`.
 *
 * VALUES ARE JSON, and the schema says `unknown` rather than a union of the
 * leaf types. The leaf types are the model's (`PersonalPreferences` parses them,
 * and `normalizeSettings` is what refuses `hibernation.memoryPct = "abc"`), so a
 * union here would be a SECOND declaration of the value vocabulary sitting one
 * layer below the first. This member's claim is about the KEY, not the value.
 */

import { z } from 'zod'
import { perUserKeyOfString } from './session-state'

/**
 * ONE PERSON'S VALUE FOR ONE PERSONAL PREFERENCE PATH — `(userId, entityId)`
 * where `entityId` is the dotted path.
 *
 * An ABSENT ROW is "this person has never set it", and it resolves to the
 * instance blob's value (which, after the migration removed the personal members,
 * is the shape's own default). Absence is therefore meaningful and there is no
 * second spelling of it: a preference reset DELETEs the row rather than writing
 * the default back, so "never chosen" and "chose what happens to be the default"
 * stay distinguishable — the same rule `SessionReadState` states for `readAt`.
 */
export const PersonalPreferenceState = perUserKeyOfString().extend({
  /** The JSON value at this path. `unknown` on purpose — see the file header. */
  value: z.unknown(),
})
export type PersonalPreferenceState = z.infer<typeof PersonalPreferenceState>

/**
 * The preference-half members, as a list, so `family.ts` composes rather than
 * redeclares — the shape `SESSION_USER_STATE_MEMBERS` and
 * `ISSUE_USER_STATE_MEMBERS` already have.
 */
export const PREFERENCE_USER_STATE_MEMBERS = [
  {
    name: 'personalPreference',
    schema: PersonalPreferenceState,
    table: 'user_preferences',
  },
] as const
