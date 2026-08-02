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
  /** Grantees who may spectate (read / write / manage). */
  readonly watchGrantees: readonly string[]
  /** Grantees who may take control (write / manage). */
  readonly driveGrantees: readonly string[]
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
      // Capability.role is the issue-authz vocabulary; instance admin is the
      // only break-glass grade that may drive any session (policy §3).
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
  ownership: { owner: UserId; grants: readonly string[] },
  machineUse: SessionControlContext['machineUse'],
  /**
   * Optional write/manage-only list. When omitted, every listed grantee may both
   * watch and drive (today's transitional "grant = share" shape). Callers that
   * know verb-level grants pass the filtered lists explicitly.
   */
  driveGrantees?: readonly string[],
): SessionControlContext => ({
  owner: ownership.owner,
  watchGrantees: ownership.grants,
  driveGrantees: driveGrantees ?? ownership.grants,
  machineUse,
})

const humanMay = (
  human: UserId,
  role: UserRole | null,
  owner: UserId,
  grantees: readonly string[],
): boolean => {
  if (human === owner) return true
  if (role === 'admin') return true
  return grantees.includes(human)
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
  return humanMay(subject.human, subject.role, ctx.owner, ctx.watchGrantees)
    ? true
    : 'unauthorized'
}

/**
 * May this subject TAKE or HOLD control?
 *
 * Watch is a prerequisite (includes machine use). Drive additionally needs
 * owner / write-or-manage grant / admin.
 */
export function mayDrive(
  subject: ControlSubject,
  ctx: SessionControlContext,
): true | ControlPolicyRefusal {
  const watch = mayWatch(subject, ctx)
  if (watch !== true) return watch
  if (subject.kind === 'system') return true
  if (!subject.human) return 'unauthorized'
  return humanMay(subject.human, subject.role, ctx.owner, ctx.driveGrantees)
    ? true
    : 'unauthorized'
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
