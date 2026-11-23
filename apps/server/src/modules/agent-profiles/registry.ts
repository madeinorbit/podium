/**
 * WHAT THE AGENT-PROFILE READS REACH (POD-6107). The writes are the synced
 * record's generic edits since POD-6676 (`records.ts`); what is left here is
 * the state the query table (`queries.ts`) runs over.
 */

import type { FamilyState } from '../derived-family'
import type { AgentProfileCaller, AgentProfileService } from './service'

/** Exactly what the agent-profile reads reach, named. */
export interface AgentProfileState {
  readonly profiles: AgentProfileService
  readonly caller: AgentProfileCaller
}

/** The service plus WHO is asking: identity only, no capability. */
export function selectAgentProfileState(
  state: Pick<FamilyState, 'modules' | 'caller'>,
): AgentProfileState {
  return {
    profiles: state.modules.agentProfiles,
    caller: { userId: state.caller.userId, actorSessionId: state.caller.actorSessionId ?? null },
  }
}
