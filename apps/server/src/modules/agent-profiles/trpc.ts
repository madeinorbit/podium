/**
 * THE DERIVED AGENT-PROFILE SURFACE (POD-6107) — writes from the contract
 * table, reads from the query table, both through the one derived-family builder.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { AGENT_PROFILE_QUERIES } from './queries'
import { AGENT_PROFILE_COMMANDS_TRPC, selectAgentProfileState } from './registry'

export type AgentProfileProcedures = FamilyProcedures<
  typeof AGENT_PROFILE_COMMANDS_TRPC,
  typeof AGENT_PROFILE_QUERIES
>

/** Spread into `router.ts`'s `agentProfiles` router. */
export const agentProfileFamilyProcedures = (): AgentProfileProcedures =>
  derivedFamilyProcedures({
    family: 'agentProfiles',
    service: selectAgentProfileState,
    commands: AGENT_PROFILE_COMMANDS_TRPC,
    queries: AGENT_PROFILE_QUERIES,
  })
