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
 * §7.1 lists eleven FACTS. They land as schemas here, and the reduction is
 * recorded rather than left for a reader to re-derive:
 *
 *   - the three `readAt` members are three schemas, because they are three
 *     entities (`session_user_state`, `issue_user_state`, `issue_message_user_state`);
 *   - tuck-away, the issue pin flag and issue `readAt` are ONE schema, because
 *     they are one key with three values (`IssueUserState`);
 *   - snooze, pins and tab order are POD-380's three, unchanged;
 *   - the sidebar/tab layout is a server row as of POD-1350 (`user_layout`,
 *     key-at-a-time). It was client-local under single-operator and is recorded
 *     here as a member once storage exists — the same lifecycle
 *     `personalPreferenceKeys` took at POD-1213. Device-local route, selection,
 *     focus, transient toggles and pane/split geometry stay OUT of this member
 *     (see `./layout-state.ts`'s {@link DEVICE_LOCAL_UI_KEYS}).
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
 * So: eight schemas here, one member excluded WITH a reason, and the reasons are
 * the part a later reader needs — an unexplained absence from a totality list is
 * indistinguishable from a member somebody forgot.
 *
 * ---------------------------------------------------------------------------
 * ONE MEMBER §7.1 DID NOT ENUMERATE (POD-1380)
 * ---------------------------------------------------------------------------
 * `issueEventReadCursor` (`./read-position-state.ts`) is NOT one of §7.1's eleven
 * facts. It was found by POD-403's totality exercise over CLIENT ui-state, not by
 * the field-schema inventory over SERVER storage, because it had no server row to
 * be inventoried — it lived only in a browser. It joins the family for the reason
 * §3.3 gives for every `readAt`: read state follows the person. The count above
 * therefore describes §7.1's reduction, and this member is counted separately
 * rather than being quietly absorbed into it — a totality claim that grows a
 * member without saying where it came from is the stale-claim failure again.
 */

import type { z } from 'zod'
import { READ_POSITION_USER_STATE_MEMBERS } from './read-position-state'
import { ISSUE_USER_STATE_MEMBERS } from './issue-state'
import { LAYOUT_USER_STATE_MEMBERS } from './layout-state'
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

/** Every member with a server-side table: session half, issue half, preference
 *  half, the layout half POD-1350 moved off client-local ui-state, then the
 *  event-stream cursor POD-1380 moved off it. */
export const PER_USER_STATE_FAMILY: readonly PerUserStateMember[] = [
  ...SESSION_USER_STATE_MEMBERS,
  ...ISSUE_USER_STATE_MEMBERS,
  ...PREFERENCE_USER_STATE_MEMBERS,
  ...LAYOUT_USER_STATE_MEMBERS,
  ...READ_POSITION_USER_STATE_MEMBERS,
]

/**
 * §7.1 facts that are `per-user-state` BY CLASS but have no server row to re-key,
 * each with the reason. A list rather than prose so the count is checkable: §7.1's
 * eleven facts = {@link PER_USER_STATE_FAMILY}'s members (which cover ten of
 * them once layout arrived) plus this one.
 *
 * `personalPreferenceKeys` LEFT this list at POD-1213; `sidebarAndTabLayout`
 * LEFT at POD-1350. That is the intended lifecycle of an entry here: a
 * non-member with a reason is a claim about today, and when the reason stops
 * being true the entry moves rather than being rewritten.
 */
export const PER_USER_STATE_NON_MEMBERS = [
  {
    name: 'clientOutboxAndReplicaCursor',
    reason:
      'DEVICE-local and never replicated (ADR 1 Amendment 1 §10). Per-user by class, no server ' +
      'row, nothing to move.',
  },
] as const
