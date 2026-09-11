import { firstAdminMemberId, type Capability } from '@podium/model'
import type { SessionStatePrincipal } from '../modules/sessions/session-state/service'

/**
 * Compatibility constructor for the first administrator. A direct human now has
 * `actorUser` attribution, so directness is identified by the absence of an agent
 * session rather than by an empty actor slot.
 *
 * A FUNCTION, not a constant, so a caller cannot mutate the shared object — and
 * so every call site that will need a real principal is one grep away.
 *
 * IT SPELLED THE LITERAL UNTIL A2. `asUserId(SOLE_USER_ID)` was correct while
 * the first admin's row carried that id; after the migration re-keys it, the
 * literal names no member, and the per-user-state store REFUSES a principal with
 * no active account — "no active account for session-state user user:sole",
 * which is the failure shape this resolution avoids. The member is looked up
 * now, like every other ambient site.
 */
export function soleHumanSessionStatePrincipal(capability: Capability): SessionStatePrincipal {
  return {
    userId: firstAdminMemberId(),
    capability,
    onBehalfOf: firstAdminMemberId(),
    humanDirect: capability.actorSessionId === undefined,
  }
}

export function soleHumanSessionStateWsPrincipal(
  capability: Capability,
  clientId: string,
): SessionStatePrincipal {
  return { ...soleHumanSessionStatePrincipal(capability), clientId }
}
