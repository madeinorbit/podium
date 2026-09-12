/**
 * TASK PARTICIPATION — who is involved in a task, as a record that is NOT a
 * grant (A2, ADR 9 Amendment 1 D5).
 *
 * The charter sentence this file implements: *"Every active member can read every
 * task and edit ordinary shared task content; collaborator/follower records are
 * participation, not editor grants."*
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THIS FILE EXISTS TO KEEP APART
 * ---------------------------------------------------------------------------
 *
 * A participation row and a {@link file://../identity/grant.ts} grant edge have
 * nearly the same shape — `(entity, user, something)` — and mean opposite kinds
 * of thing:
 *
 *   - a **grant** is an AUTHORIZATION input. `GrantEdgeVisibilityPolicy` reads it
 *     live on the fan-out path, and adding one makes rows appear for a principal
 *     who could not see them before;
 *   - a **participation record** is a DESCRIPTION. It says who is involved, it is
 *     read by the UI and by routing, and it grants exactly nothing — because under
 *     D4/D5 every active member already reads every task and already holds
 *     ordinary edit, so there is no right left for it to confer.
 *
 * If that distinction ever blurs, the system acquires a second authorization
 * vocabulary that nothing audits: `annotations/matrix.ts`'s `task-participation`
 * row therefore declares `grants: { kind: 'none', reason: 'derived' }` with the
 * reason spelled out, and this file defines no verb, no scope and no expiry —
 * there is deliberately nothing here for a policy to read.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT PER-USER STATE EITHER
 * ---------------------------------------------------------------------------
 *
 * It is keyed `(issueId, userId, role)`, which LOOKS like the per-user family's
 * `(userId, entityId)` fragment, and it is not one: the per-user family's rule is
 * that the user in the key is the only principal who may write the row. Here a
 * SECOND person may add you as a collaborator, and an agent may record its own
 * human's involvement — so the writer is not the keyed user, and composing
 * `perUserKey` would make a false promise the family's totality test would then
 * enforce against the wrong thing. Participation is a SHARED fact about a task
 * that happens to name a person.
 *
 * The personal, per-reader halves of the same subject DO live in the family, and
 * they are a different question: `user-state/issue-state.ts` carries `startedAt`
 * (did I start this) and `assignmentDismissedAt` (have I cleared its sidebar row).
 */

import { z } from 'zod'
import { IssueIdField, UserIdField } from '../ids'
import { Attribution } from './attribution'

/**
 * THE CLOSED ROLE SET.
 *
 * `collaborator` is live and is what the tracker writes today: claiming an issue,
 * or being added to it, records the human behind the work as a collaborator. It
 * is explicitly NOT accountability — the accountable human is the single
 * `Ownership.owner`, displayed as Assignee, and a collaborator row never makes
 * anyone an owner. That separation is the whole reason this record is not another
 * user id column on the task.
 *
 * `follower` is DECLARED AND NOT BUILT. Task following and mute are PDM-208,
 * deferred out of v1 by the accepted decision table, and nothing in the product
 * writes or reads this member yet. It is here rather than added later for the
 * reason `CredentialSource` keeps a one-member enum: the day following ships must
 * not also be the day the participation table changes shape. Adding the member
 * now is additive; widening a two-column table afterwards is a migration.
 *
 * A third role is a product decision, not a convenience: the exhaustive switches
 * below stop compiling until it declares what it means.
 */
export const PARTICIPATION_ROLES = ['collaborator', 'follower'] as const

export const ParticipationRoleField = z.enum(PARTICIPATION_ROLES)
export type ParticipationRole = (typeof PARTICIPATION_ROLES)[number]

/** Compile-time pin: the zod enum and the vocabulary are one set. */
const _participationRoleIsOneVocabulary: ParticipationRole = null as unknown as z.infer<
  typeof ParticipationRoleField
>
void _participationRoleIsOneVocabulary

/**
 * Is this role BUILT, or declared and reserved?
 *
 * An exhaustive switch rather than `role === 'follower'`, so that a third role
 * has to say which it is instead of inheriting an answer. Reading it at a write
 * site is what keeps "reserved" from quietly becoming "half-implemented": a
 * caller that would persist a reserved role is a caller that is building PDM-208
 * inside a schema task.
 */
export function participationRoleIsBuilt(role: ParticipationRole): boolean {
  switch (role) {
    case 'collaborator':
      return true
    case 'follower':
      return false
  }
}

/**
 * ONE PERSON'S INVOLVEMENT IN ONE TASK, IN ONE ROLE.
 *
 * The key is the whole row: `(issueId, userId, role)`. No surrogate id, because
 * two rows for one person in one role on one task is not a state worth being able
 * to represent — an add is idempotent against its own key, which is why the
 * matrix row takes `conflict: 'cmd'` rather than the expected-revision token.
 *
 * `addedBy` is the {@link Attribution} pair and is REQUIRED, for the reason the
 * matrix row gives: a person joining themselves and an agent recording its own
 * human are different facts, and only the pair tells them apart. That matters
 * next door — D2 lets any active member reassign the accountable human but never
 * lets an agent do it — so a participation write, which IS what an agent's claim
 * is allowed to do, must be legible as an agent's act.
 */
export const TaskParticipation = z.object({
  issueId: IssueIdField,
  /** The HUMAN who is involved. Never an agent and never an agent label: an
   *  agent participates through the human it acts for (ADR 9 D5 A4), which is the
   *  same rule that keeps `owner` a person. */
  userId: UserIdField,
  role: ParticipationRoleField,
  /** When the row was created. Plain `z.string()`, matching every other ISO
   *  stamp in the vocabulary; see `./primitives.ts#Timestamp` on why a shared
   *  timestamp schema is a separate question. */
  joinedAt: z.string(),
  /** WHICH PRINCIPAL recorded this involvement (ADR 9 D5 A3). */
  addedBy: Attribution,
})
export type TaskParticipation = z.infer<typeof TaskParticipation>

/**
 * The collaborators of a task, as a read projection.
 *
 * A named shape rather than `TaskParticipation[]` at each call site, because the
 * consumers of "who is on this" — the task panel, mail routing, the member chips
 * — want the people, not the provenance of each row, and handing them the full
 * record invites a surface to render `addedBy` as if it were an author.
 */
export const TaskParticipants = z.object({
  issueId: IssueIdField,
  collaborators: z.array(UserIdField),
})
export type TaskParticipants = z.infer<typeof TaskParticipants>
