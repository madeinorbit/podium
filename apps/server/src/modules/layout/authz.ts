/**
 * LIVE GATE FOR LAYOUT COMMANDS (POD-1350 / POD-402 review gap 1).
 *
 * The contracts declare `roleFloor: 'member'` and apply-time reauthorization.
 * Until this module existed, `layout/trpc.ts` only called `onBehalfOfUser` and
 * wrote — a disabled or below-floor principal who still resolved to a human
 * reached the store. This gate reads the contract's own floor LIVE (no cached
 * capability snapshot) and refuses before any handler runs.
 */

import { LAYOUT_CONTRACTS, type LayoutContractName } from '@podium/commands'
import type { UserId, UserRole } from '@podium/model'
import { TRPCError } from '@trpc/server'
import {
  type CommandPrincipal,
  onBehalfOfUser,
  resolvePrincipal,
} from '../../command-principal'
import { spawnedByParentSessionId } from '@podium/model'
import type { Context } from '../../trpc'
import { mods } from '../../trpc'

export interface LayoutAuthzDeps {
  readonly principal: CommandPrincipal
  /** Live account role, or undefined when there is no human / disabled account. */
  readonly role: UserRole | undefined
}

const ROLE_RANK: Record<UserRole, number> = { member: 1, admin: 2 }

function roleSatisfiesFloor(role: UserRole | undefined, floor: 'member' | 'admin'): boolean {
  if (role === undefined) return false
  return ROLE_RANK[role] >= ROLE_RANK[floor]
}

function isLayoutCommand(name: string): name is LayoutContractName {
  return Object.hasOwn(LAYOUT_CONTRACTS, name)
}

/**
 * Refusal for one layout command, or undefined to proceed. Returned rather than
 * thrown so the decision is testable without a tRPC request.
 */
export function layoutAuthzFailure(name: string, deps: LayoutAuthzDeps): TRPCError | undefined {
  if (!isLayoutCommand(name)) {
    return new TRPCError({ code: 'FORBIDDEN', message: `${name} is not a layout command` })
  }
  const { policy } = LAYOUT_CONTRACTS[name]
  if (deps.principal.kind === 'system') return undefined
  if (roleSatisfiesFloor(deps.role, policy.roleFloor)) return undefined
  return new TRPCError({
    code: 'FORBIDDEN',
    message: `${name} requires an ${policy.roleFloor} account`,
  })
}

/** Resolve principal + live role from a tRPC context (never from payload). */
export function layoutAuthzDeps(ctx: Context): LayoutAuthzDeps {
  const sessions = mods(ctx).sessions
  const principal = resolvePrincipal(ctx.capability, {
    parentSessionOf: (sessionId) =>
      spawnedByParentSessionId(
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
export function layoutActor(deps: LayoutAuthzDeps): UserId | null {
  return onBehalfOfUser(deps.principal)
}
