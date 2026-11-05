/**
 * THE AGENT-PROFILE SURFACE (POD-6107; on the sync write entry point since
 * POD-6412). The reads come from the query table through the derived-family
 * builder. The writes go through `sync.submit` (`sync-write.ts`).
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { legacyRouteAdapters } from '../sync-write/family'
import { AGENT_PROFILE_QUERIES } from './queries'
import { type AGENT_PROFILE_COMMANDS_TRPC, selectAgentProfileState } from './registry'
import { AGENT_PROFILE_SYNC_FAMILY } from './sync-write'

export type AgentProfileProcedures = FamilyProcedures<
  typeof AGENT_PROFILE_COMMANDS_TRPC,
  typeof AGENT_PROFILE_QUERIES
>

/** Spread into `router.ts`'s `agentProfiles` router. */
export const agentProfileFamilyProcedures = (): AgentProfileProcedures => ({
  ...derivedFamilyProcedures({
    family: 'agentProfiles',
    service: selectAgentProfileState,
    commands: {},
    queries: AGENT_PROFILE_QUERIES,
  }),
  // LEGACY(remove-after: 2027-03): an older CLI's `podium profile` calls these
  // routes. Removing them breaks that CLI's profile edits against this server.
  ...legacyRouteAdapters(AGENT_PROFILE_SYNC_FAMILY, ['create', 'update', 'delete', 'import']),
})
