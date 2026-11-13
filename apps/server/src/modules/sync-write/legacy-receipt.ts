// LEGACY(remove-after: 2027-03): solo-install receipts without actor metadata; removing this drops retry compatibility across the multi-user upgrade.
import { asMutationId, type MutationId, type UserId } from '@podium/model'
import type { AppliedMutationFallback } from '@podium/sync'
import type { CommandPrincipal } from '../../command-principal'

/** Reserved storage namespace, never eligible for the legacy raw-id fallback. */
export const SCOPED_MUTATION_PREFIX = 'podium:actor:v1:'

/** Durable and in-flight receipt key for one authenticated actor's wire id. */
export function scopedMutationId(principal: CommandPrincipal, id: MutationId): MutationId {
  const actor =
    principal.kind === 'user'
      ? ['user', principal.user]
      : principal.kind === 'agent'
        ? ['agent', principal.agentSessionId, principal.onBehalfOf]
        : ['system', principal.job]
  return asMutationId(SCOPED_MUTATION_PREFIX + JSON.stringify([...actor, id]))
}

/** Old receipts belong to the install's original sole member, including their agents. */
export function legacyMutationFallback(
  id: MutationId,
  human: UserId,
  boundary: { owner: UserId | null; before: number },
): AppliedMutationFallback | undefined {
  if (human !== boundary.owner || id.startsWith(SCOPED_MUTATION_PREFIX)) return undefined
  return { mutationId: id, before: boundary.before }
}
