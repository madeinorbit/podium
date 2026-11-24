/** One live delegation resolution for session commands and launch preflight. */
import type { Capability } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'

/**
 * The principal behind `capability` in these modules' store: the capability
 * must be this workspace's, and its human a member here (POD-7558). The
 * delegation chain is walked from live session rows.
 */
export async function sessionPrincipal(
  modules: RegistryModules,
  capability: Capability,
): Promise<CommandPrincipal> {
  return await modules.sessions.principalFor(capability)
}
