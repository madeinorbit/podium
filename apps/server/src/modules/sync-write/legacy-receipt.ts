// LEGACY(remove-after: 2027-03): solo-install receipts without actor metadata; removing this drops retry compatibility across the multi-user upgrade.
import type { MutationId, UserId } from '@podium/model'
import type { AppliedMutationFallback } from '@podium/sync'

/** Reserved storage namespace, never eligible for the legacy raw-id fallback. */
export const SCOPED_MUTATION_PREFIX = 'podium:actor:v1:'

/** Old receipts belong to the install's original sole member, including their agents. */
export function legacyMutationFallback(
  id: MutationId,
  human: UserId,
  boundary: { owner: UserId | null; before: number },
): AppliedMutationFallback | undefined {
  if (human !== boundary.owner || id.startsWith(SCOPED_MUTATION_PREFIX)) return undefined
  return { mutationId: id, before: boundary.before }
}
