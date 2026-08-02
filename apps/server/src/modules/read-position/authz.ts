/**
 * LIVE GATE FOR FEED-CURSOR COMMANDS (POD-1380).
 *
 * Same shape and the same reason as `modules/layout/authz.ts`: the contract
 * declares `roleFloor: 'member'`, and the floor is read LIVE from the contract
 * (never from a cached capability snapshot) so a disabled or below-floor
 * principal that still resolves to a human is refused before the store is
 * reached.
 *
 * THE USER HALF IS NEVER TAKEN FROM THE PAYLOAD (ADR 3 D7). `readPositionActor`
 * resolves the acting human from the transport capability; the command input has
 * no user field for a client to assert. That is the whole privacy story of this
 * family: a cursor row is keyed by whoever the transport says is calling, so a
 * frame claiming to advance someone else's position cannot be written.
 */

import { READ_POSITION_CONTRACTS, type ReadPositionContractName } from '@podium/commands'
import type { UserId, UserRole } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { type CommandPrincipal, onBehalfOfUser, resolvePrincipal } from '../../command-principal'
import { sessionSpawnerParentId } from '../../steward'
import type { Context } from '../../trpc'
import { mods } from '../../trpc'

export interface ReadPositionAuthzDeps {
  readonly principal: CommandPrincipal
  /** Live account role, or undefined when there is no human / disabled account. */
  readonly role: UserRole | undefined
}

const ROLE_RANK: Record<UserRole, number> = { member: 1, admin: 2 }

function roleSatisfiesFloor(role: UserRole | undefined, floor: 'member' | 'admin'): boolean {
  if (role === undefined) return false
  return ROLE_RANK[role] >= ROLE_RANK[floor]
}

function isReadPositionCommand(name: string): name is ReadPositionContractName {
  return Object.hasOwn(READ_POSITION_CONTRACTS, name)
}

/**
 * Refusal for one read-position command, or undefined to proceed. Returned rather
 * than thrown so the decision is testable without a tRPC request.
 */
export function readPositionAuthzFailure(
  name: string,
  deps: ReadPositionAuthzDeps,
): TRPCError | undefined {
  if (!isReadPositionCommand(name)) {
    return new TRPCError({ code: 'FORBIDDEN', message: `${name} is not a feed cursor command` })
  }
  const { policy } = READ_POSITION_CONTRACTS[name]
  if (deps.principal.kind === 'system') return undefined
  if (roleSatisfiesFloor(deps.role, policy.roleFloor)) return undefined
  return new TRPCError({
    code: 'FORBIDDEN',
    message: `${name} requires an ${policy.roleFloor} account`,
  })
}

/** Resolve principal + live role from a tRPC context (never from payload). */
export function readPositionAuthzDeps(ctx: Context): ReadPositionAuthzDeps {
  const sessions = mods(ctx).sessions
  const principal = resolvePrincipal(ctx.capability, {
    parentSessionOf: (sessionId) =>
      sessionSpawnerParentId(
        sessions.listSessions().find((s) => s.sessionId === sessionId)?.spawnedBy,
      ),
  })
  const user = onBehalfOfUser(principal)
  return {
    principal,
    role: user === null ? undefined : ctx.registry.sessionStore.users.roleOf(user),
  }
}

/** Human the write belongs to, or null (system / no on-behalf-of). */
export function readPositionActor(deps: ReadPositionAuthzDeps): UserId | null {
  return onBehalfOfUser(deps.principal)
}
