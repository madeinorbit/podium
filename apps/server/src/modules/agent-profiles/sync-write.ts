/**
 * THE AGENT-PROFILE WRITES ON THE SYNC WRITE ENTRY POINT (POD-6412, ADR 12 D2).
 *
 * The family's table, unchanged, on the sync family builder. The target check is
 * the contract's role floor (admin) read live; the service keeps its own
 * people-only rule (flight deck D4), and its refusals reach the caller with
 * their message.
 */

import { humanWithRoleFloor, type SyncFamily, trpcErrorRefusal } from '../sync-write/family'
import {
  AGENT_PROFILE_COMMANDS_TRPC,
  type AgentProfileState,
  selectAgentProfileState,
} from './registry'
import { AgentProfileRefusal } from './service'

export const AGENT_PROFILE_SYNC_FAMILY: SyncFamily<
  AgentProfileState,
  typeof AGENT_PROFILE_COMMANDS_TRPC
> = {
  family: 'agentProfiles',
  service: selectAgentProfileState,
  commands: AGENT_PROFILE_COMMANDS_TRPC,
  target: async (contract, _input, ctx) => await humanWithRoleFloor(contract, ctx),
  refusalOf: (error) =>
    error instanceof AgentProfileRefusal
      ? { kind: 'invalid', message: error.message }
      : trpcErrorRefusal(error),
}
