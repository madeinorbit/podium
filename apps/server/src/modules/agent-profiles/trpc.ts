/**
 * THE AGENT-PROFILE READS (POD-6107): `list`, `show`, `export`, for the CLI,
 * which has no replica. The app reads profiles from its pool (the synced
 * `agentProfile` kind, POD-6676), and every write is a generic edit on
 * `sync.submit` (`records.agentProfile.*`, `records.ts`).
 */

import { derivedFamilyProcedures, type QueryProcedures } from '../derived-family'
import { AGENT_PROFILE_QUERIES } from './queries'
import { selectAgentProfileState } from './registry'

export type AgentProfileProcedures = QueryProcedures<typeof AGENT_PROFILE_QUERIES>

/** Spread into `router.ts`'s `agentProfiles` router. */
export const agentProfileFamilyProcedures = (): AgentProfileProcedures =>
  derivedFamilyProcedures({
    family: 'agentProfiles',
    service: selectAgentProfileState,
    queries: AGENT_PROFILE_QUERIES,
  })
