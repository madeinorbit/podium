/**
 * AN AGENT NAMES ITS OWN SESSION ON THE SYNC WRITE ENTRY POINT (#490, POD-6601).
 *
 * `podium session title "…"` writes the curated `name` of the calling session,
 * stamped `nameSource = 'agent'`. The name is a field of the synced session
 * record, so the write is a sync command: it enters through `submit`,
 * deduplicates by the envelope's mutationId, and its session row carries the
 * command's provenance.
 *
 * THE TARGET IS THE CALLING SESSION, taken from the capability, never from the
 * input: an agent can only name its own session, so no scope check applies (a
 * session is always within its own scope), as `offer.set` reads it.
 *
 * A NAME THE USER GAVE IS SOVEREIGN (SP-eb60): `setAgentName` refuses against it
 * and the refusal is the answer, `{ ok: false, reason }`, never a throw, so the
 * CLI shows the user's name back to the agent.
 *
 * THE INPUT KEEPS ITS SENTENCES. The schema below only shapes the input (`name`,
 * or an older CLI's `title`); the handler answers a blank one with the sentence
 * the relay arm always gave.
 *
 * TRANSPORTS: the relay only (an agent's `podium session title`). There is no
 * tRPC route: a person renames with `sessions.rename`.
 */

import { type CommandDef, defineCommands } from '@podium/commands'
import type { SessionId } from '@podium/model'
import { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, refuseTarget, type SyncWriteRegistry } from '../sync-write/registry'

/** `name`, or an older CLI's `title`; checked by the handler (see the header). */
const TitleInput = z.object({ name: z.unknown().optional(), title: z.unknown().optional() })

export const sessionTitleCommands = defineCommands('sessions', {
  title: {
    input: TitleInput,
    action: 'write',
    exposure: ['relay'],
    conflict: 'single-writer',
    visibility: 'personal',
    cli: { summary: 'Name the calling session.' },
  },
} satisfies Record<'title', CommandDef>)

export const SESSION_TITLE_COMMAND = 'sessions.title' as const

/** The session behind the call, from the capability; never from the input. */
const actorOf = (principal: CommandPrincipal): SessionId | undefined =>
  principal.kind === 'system' ? undefined : principal.capability.actorSessionId

const NO_ACTOR = refuseTarget({
  kind: 'unauthorized',
  message: 'sessions.title is only callable by a session (no actor bound)',
})

export interface SessionTitleDeps {
  modules(): RegistryModules
}

export function registerSessionTitle(registry: SyncWriteRegistry, deps: SessionTitleDeps): void {
  registry.register({
    name: SESSION_TITLE_COMMAND,
    def: sessionTitleCommands.defs.title,
    target: (_input, { principal }) => (actorOf(principal) === undefined ? NO_ACTOR : NO_TARGET),
    handle: async (ctx, raw) => {
      const actor = actorOf(ctx.principal)
      if (actor === undefined) throw new SyncWriteRefused(NO_ACTOR.syncWriteRefused)
      const name = raw.name ?? raw.title
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new SyncWriteRefused({ kind: 'invalid', message: 'name is required' })
      }
      return await deps.modules().sessions.setAgentName({ sessionId: actor, name })
    },
  })
}
