/**
 * AGENT PROFILES AS A SYNCED RECORD (POD-6676, ADR 12 D1/D3; design POD-5620
 * §1.9): `records.agentProfile.create` / `.edit` / `.remove` on the sync write
 * entry point. They replaced `agentProfiles.create/update/delete/import`; the
 * CLI parses import files itself and sends one generic write per profile.
 *
 * Today's rule, kept: profiles are instance substrate (every member reads them,
 * `deployment-substrate`), written by PEOPLE only (flight deck D4) who are
 * instance admins now. The target check decides both before the dedup, so a
 * replay from a demoted admin is refused; the service decides them again inside
 * the unit of work, with the rest of its rules (a unique name, a visible
 * machine, no removal while an open issue uses the profile). Each write commits
 * the row and its change entry together.
 */

import { AGENT_PROFILE_RECORD } from '@podium/commands'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { registerRecordKind } from '../records/generic'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, refuseTarget, type SyncWriteRegistry } from '../sync-write/registry'
import {
  type AgentProfileCaller,
  type AgentProfileRecordFields,
  AgentProfileRefusal,
} from './service'

export interface AgentProfileRecordDeps {
  modules(): RegistryModules
}

/** Who writes: the human, and the agent session when one is the caller. */
function callerOf(principal: CommandPrincipal): AgentProfileCaller | undefined {
  if (principal.kind === 'system') return undefined
  return principal.kind === 'agent'
    ? { userId: principal.onBehalfOf, actorSessionId: principal.agentSessionId }
    : { userId: principal.user, actorSessionId: null }
}

/** The service's refusal as the entry point answers it, with its words. */
const refusalOf = (error: unknown): never => {
  if (error instanceof AgentProfileRefusal) {
    throw new SyncWriteRefused({ kind: 'invalid', message: error.message }, { cause: error })
  }
  throw error
}

export function registerAgentProfileRecord(
  registry: SyncWriteRegistry,
  deps: AgentProfileRecordDeps,
): void {
  const profiles = () => deps.modules().agentProfiles
  const callerOrGone = (principal: CommandPrincipal): AgentProfileCaller => {
    const caller = callerOf(principal)
    if (caller === undefined) throw new SyncWriteRefused({ kind: 'target-not-found' })
    return caller
  }

  registerRecordKind(registry, AGENT_PROFILE_RECORD, {
    target: async (_op, _id, { principal }) => {
      const caller = callerOf(principal)
      if (caller === undefined) return undefined
      try {
        await profiles().assertMayWrite(caller)
      } catch (error) {
        if (error instanceof AgentProfileRefusal) {
          return refuseTarget({ kind: 'unauthorized', message: error.message })
        }
        throw error
      }
      return NO_TARGET
    },
    read: async (id) => ((await profiles().record(id)) === null ? undefined : {}),
    create: async (ctx, id, fields) => {
      try {
        await profiles().createRecord(
          callerOrGone(ctx.principal),
          ctx.ledger,
          id,
          fields as AgentProfileRecordFields,
        )
      } catch (error) {
        refusalOf(error)
      }
      return { ok: true }
    },
    edit: async (ctx, id, patch, _expected, unset) => {
      // Every optional cell of a profile is a value, never absent: nothing to clear.
      if (unset.length > 0) throw new SyncWriteRefused({ kind: 'invalid', details: ['unset'] })
      try {
        await profiles().editRecord(
          callerOrGone(ctx.principal),
          ctx.ledger,
          id,
          patch as AgentProfileRecordFields,
        )
      } catch (error) {
        refusalOf(error)
      }
      return { ok: true }
    },
    remove: async (ctx, id) => {
      try {
        await profiles().removeRecord(callerOrGone(ctx.principal), ctx.ledger, id)
      } catch (error) {
        refusalOf(error)
      }
      return { ok: true }
    },
  })
}
