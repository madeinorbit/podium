/**
 * THE FOUR AUTHORIZATION AXES — A3 (PDM-129), ADR 9 D5 / ADR 3 Amendment 1
 * D15/D16/D19, execution charter "human role, task collaboration, private
 * execution and agent delegation".
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS TO REMOVE
 * ---------------------------------------------------------------------------
 *
 * Before A3, `capability.scope.kind === 'all'` was the codebase's answer to FOUR
 * different questions, at twenty-one live sites. Measured on the branch point:
 *
 *   - `modules/messages/handlers/spawn-agent.ts`  → "is the caller a HUMAN?"
 *     (`origin: scope.kind === 'all' ? 'human' : 'agent'`)
 *   - `modules/messages/service.ts`               → "is the caller an OPERATOR?"
 *   - `modules/sessions/session-state/service.ts` → "may the caller read ANOTHER
 *     MEMBER'S session?" — answered `true` for any scope-`all` capability
 *   - `issue-authz.ts#checkIssueAccess`           → "is the caller's TASK SCOPE
 *     unconstrained?" — the one question the scope actually answers
 *
 * One predicate cannot be four answers. The consequences are not hypothetical
 * and they are not symmetric:
 *
 *  1. **Admin reached private execution.** `userCommandPrincipal` mints
 *     `scope: 'all'` for `role === 'admin'`, so an admin satisfied the session
 *     visibility test above for every member's session. ADR 9 Amendment 1 D7
 *     says the opposite in as many words — *admins cannot view or drive another
 *     member's session* — and D13 limits what a member may learn about another
 *     member's session on a SHARED task to owner, title and live/idle state.
 *     The bypass was not a decision anyone recorded; it is what "admin implies
 *     scope all" means once scope-all is also read as "may see everything".
 *  2. **An agent could be mistaken for a human.** The human/agent question was
 *     answered by a SCOPE, and a scope is mintable per session. The correct
 *     discriminator is the principal KIND, which comes from the authenticated
 *     transport and is not a function of how wide the capability is.
 *
 * So the four questions are given four names below, each with its own input
 * type, and NONE of them is derivable from another. A site that wants to know
 * whether the caller is an admin can no longer accidentally receive "…and may
 * therefore read anyone's private session" along with the answer.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AXES ARE TYPES AND NOT JUST FUNCTIONS
 * ---------------------------------------------------------------------------
 *
 * Each evaluator takes a distinct, non-interchangeable parameter object. That is
 * deliberate: if all four took `Capability`, the compiler would happily let a
 * caller ask the private-execution question and use the answer as the role
 * question, which is the exact substitution that produced the bypass. They are
 * structurally incompatible, so the substitution is a type error rather than a
 * code review note.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not widen task delivery. The execution charter's exposure order is
 * explicit that through phases A and B the owner-or-grant task read predicate in
 * `apps/server/src/feed-visibility.ts` stays unchanged, and C4 (PDM-144)
 * replaces it after B7 accepts isolation. Nothing here is that predicate: every
 * evaluator below either NARROWS (axis 3 removes an allow) or names a rule that
 * had no home at all (axes 1, 2, 4). `mayReadSharedTaskContent` is deliberately
 * absent for that reason — it is C4's to add, and adding it here would be the
 * "finishing the job" A2's `matrix.test.ts` is written to fail on.
 */

import { assertUnreachable } from '../exhaustive'
import type { UserId } from '../ids/brands'
import type { UserRole } from '../identity/user'

// ---------------------------------------------------------------------------
// The axis vocabulary
// ---------------------------------------------------------------------------

/**
 * The four questions, named. Every authorization decision in the product is one
 * of these, and a decision that is two of them is two decisions.
 *
 * This union is not consumed by a dispatcher — there is no `decide(axis, …)`,
 * because a single entry point taking an axis tag would re-collapse what the
 * four separate signatures below keep apart. It exists so the census can
 * classify each operation and projection by the axis that governs it, and so a
 * fifth question cannot be added without someone naming it.
 */
export const AUTHORIZATION_AXES = [
  /** Is this principal an identity the instance still recognises and admits? */
  'active-identity',
  /** Which commands may this human ATTEMPT — member or admin (Amendment 1 D15)? */
  'human-role',
  /** May this principal read/edit shared TASK content (ADR 9 D4/D5 A3)? */
  'task-collaboration',
  /** May this principal reach a PRIVATE, singly-owned resource (ADR 9 D3/D7)? */
  'private-execution',
  /** What is left after intersecting an agent's scope with its human's rights? */
  'agent-delegation',
] as const

export type AuthorizationAxis = (typeof AUTHORIZATION_AXES)[number]

/**
 * The outcome vocabulary, shared by every axis.
 *
 * `confirm-required` belongs to exactly ONE axis — `task-collaboration` — and
 * {@link taskScopeDecision} is the only function below that can return it. See
 * the note there: `--outside-scope` confirms crossing a working-task boundary
 * and must never be able to answer a human-authorization question.
 */
export type AxisDecision = 'allow' | 'deny' | 'confirm-required'

// ---------------------------------------------------------------------------
// AXIS 1 — active identity
// ---------------------------------------------------------------------------

/**
 * What the instance knows about the person behind a call. Read from the
 * directory at APPLY time, never from a payload and never cached onto a
 * capability (ADR 3 D16: effective rights are resolved at every apply, because
 * a snapshot leaves an unattended agent running with rights its human no longer
 * holds).
 *
 * `disabledAt` is `null`-able rather than optional for the reason
 * `identity/user.ts` gives at its own declaration: a reader that treats a
 * MISSING disabled marker as "enabled" fails OPEN on a suspended account. Here
 * that would mean a suspended member's agent keeps working. `undefined` is
 * therefore not representable — the caller must have actually looked.
 */
export interface IdentityFacts {
  readonly userId: UserId
  readonly role: UserRole
  /** ADR 9 Amendment 1 D14: "suspended" IS the existing disabled state. */
  readonly disabledAt: string | null
}

/**
 * AXIS 1. A principal whose human is suspended is denied everything, before any
 * other axis is consulted.
 *
 * ORDER IS LOAD-BEARING. This runs FIRST, and the other three evaluators take
 * facts that can only be produced by having run it, so "we forgot to check
 * whether they still work here" is not reachable from a well-typed call site.
 * D12 keeps a suspended member's rows and ownership intact — suspension removes
 * the ability to ACT, not the ownership facts other people's decisions read.
 */
export function activeIdentityDecision(facts: IdentityFacts | undefined): AxisDecision {
  // Default-closed: an identity the directory cannot resolve is not an identity.
  // This is the same rule `mayReadOwned` learned the hard way — two modules once
  // compared `undefined === undefined` and read it as ownership.
  if (facts === undefined) return 'deny'
  return facts.disabledAt === null ? 'allow' : 'deny'
}

// ---------------------------------------------------------------------------
// AXIS 2 — human role
// ---------------------------------------------------------------------------

/**
 * ADR 3 Amendment 1 D15's account grades. A role is a FLOOR on which commands a
 * principal may ATTEMPT; it never decides which ROWS it may touch. That sentence
 * is the whole separation between this axis and axis 3, and the bypass existed
 * because one value was doing both jobs.
 *
 * There is no viewer role (charter, D13).
 */
export type RoleFloor = 'member' | 'admin'

/** Roles that satisfy each floor. An exhaustive record, so a third grade fails
 *  to compile here rather than silently satisfying `member`. */
const ROLE_SATISFIES: Record<RoleFloor, readonly UserRole[]> = {
  member: ['member', 'admin'],
  admin: ['admin'],
}

/**
 * AXIS 2. Does this human's grade admit ATTEMPTING a command with this floor?
 *
 * Takes an {@link IdentityFacts}, not a `Capability`, and that is the type-level
 * half of the separation: a scope cannot be passed here, so "scope is all" can
 * never again be spelled as "is an admin".
 *
 * Returns a boolean rather than an {@link AxisDecision} on purpose. A role floor
 * has no overridable middle state — `--outside-scope` has nothing to say about
 * whether you are an admin — and returning the three-valued type would invite a
 * caller to treat this answer as confirmable.
 */
export function meetsRoleFloor(facts: IdentityFacts, floor: RoleFloor): boolean {
  return ROLE_SATISFIES[floor].includes(facts.role)
}

// ---------------------------------------------------------------------------
// AXIS 3 — task collaboration
// ---------------------------------------------------------------------------

/**
 * What a task-collaboration decision is ABOUT.
 *
 * `shared-content` is ADR 9 D4/D5 A3's ordinary task body — title, description,
 * stage, assignment — which every ACTIVE MEMBER may edit. `comment` is the
 * exception D5 carves out: a comment is a person's own utterance, so editing one
 * is author-only and an admin has no special claim on it.
 */
export type TaskCollaborationTarget =
  | { readonly kind: 'shared-content' }
  | { readonly kind: 'comment'; readonly authorId: UserId | null }

/**
 * AXIS 3. May this active member edit this piece of task content?
 *
 * TWO RULES, AND THE SECOND IS NOT A NARROWER FIRST:
 *
 *  - shared content → any active member, admin and member alike. Collaborator
 *    and follower records are PARTICIPATION, not editor grants (charter), so
 *    they are deliberately not a parameter here: a function that took them would
 *    be a function someone could use to require them.
 *  - a comment → its AUTHOR ONLY. Not the task's assignee, not an admin. An
 *    unattributed comment (`authorId === null`) is editable by nobody, because
 *    default-closed on an author-only rule means an utterance whose author is
 *    unknown is not anyone's to rewrite.
 *
 * Note what an admin does NOT get: `meetsRoleFloor(facts, 'admin')` is not
 * consulted anywhere in this function. Admin grade is axis 2, and axis 2 governs
 * which commands may be ATTEMPTED, not whose words may be rewritten.
 */
export function taskCollaborationDecision(
  facts: IdentityFacts,
  target: TaskCollaborationTarget,
): AxisDecision {
  if (activeIdentityDecision(facts) !== 'allow') return 'deny'
  switch (target.kind) {
    case 'shared-content':
      return 'allow'
    case 'comment':
      if (target.authorId === null) return 'deny'
      return target.authorId === facts.userId ? 'allow' : 'deny'
    default:
      return assertUnreachable(target)
  }
}

/**
 * AXIS 3, SCOPE HALF — the ONLY place `--outside-scope` may be consulted.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FUNCTION FROM EVERY OTHER DECISION IN THIS FILE
 * ---------------------------------------------------------------------------
 *
 * ADR 3 D2's `--outside-scope` / `overrideScope` confirms ONE thing: that a
 * caller knowingly reached outside the WORKING TASK its capability is bound to.
 * It is a guard against an agent wandering, not a grant of authority — the
 * person on the other end of it already had the rights; what they lacked was the
 * intent.
 *
 * The risk this signature removes is that the same flag reaches a decision it
 * was never meant to settle. If `override` were a parameter of one general
 * `authorize`, then every `confirm-required` anywhere would become an `allow`
 * for a caller who passed `--outside-scope` — including, once ownership
 * decisions returned `confirm-required`, a caller reaching another member's
 * private session. `issue-authz.ts` already refuses that in prose ("reusing it
 * here would make it a general escalation"); this file refuses it in the type
 * system by making `override` reachable from exactly one function, whose only
 * possible subject is a task scope.
 *
 * `inScope` is computed by the caller from the capability's task scope and the
 * target's ancestry — this function decides what to DO about the answer, and
 * deliberately cannot see a user id, an owner or a role.
 */
export function taskScopeDecision(
  inScope: boolean,
  opts?: { readonly override?: boolean },
): AxisDecision {
  if (inScope) return 'allow'
  return opts?.override === true ? 'allow' : 'confirm-required'
}

// ---------------------------------------------------------------------------
// AXIS 4 — private execution
// ---------------------------------------------------------------------------

/**
 * A privately owned resource: a session, a run, an automation, a machine, a
 * per-user row. `owner` is read from the STORE, never from a payload (ADR 3 D7).
 *
 * `owner: null` is representable and means UNOWNED, which is a denial and not an
 * ambience — §3.1.1 default-closed. Two modules once spelled this rule as
 * `owner === userId || grants.includes(userId)` over a possibly-absent owner, so
 * an unowned row plus an unauthenticated reader compared `undefined ===
 * undefined` and read as ALLOW.
 */
export interface PrivateResourceFacts {
  readonly resourceId: string
  readonly owner: UserId | null
  /** Explicit grants. Charter: there is no sharing/handover verb in v1, so this
   *  stays EMPTY in practice — it is carried because `grants` already exists in
   *  the store and silently dropping it here would be a second policy. */
  readonly grants?: readonly UserId[]
}

/**
 * AXIS 4. May this principal reach a private, singly-owned resource?
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO ADMIN ARM, AND ITS ABSENCE IS THE DELIVERABLE
 * ---------------------------------------------------------------------------
 *
 * ADR 9 Amendment 1 D7: an admin may not view or drive another member's session.
 * D13: on a SHARED task, other members' sessions are visible as owner, title and
 * live/idle state only — which is a PROJECTION narrowing, served by showing less,
 * never by admitting a reader to the resource itself.
 *
 * So `facts.role` is not read by this function, and cannot be: an admin and a
 * member get the identical answer. Before A3, `session-state/service.ts`
 * returned `principal.capability.scope.kind === 'all'` as its final fallback,
 * which admitted every admin to every member's session — and because the same
 * predicate also meant "unconstrained task scope", nobody reading that line saw
 * a privacy decision being made.
 *
 * PERSONAL AUTOMATION CONFIGURATION AND MEMORY ARE PRIVATE (charter), and they
 * come through here too. The rule is one line because the rule genuinely is one
 * line; what it took was giving it somewhere to live that an admin check could
 * not reach into.
 */
export function privateExecutionDecision(
  facts: IdentityFacts,
  resource: PrivateResourceFacts,
): AxisDecision {
  if (activeIdentityDecision(facts) !== 'allow') return 'deny'
  // Unowned is not ambient. Also NOT overridable: `--outside-scope` confirms
  // crossing a task boundary (axis 3), and there is no flag that converts a
  // privacy denial into an allow. That is why this returns `deny` and never
  // `confirm-required`.
  if (resource.owner === null) return 'deny'
  if (resource.owner === facts.userId) return 'allow'
  return (resource.grants ?? []).includes(facts.userId) ? 'allow' : 'deny'
}

// ---------------------------------------------------------------------------
// AXIS 5 — agent delegation
// ---------------------------------------------------------------------------

/**
 * An agent's own declared reach, and the human it acts for.
 *
 * `chain` is the agent-session ancestry nearest-first, already resolved by
 * `command-principal.ts`. It is carried so the intersection below is evaluated
 * over the WHOLE chain rather than the leaf alone — a sub-agent must not be able
 * to carry a delegator its parent does not have.
 */
export interface DelegationFacts {
  readonly onBehalfOf: UserId
  readonly chainDepth: number
}

/**
 * AXIS 5. An agent's effective rights are its OWN scope intersected with its
 * human's CURRENT rights (ADR 9 D5 A1, ADR 3 D16) — never a superset, never a
 * snapshot.
 *
 * This function is the intersection made explicit, and it takes the human's
 * decision as an INPUT rather than recomputing it. That is the whole mechanism:
 * there is no arrangement of agent scope that produces `allow` from a human
 * `deny`, because the human's answer is a parameter and the only operation
 * applied to it is narrowing.
 *
 * A BROADER AGENT SCOPE CANNOT WIDEN ANYTHING (acceptance MU-06). The agent's
 * half arrives as `agentDecision` and is intersected; if an agent were minted
 * with `allow` for something its human is denied, the result is still `deny`.
 *
 * `confirm-required` survives intersection only when BOTH halves admit it, and
 * it degrades to `deny` if either side denies — a confirmation prompt is not a
 * way to launder a denial on the other half.
 */
export function intersectDelegation(
  humanDecision: AxisDecision,
  agentDecision: AxisDecision,
): AxisDecision {
  if (humanDecision === 'deny' || agentDecision === 'deny') return 'deny'
  if (humanDecision === 'confirm-required' || agentDecision === 'confirm-required') {
    return 'confirm-required'
  }
  return 'allow'
}

/**
 * The delegation chain's human, with the fail-loud bound `command-principal.ts`
 * applies. Exported so a caller that has already walked a chain can state the
 * depth it walked, and so a chain that hit the ceiling is a DENY rather than a
 * silently truncated answer: a cycle in `spawnedBy` must not resolve to whatever
 * session the walk happened to stop on.
 */
export const MAX_DELEGATION_DEPTH = 64

export function delegationIsResolvable(facts: DelegationFacts): boolean {
  return facts.chainDepth < MAX_DELEGATION_DEPTH
}
