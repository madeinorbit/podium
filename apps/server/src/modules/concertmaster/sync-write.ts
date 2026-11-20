/**
 * THE CONCERTMASTER COMMANDS ON THE SYNC WRITE ENTRY POINT (POD-7211).
 *
 * THE AGENT'S (`say`, `ask`, `update`, `resolve`, `retract`) write the CALLING
 * session's conversation: the target is the session behind the capability,
 * never a value in the input, so an agent reaches no conversation but its own
 * (the `offer` commands' rule, `sessions/offer-sync-write.ts`). A caller with
 * no session behind it is refused before the handler.
 *
 * THE PERSON'S (`assign`, `respond`) name a session, and only its own human
 * may: marking a session and answering its agent are both driving it (design
 * §2.3, POD-6283), so the gate is `mayReachSession`, as for answering an agent's
 * question. Another member's session, an admin's call included, answers as
 * unknown. An agent's call is refused: a person's answer is theirs to give.
 *
 * Every write lands in the command's unit of work: the entries through the
 * repository's change-log commit (`feed.concertmaster`), the mark on the
 * session's record and the message to the agent with the command's own writer.
 */

import { concertmasterCommands } from '@podium/commands'
import { asSessionId, type SessionId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { senderFromInboxPrincipal } from '../messages/service'
import { inboxPrincipalFromCommand } from '../sessions/inbox'
import { SyncWriteRefused } from '../sync-write/entry'
import {
  NO_TARGET,
  refuseTarget,
  type SyncWriteRegistry,
  type SyncWriteTarget,
} from '../sync-write/registry'
import {
  CONCERTMASTER_NOT_SERVED,
  ConcertmasterRefusal,
  type ConcertmasterService,
} from './service'

export interface ConcertmasterSyncDeps {
  modules(): RegistryModules
}

/** The session behind the call, from the capability; never from the input. */
const actorOf = (principal: CommandPrincipal): SessionId | undefined =>
  principal.kind === 'system' ? undefined : principal.capability.actorSessionId

const NO_ACTOR = refuseTarget({
  kind: 'unauthorized',
  message: '`podium concertmaster` is only callable by an agent session (no actor bound)',
})

const PERSON_ONLY = refuseTarget({
  kind: 'unauthorized',
  message: 'Only the person a session works for can do this.',
})

/** One answer for a session that is missing and one the caller may not drive. */
const UNKNOWN_SESSION = refuseTarget({ kind: 'target-not-found', message: 'unknown session' })

/** The service's refusal as the entry point's. */
async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ConcertmasterRefusal) {
      throw new SyncWriteRefused({ kind: error.kind, message: error.message }, { cause: error })
    }
    throw error
  }
}

export function registerConcertmasterCommands(
  registry: SyncWriteRegistry,
  deps: ConcertmasterSyncDeps,
): void {
  const service = (): ConcertmasterService => {
    const found = deps.modules().concertmaster
    if (found === undefined) {
      throw new SyncWriteRefused({ kind: 'unauthorized', message: CONCERTMASTER_NOT_SERVED })
    }
    return found
  }

  const agentTarget = (_input: unknown, { principal }: { principal: CommandPrincipal }) =>
    actorOf(principal) === undefined ? NO_ACTOR : NO_TARGET

  const actor = (principal: CommandPrincipal): SessionId => {
    const sessionId = actorOf(principal)
    if (sessionId === undefined) throw new SyncWriteRefused(NO_ACTOR.syncWriteRefused)
    return sessionId
  }

  registry.register({
    name: 'concertmaster.say',
    def: concertmasterCommands.defs.say,
    target: agentTarget,
    handle: async (ctx, input) =>
      await refusing(async () => ({
        ok: true,
        ...(await service().say(actor(ctx.principal), input)),
      })),
  })
  registry.register({
    name: 'concertmaster.ask',
    def: concertmasterCommands.defs.ask,
    target: agentTarget,
    handle: async (ctx, input) =>
      await refusing(async () => ({
        ok: true,
        ...(await service().ask(actor(ctx.principal), input)),
      })),
  })
  registry.register({
    name: 'concertmaster.update',
    def: concertmasterCommands.defs.update,
    target: agentTarget,
    handle: async (ctx, input) =>
      await refusing(async () => ({
        ok: true,
        ...(await service().update(actor(ctx.principal), input)),
      })),
  })
  registry.register({
    name: 'concertmaster.resolve',
    def: concertmasterCommands.defs.resolve,
    target: agentTarget,
    handle: async (ctx, input) =>
      await refusing(async () => ({
        ok: true,
        ...(await service().resolve(actor(ctx.principal), input)),
      })),
  })
  registry.register({
    name: 'concertmaster.retract',
    def: concertmasterCommands.defs.retract,
    target: agentTarget,
    handle: async (ctx, input) =>
      await refusing(async () => ({
        ok: true,
        ...(await service().retract(actor(ctx.principal), input)),
      })),
  })

  /** A person, and a session they may drive: anything else is refused here. */
  const personTarget = async (
    input: { sessionId: string },
    { principal }: { principal: CommandPrincipal },
  ): Promise<SyncWriteTarget> => {
    if (principal.kind !== 'user') return PERSON_ONLY
    const sessionId = asSessionId(input.sessionId)
    return (await deps.modules().sessions.mayReachSession(principal.capability, sessionId))
      ? NO_TARGET
      : UNKNOWN_SESSION
  }

  registry.register({
    name: 'concertmaster.assign',
    def: concertmasterCommands.defs.assign,
    target: personTarget,
    handle: async (ctx, input) =>
      await refusing(
        async () => await service().assign(ctx.ledger, asSessionId(input.sessionId), input.on),
      ),
  })
  registry.register({
    name: 'concertmaster.respond',
    def: concertmasterCommands.defs.respond,
    target: personTarget,
    handle: async (ctx, input) =>
      await refusing(
        async () =>
          await service().respond(
            ctx.ledger,
            senderFromInboxPrincipal(inboxPrincipalFromCommand(ctx.principal)),
            {
              sessionId: asSessionId(input.sessionId),
              entryId: input.entryId,
              response: input.response,
              ...(input.text !== undefined ? { text: input.text } : {}),
            },
          ),
      ),
  })
}
