import { type PodiumSettings, resolveRole } from '@podium/runtime'

/** The configured coding-role harness used when a task leaves agent on Auto. */
export function codingRoleHarness(settings: PodiumSettings): string {
  return resolveRole(settings, 'coding').harness
}
