/**
 * THE SESSION-TARGET GATE AS A PORT (PDM-290) — `resolveSessionTarget` +
 * `assertMayCommandSession`, pre-bound to one caller, so a family that is not
 * `sessions` can run the same gate without being handed an authority object.
 *
 * ---------------------------------------------------------------------------
 * WHY A PORT AND NOT A PRINCIPAL ON THE STATE BUNDLE
 * ---------------------------------------------------------------------------
 *
 * `cloud.moveSession` takes a caller-supplied `sessionId`, reads that session's
 * resume ref and cwd to seed a hosted runtime, and with `hibernateLocal` parks
 * it. It is a session-targeting command by every definition the command plane
 * uses, and it was the one that never ran the gate: `sessionById` with its
 * `forPrincipal` argument omitted, no `resolveSessionTarget`, no
 * `assertMayCommandSession`, on a contract whose own policy says
 * `roleFloor: 'member'`.
 *
 * The obvious repair is to put a `CommandPrincipal` on `FamilyState` and let
 * `CloudService` do what `SessionCommandCtx` does. Why the bundle carries the
 * ANSWER instead is argued ONCE, in `derived-family.ts`'s header section "THE
 * DECISIONS THIS FILE DOES TAKE" — where it sits beside the other two positions
 * that same invariant admits, rather than being re-argued here and drifting from
 * them. This file is the answer's implementation: it wraps the two
 * `session-access.ts` functions and adds no rule of its own.
 *
 * ---------------------------------------------------------------------------
 * ONE CONSTRUCTION OF `SessionAccessDeps`, NOT TWO
 * ---------------------------------------------------------------------------
 *
 * {@link sessionAccessDeps} is the same three members `sessionCommandCtx` used
 * to build inline, moved here and consumed by both. The visibility member is the
 * load-bearing one — B1's `sessionOwnerVisibility` over the SAME `sessionOwner`
 * every other session authorization path consults — and a second hand-built
 * literal beside it is exactly how two paths come to hold two opinions about who
 * owns a session.
 */

import type { SessionId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import {
  asyncSessionIssueAccess,
  assertMayCommandSession,
  resolveSessionTarget,
  SESSION_NOT_FOUND,
  type SessionAccessDeps,
  type SessionTargetRow,
  sessionOwnerVisibility,
} from './session-access'

/** The two modules a session-target decision reads. A `Pick`, so a caller cannot
 *  reach the rest of the seam through this argument. */
export type SessionAccessModules = Pick<RegistryModules, 'sessions' | 'issues'>

/** The deps `resolveSessionTarget` and `assertMayCommandSession` take, composed
 *  from the module seam. The ONE construction — see the header. */
export function sessionAccessDeps(modules: SessionAccessModules): SessionAccessDeps {
  const sessions = modules.sessions
  return {
    sessionById: async (sessionId) => await sessions.sessionById(sessionId),
    issues: asyncSessionIssueAccess(modules.issues),
    /**
     * THE OWNER ANSWER (B1, PDM-133). A session is visible to the principal's
     * delegating human and to nobody else; an unresolvable owner is not visible.
     */
    visibility: sessionOwnerVisibility((sessionId) => sessions.sessionOwner(sessionId)),
  }
}

/**
 * One caller's session-target gate.
 *
 * `requireCommandable` either returns the row or throws — there is no third
 * answer and no boolean to ignore, which is the difference between a gate a
 * service must consult and a predicate a service may forget.
 */
export interface SessionTargetGate {
  /**
   * The target named by `sessionId`, if this caller may command it.
   *
   * ABSENT AND INVISIBLE ARE ONE ANSWER (ADR 3 Amendment 1 D20.2): a session
   * this caller's human cannot see fails exactly as a nonexistent id does,
   * with {@link SESSION_NOT_FOUND}, so the surface is not an existence oracle.
   * A target the human CAN see but the caller's own scope does not cover throws
   * the actionable scope refusal instead — `assertMayCommandSession`'s
   * distinction, kept rather than flattened.
   *
   * `proc` names the command for the scope refusal's message.
   */
  requireCommandable(sessionId: SessionId, proc: string): Promise<SessionTargetRow>
}

export function sessionTargetGate(
  modules: SessionAccessModules,
  principal: CommandPrincipal,
  overrideScope?: boolean,
): SessionTargetGate {
  const access = sessionAccessDeps(modules)
  return {
    async requireCommandable(sessionId, proc) {
      const resolved = await resolveSessionTarget(principal, sessionId, access)
      if (resolved.kind === 'absent') {
        throw new TRPCError({ code: 'NOT_FOUND', message: SESSION_NOT_FOUND })
      }
      await assertMayCommandSession(principal, resolved.session, proc, access, overrideScope)
      return resolved.session
    },
  }
}
