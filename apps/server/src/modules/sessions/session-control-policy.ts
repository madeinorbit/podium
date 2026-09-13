/**
 * Shared session control policy (POD-1081).
 *
 * Pure decisions over "who may watch", "who may drive", and "what happens when
 * rights disappear". Identity comes from the authenticated transport principal
 * (ADR 3 D7); this module never reads a payload display name.
 *
 * Product decisions are recorded in
 * `docs/design/session-control-identity.md`. Cursor/selection UI is Phase 6;
 * concurrent text editing is out of scope.
 */

import {
  agentIdentityFromSessionId,
  type Attribution,
  actorAgent,
  actorUser,
  type LegacyGrant,
  type SessionId,
  type UserId,
  type UserRole,
} from '@podium/model'
import type { PresenceIdentity } from '@podium/protocol'
import type { CommandPrincipal } from '../../command-principal'
import type { ClientPrincipal } from '../../gateway/client-principal'

/** Rights a principal needs on a session to participate. */
export type SessionControlVerb = 'watch' | 'drive'

/**
 * The session-side facts the policy needs — owner + grant lists + the machine
 * use verdict for the session's host. Grants are READ from the store by the
 * caller (ADR 3 D7); this module never looks them up.
 */
export interface SessionControlContext {
  readonly owner: UserId
  /**
   * Grantees who may spectate (read / write / manage).
   *
   * BRANDED, AND THE BRAND IS THE POINT (PDM-355). This was `readonly string[]`,
   * and a `readonly string[]` ANYWHERE ON THE PATH launders the source typing
   * back to a comparable type: a `LegacyGrant` IS a `string`, so it flowed in
   * here silently and `humanMay`'s `grantees.includes(human)` three functions
   * down compiled clean. Typing `sessionOwner` at its source is necessary and
   * not sufficient; the brand has to reach the comparison.
   */
  readonly watchGrantees: readonly LegacyGrant[]
  /** Grantees who may take control (write / manage). See {@link watchGrantees}. */
  readonly driveGrantees: readonly LegacyGrant[]
  /**
   * Machine `use` for this principal on the session's host (ADR 9 D6 M1).
   * `absent` and `denied` both refuse attach — session share is not a back door
   * to code execution. Callers may collapse absent/denied for the wire.
   */
  readonly machineUse: 'granted' | 'denied' | 'absent'
}

export type ControlPolicyRefusal = 'unauthorized'

/** Subject evaluated for control — transport principal projected to a person. */
export interface ControlSubject {
  readonly kind: 'user' | 'agent' | 'system'
  /** The human whose rights form the ceiling (self for users; onBehalfOf for agents). */
  readonly human: UserId | null
  readonly role: UserRole | null
  /** Agent session id when kind === 'agent'; used for identity stamping. */
  readonly agentSessionId?: SessionId
}

export const controlSubjectFromClient = (principal: ClientPrincipal): ControlSubject => ({
  kind: 'user',
  human: principal.user,
  role: principal.role,
})

export const controlSubjectFromCommand = (principal: CommandPrincipal): ControlSubject => {
  switch (principal.kind) {
    case 'user':
      // Capability.role is the issue-authz vocabulary. The grade is projected
      // because callers read it, NOT because it confers rights on a session:
      // under D7 it no longer does (see `humanMay`).
      return {
        kind: 'user',
        human: principal.user,
        role: principal.capability.role === 'admin' ? 'admin' : 'member',
      }
    case 'agent':
      return {
        kind: 'agent',
        human: principal.onBehalfOf,
        role: null,
        agentSessionId: principal.agentSessionId,
      }
    case 'system':
      return { kind: 'system', human: null, role: null }
  }
}

/**
 * Build the grant-derived context from the session ownership row the lifecycle
 * already exposes. `write`/`manage` drive; any grant verb watches.
 */
export const contextFromOwnership = (
  ownership: { owner: UserId; legacyGrants: readonly LegacyGrant[] },
  machineUse: SessionControlContext['machineUse'],
  /**
   * Optional write/manage-only list. When omitted, every listed grantee may both
   * watch and drive (today's transitional "grant = share" shape). Callers that
   * know verb-level grants pass the filtered lists explicitly.
   */
  driveGrantees?: readonly LegacyGrant[],
): SessionControlContext => ({
  owner: ownership.owner,
  watchGrantees: ownership.legacyGrants,
  driveGrantees: driveGrantees ?? ownership.legacyGrants,
  machineUse,
})

/**
 * Owner or grantee. There is no grade that answers this question: ADR 9
 * Amendment 1 D7 (accepted 12 September 2026) says an instance admin cannot
 * view or drive another member's session, so the `role === 'admin'` short
 * circuit that used to sit between these two lines is gone [PDM-270]. An admin
 * reaches someone else's session the same way anyone else does — with a grant.
 */
const humanMay = (
  human: UserId,
  owner: UserId,
  grantees: readonly LegacyGrant[],
): boolean => {
  if (human === owner) return true
  /**
   * ── THE ADMIN BREAK-GLASS, CONFRONTED RATHER THAN DECIDED (PDM-355) ────────
   *
   * This line is PDM-270's open question, and typing the list is what forces it
   * to be looked at instead of inherited. `grantees.includes(human)` no longer
   * compiles on its own: `grantees` is `readonly LegacyGrant[]` all the way from
   * `sessionOwner`, and a `LegacyGrant` is deliberately not a `UserId`.
   *
   * THE CAST IS DELIBERATE AND CHANGES NOTHING TODAY. `sessionOwner` has
   * returned an empty list since B1/PDM-133, so this arm admits nobody and the
   * behaviour here is byte-identical to what it was. What the cast does is make
   * the day it stops being empty a decision someone made at a named type, rather
   * than a one-line edit nothing could see.
   *
   * WHOSE DECISION IT IS — AND IT IS NOT PDM-270'S, WHICH IS DONE. PDM-355's
   * brief said this line "needs PDM-270's decision". It does not. PDM-270 was
   * about the ADMIN GRADE: the `role === 'admin'` short circuit that used to sit
   * between the two lines above, plus `scope.kind === 'all'` in
   * `session-state/service.ts`. Both are gone and PDM-270 closed. It deliberately
   * left THIS arm standing, because a grant is not a grade.
   *
   * What is actually open is SESSION SHARING, which the execution charter defers
   * out of v1 — see `LegacyGrant` in `@podium/model`'s `authz/axes.ts`:
   * "resurrecting it means deciding a verb model, not re-enabling a lookup". The
   * `driveGrantees ?? watchGrantees` default above is the transitional
   * "grant = share" shape that deferral leaves behind, and it is the thing a verb
   * model would replace. Until someone decides that, this arm is unreachable
   * (the list is empty) and the cast is what keeps it visible. Filed as PDM-393.
   *
   * So: removing the cast is how "sessions are owner-only, full stop" gets
   * enforced by the compiler. Replacing it with a named unbrand is how a decided
   * sharing model gets enacted. Leaving it as-is asserts neither.
   */
  return (grantees as readonly string[]).includes(human)
}

/**
 * May this subject SEE the session and attach a PTY?
 *
 * Both session visibility and machine `use` apply. Machine use is the
 * code-execution boundary (ADR 9 D6 M2) and cannot be satisfied by a session
 * grant alone.
 */
export function mayWatch(
  subject: ControlSubject,
  ctx: SessionControlContext,
): true | ControlPolicyRefusal {
  if (ctx.machineUse !== 'granted') return 'unauthorized'
  if (subject.kind === 'system') return true
  if (!subject.human) return 'unauthorized'
  return humanMay(subject.human, ctx.owner, ctx.watchGrantees) ? true : 'unauthorized'
}

/**
 * May this subject TAKE or HOLD control?
 *
 * Watch is a prerequisite (includes machine use). Drive additionally needs
 * owner or a write-or-manage grant.
 */
export function mayDrive(
  subject: ControlSubject,
  ctx: SessionControlContext,
): true | ControlPolicyRefusal {
  const watch = mayWatch(subject, ctx)
  if (watch !== true) return watch
  if (subject.kind === 'system') return true
  if (!subject.human) return 'unauthorized'
  return humanMay(subject.human, ctx.owner, ctx.driveGrantees) ? true : 'unauthorized'
}

/** Stamp the live controller identity from a control subject. */
export function identityOf(subject: ControlSubject): PresenceIdentity | null {
  if (subject.kind === 'user' && subject.human) {
    return { kind: 'user', user: subject.human }
  }
  if (subject.kind === 'agent' && subject.human && subject.agentSessionId) {
    return {
      kind: 'agent',
      agentIdentity: agentIdentityFromSessionId(subject.agentSessionId),
      onBehalfOf: subject.human,
    }
  }
  return null
}

/** Attribution pair for live PTY input, from the same subject. */
export function attributionOfSubject(subject: ControlSubject): Attribution | null {
  if (subject.kind === 'user' && subject.human) {
    return { actor: actorUser(subject.human), onBehalfOf: subject.human }
  }
  if (subject.kind === 'agent' && subject.human && subject.agentSessionId) {
    return {
      actor: actorAgent(agentIdentityFromSessionId(subject.agentSessionId)),
      onBehalfOf: subject.human,
    }
  }
  return null
}

/**
 * After a rights change, does the current controller still hold drive rights?
 * Used at the next apply — never by a reaper (ADR 9 D5 A1).
 */
export function controllerStillAuthorized(
  subject: ControlSubject | null,
  ctx: SessionControlContext,
): boolean {
  if (!subject) return false
  return mayDrive(subject, ctx) === true
}
