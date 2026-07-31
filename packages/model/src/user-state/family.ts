/**
 * THE PER-USER STATE FAMILY, as one list (POD-1076).
 *
 * ADR 9 D3 rule 4's class, ADR 4 Amendment 1 D10's key, and
 * `docs/rearch-field-schema-inventory.md` §7.1's enumeration meet here. The list
 * exists so a totality test can assert the SET — every member composes the ONE
 * `perUserKey` fragment, no member carries a `visibility` field, no member is a
 * field on a canonical aggregate — instead of each member being checked by
 * whoever remembered to.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN, AND WHAT §7.1's ELEVEN ROWS REDUCE TO
 * ---------------------------------------------------------------------------
 * §7.1 lists eleven FACTS. They land as six SCHEMAS, and the reduction is
 * recorded here rather than left for a reader to re-derive:
 *
 *   - the three `readAt` members are three schemas, because they are three
 *     entities (`session_user_state`, `issue_user_state`, `issue_message_user_state`);
 *   - tuck-away, the issue pin flag and issue `readAt` are ONE schema, because
 *     they are one key with three values (`IssueUserState`);
 *   - snooze, pins and tab order are POD-380's three, unchanged;
 *   - the sidebar/tab/pane layout is CLIENT-LOCAL and has no server row. It is
 *     `per-user-state` by class and already per-user by construction (one
 *     browser profile is one person), so it needs no re-key — §7.1 calls it
 *     "the cheapest member" for exactly this reason. Recorded as excluded, not
 *     forgotten.
 *   - personal PREFERENCE KEYS were recorded here as a deliberate NON-member at
 *     POD-1076, because they were one instance-wide `PodiumSettings` blob and
 *     splitting them belonged to POD-352's secrets/preferences work. **POD-1213
 *     is that split**, and the member has therefore MOVED into the family
 *     (`./preference-state.ts`) rather than staying an entry with an amended
 *     reason. A totality list whose absent members quietly stay absent after
 *     arriving is the stale-claim failure this file exists to prevent, so the
 *     count below moves with the storage.
 *   - the client outbox / replica cursor is DEVICE-local and never replicated
 *     (ADR 1 Am1 §10). Per-user by class, no server row, no re-key.
 *
 * So: seven schemas here, two members excluded WITH a reason, and the reasons are
 * the part a later reader needs — an unexplained absence from a totality list is
 * indistinguishable from a member somebody forgot.
 */

import type { z } from 'zod'
import { ISSUE_USER_STATE_MEMBERS } from './issue-state'
import { PREFERENCE_USER_STATE_MEMBERS } from './preference-state'
import { SESSION_USER_STATE_MEMBERS } from './session-state'

export interface PerUserStateMember {
  /** The member's name in this family. */
  readonly name: string
  /** Its schema — every one composes `perUserKey`. */
  readonly schema: z.ZodObject<z.ZodRawShape>
  /** The physical table its rows live in. Empty string is not representable:
   *  a member with no table belongs in {@link PER_USER_STATE_NON_MEMBERS}. */
  readonly table: string
}

/** Every member with a server-side table: session half, issue half, then the
 *  personal preference half POD-1213 moved off the settings singleton. */
export const PER_USER_STATE_FAMILY: readonly PerUserStateMember[] = [
  ...SESSION_USER_STATE_MEMBERS,
  ...ISSUE_USER_STATE_MEMBERS,
  ...PREFERENCE_USER_STATE_MEMBERS,
]

/**
 * §7.1 facts that are `per-user-state` BY CLASS but have no server row to re-key,
 * each with the reason. A list rather than prose so the count is checkable: §7.1's
 * eleven facts = {@link PER_USER_STATE_FAMILY}'s members (which cover nine of
 * them) plus these two.
 *
 * `personalPreferenceKeys` LEFT this list at POD-1213, when the storage it said
 * did not exist was built. That is the intended lifecycle of an entry here: a
 * non-member with a reason is a claim about today, and when the reason stops
 * being true the entry moves rather than being rewritten.
 */
export const PER_USER_STATE_NON_MEMBERS = [
  {
    name: 'sidebarAndTabLayout',
    reason:
      'CLIENT-LOCAL (EngineState UI keys + the `ui` store). Already per-user by construction — ' +
      'one browser profile is one person — so there is no shared row to re-key. §7.1 calls it ' +
      'the cheapest member for this reason.',
  },
  {
    name: 'clientOutboxAndReplicaCursor',
    reason:
      'DEVICE-local and never replicated (ADR 1 Amendment 1 §10). Per-user by class, no server ' +
      'row, nothing to move.',
  },
] as const
