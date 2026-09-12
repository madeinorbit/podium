/**
 * TYPED REVISION REFERENCES — "which version of what did this worker act on?"
 * (A2, ADR 9 Amendment 1 D5).
 *
 * ADR 2 D3 already gives every durable entity a {@link Revision}: a monotonic
 * integer the authority stamps on each accepted write, echoed back by commands as
 * `expectedRevision` and enforced with a 409. That mechanism answers *"is my
 * write based on current truth?"* for ONE row, at the moment of writing it.
 *
 * This file answers a longer-lived question. A worker — usually an agent, often
 * one that has been running for an hour — reads a task, goes away, and comes back
 * to finish. Between those two moments any active member may have reassigned the
 * task (D2) or rewritten its brief (D5). The charter states the obligation
 * directly: *"Keep input and assignment revisions so stale workers cannot undo
 * assignment or close materially changed work."*
 *
 * ---------------------------------------------------------------------------
 * WHY A REFERENCE, AND NOT A BARE NUMBER
 * ---------------------------------------------------------------------------
 *
 * A bare `revision: number` on a worker's state is the shape that cannot be
 * checked: nothing says WHICH row it counts, so a value read from a task and a
 * value read from an account are the same type and compare without complaint.
 * That is the `spawnedBy` lesson from `./attribution.ts` in a different costume —
 * a flattened token becomes comparable, and call sites start comparing.
 *
 * So a reference carries its subject, the subject kinds are a discriminated union,
 * and the ids are DIFFERENTLY BRANDED. Comparing a {@link TaskRevisionRef} with an
 * {@link AccountRevisionRef} does not typecheck, and comparing two task refs for
 * two different tasks is caught by {@link revisionIsCurrent}, which refuses a
 * mismatched subject rather than answering about the number alone.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not ENFORCE anything, and it deliberately owns no policy about what a
 * worker should do when its reference is stale. That decision differs by act —
 * refusing a close is not the same as refusing a comment — and it belongs with
 * the commands, in the C phase. What lands here is the vocabulary those commands
 * are written against, so that "the assignment moved under me" is expressible
 * before it is enforceable, rather than being invented per call site afterwards.
 *
 * It is also NOT a capability snapshot (`fields/README.md` rule 4). A revision is
 * a version counter, not a decision: holding one lets a worker notice that truth
 * moved, and never lets it act on rights it no longer has.
 */

import { z } from 'zod'
import { IssueIdField, UserIdField } from '../ids'
import { Revision } from './primitives'

/**
 * WHICH CONFIGURATION. Closed, because a worker acting on "the configuration"
 * without saying which one is the ambiguity this file exists to remove.
 *
 * Two of these are singletons per instance or per person and two name an object,
 * which is why {@link ConfigurationRevisionRef} carries a nullable `id` rather
 * than four ref types.
 */
export const CONFIGURATION_SCOPES = [
  /** Deployment substrate: instance settings and feature flags (ADR 9 D3). */
  'instance-settings',
  /** One person's private preference set — never another person's (D3 rule 4). */
  'personal-preferences',
  /** A workflow definition, whose revisions are already a first-class row. */
  'workflow-definition',
  /** An execution profile a run was launched against. */
  'execution-profile',
] as const

export const ConfigurationScopeField = z.enum(CONFIGURATION_SCOPES)
export type ConfigurationScope = (typeof CONFIGURATION_SCOPES)[number]

/** Compile-time pin: the zod enum and the vocabulary are one set. */
const _configurationScopeIsOneVocabulary: ConfigurationScope = null as unknown as z.infer<
  typeof ConfigurationScopeField
>
void _configurationScopeIsOneVocabulary

/** THE TASK a worker read. The common case, and the one the charter names. */
export const TaskRevisionRef = z.object({
  kind: z.literal('task'),
  issueId: IssueIdField,
  revision: Revision,
})
export type TaskRevisionRef = z.infer<typeof TaskRevisionRef>

/**
 * THE ACCOUNT a decision was made about.
 *
 * Its use is narrow and worth stating so the type is not read as an invitation to
 * cache rights: a member disabled between a read and a write (D14's "suspended"
 * is the existing disabled state) must not have work attributed to them as if
 * they were still active. Noticing that the account row moved is what makes that
 * checkable. The RIGHTS are still resolved live at every apply (D5 A1) — this
 * reference is how a caller learns it should re-resolve, never a copy of the
 * answer.
 */
export const AccountRevisionRef = z.object({
  kind: z.literal('account'),
  userId: UserIdField,
  revision: Revision,
})
export type AccountRevisionRef = z.infer<typeof AccountRevisionRef>

/** THE CONFIGURATION a run was launched against. `id` is `null` for the two
 *  singleton scopes — present-and-null rather than optional, for the reason
 *  `Attribution.onBehalfOf` is: "this scope has no object" and "nobody threaded
 *  the value" are different facts. */
export const ConfigurationRevisionRef = z.object({
  kind: z.literal('configuration'),
  scope: ConfigurationScopeField,
  id: z.string().nullable(),
  revision: Revision,
})
export type ConfigurationRevisionRef = z.infer<typeof ConfigurationRevisionRef>

/**
 * The three, as one discriminated union.
 *
 * Closed by decision, the same way `ActorRef` is: a fourth subject is a decision
 * about what a worker may be stale against, not a convenience. Adding one makes
 * {@link sameSubject} fail to compile until it says how the new kind is compared,
 * which is the point of not writing the switch as an `if` chain.
 */
export const RevisionRef = z.discriminatedUnion('kind', [
  TaskRevisionRef,
  AccountRevisionRef,
  ConfigurationRevisionRef,
])
export type RevisionRef = z.infer<typeof RevisionRef>

export const taskRevision = (issueId: TaskRevisionRef['issueId'], revision: Revision): TaskRevisionRef => ({
  kind: 'task',
  issueId,
  revision,
})
export const accountRevision = (
  userId: AccountRevisionRef['userId'],
  revision: Revision,
): AccountRevisionRef => ({ kind: 'account', userId, revision })
export const configurationRevision = (
  scope: ConfigurationScope,
  id: string | null,
  revision: Revision,
): ConfigurationRevisionRef => ({ kind: 'configuration', scope, id, revision })

/** Do two references name the SAME thing? Exhaustive, so a fourth member of the
 *  union cannot silently answer `false` and make every comparison against it a
 *  no-op. */
export const sameSubject = (a: RevisionRef, b: RevisionRef): boolean => {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'task':
      return a.issueId === (b as TaskRevisionRef).issueId
    case 'account':
      return a.userId === (b as AccountRevisionRef).userId
    case 'configuration': {
      const other = b as ConfigurationRevisionRef
      return a.scope === other.scope && a.id === other.id
    }
  }
}

/**
 * Is what this worker saw still current?
 *
 * `false` for a DIFFERENT subject, not a thrown error and not `true`: a caller
 * comparing a reference to the wrong row has a bug, and the safe answer to "may I
 * act on this?" when the question itself is malformed is no. Default-closed, the
 * same discipline ADR 9 D4 applies to visibility.
 *
 * Strictly `===` rather than `>=`. A `current` that is BEHIND the reference is not
 * a worker that is safely ahead — it is a replica that has not caught up, or a
 * reference that was never real, and treating either as "fine" is how a stale
 * write gets admitted by the check meant to stop it.
 */
export const revisionIsCurrent = (seen: RevisionRef, current: RevisionRef): boolean =>
  sameSubject(seen, current) && seen.revision === current.revision
