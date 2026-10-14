/**
 * THE JOIN — the agent-profile contracts (L1) paired with the
 * `AgentProfileService` methods that implement them (L3), per ADR 3 D1
 * (POD-6107). The people-only rule is the service's: every write receives the
 * caller and refuses an agent session.
 */

import {
  AGENT_PROFILE_CONTRACT_NAMES,
  AGENT_PROFILE_CONTRACTS,
  type AgentProfileContractName,
  type AnyCommandContract,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { FamilyState } from '../derived-family'
import type { AgentProfileCaller, AgentProfileService } from './service'

/** Exactly what the agent-profile family reaches, named. */
export interface AgentProfileState {
  readonly profiles: AgentProfileService
  readonly caller: AgentProfileCaller
}

export type AgentProfileHandler<In, Out> = (state: AgentProfileState, input: In) => Out

export interface AgentProfileCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: AgentProfileHandler<any, unknown>
}

type InputOf<N extends AgentProfileContractName> = z.infer<(typeof AGENT_PROFILE_CONTRACTS)[N]['input']>

export const AGENT_PROFILE_COMMANDS_TRPC = {
  create: {
    contract: AGENT_PROFILE_CONTRACTS.create,
    handler: (async (state, input) =>
      await state.profiles.create(state.caller, input)) satisfies AgentProfileHandler<InputOf<'create'>, unknown>,
  },
  update: {
    contract: AGENT_PROFILE_CONTRACTS.update,
    handler: (async (state, input) =>
      await state.profiles.update(state.caller, input)) satisfies AgentProfileHandler<InputOf<'update'>, unknown>,
  },
  delete: {
    contract: AGENT_PROFILE_CONTRACTS.delete,
    handler: (async (state, input) =>
      await state.profiles.delete(state.caller, input)) satisfies AgentProfileHandler<InputOf<'delete'>, unknown>,
  },
  import: {
    contract: AGENT_PROFILE_CONTRACTS.import,
    handler: (async (state, input) =>
      await state.profiles.import(state.caller, input)) satisfies AgentProfileHandler<InputOf<'import'>, unknown>,
  },
} as const satisfies Record<AgentProfileContractName, AgentProfileCommand>

export type AgentProfileCommandName = keyof typeof AGENT_PROFILE_COMMANDS_TRPC

export const isAgentProfileCommand = (name: string): name is AgentProfileCommandName =>
  Object.hasOwn(AGENT_PROFILE_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isAgentProfileCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isAgentProfileCommand(name)) return false
  return AGENT_PROFILE_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const agentProfileCommandsOn = (transport: TransportTag): AgentProfileCommandName[] =>
  AGENT_PROFILE_CONTRACT_NAMES.filter((n) => isAgentProfileCommandExposedOn(n, transport))

export const agentProfileRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(AGENT_PROFILE_COMMANDS_TRPC).map((c) => c.contract))

/** The service plus WHO is asking — identity only, no capability. */
export function selectAgentProfileState(state: FamilyState): AgentProfileState {
  return {
    profiles: state.modules.agentProfiles,
    caller: { userId: state.caller.userId, actorSessionId: state.caller.actorSessionId ?? null },
  }
}
