/**
 * THE SESSION FAMILY'S OUTBOX COMMANDS ON THE SYNC WRITE ENTRY POINT
 * (POD-6350, ADR 12 D2).
 *
 * Twelve of the commands the apps queue, from three envelopes, each registered
 * with the family's own target resolver and handler. The entry point owns the
 * rest: parse, `authorize`, dedup by the envelope's mutationId, provenance, one
 * unit of work and the receipt. So every handler here runs WITHOUT its old
 * envelope's dedup: a second `apply` under the same mutationId, inside the entry
 * point's, would wait on itself.
 *
 *  - SESSION STATE (`session-state/registry.ts`): pins, tab order, snoozes, read
 *    marks, archive, work state, offer dismissal. The target is everything that
 *    envelope checks before `authorize`.
 *  - RENAME (`rename-target-path.ts`, POD-351's target path): the owned target
 *    and the live delegation ceiling. A rename the precedence rule refuses
 *    (SP-eb60) is a definitive `conflict`.
 *  - THE CHAT SENDS (`command-plane.ts`): the target resolver runs the plane's own
 *    gates (`SessionCommandCtx.target`: issue scope or parenthood, machine `use`)
 *    and refuses on a denial. An ABSENT session is not refused there: the handler
 *    answers it with the pinned dead-letter reply (POD-379), which the client's
 *    reply reader interprets. A send that names a model or an effort wakes a
 *    process with a launch choice; it stays off this path until POD-6356 (plan
 *    Task 13) and is refused here as invalid.
 */

import {
  type CommandDef,
  type SessionRenameInput,
  sessionCommandPlane,
  sessionRenameContract,
} from '@podium/commands'
import { MessageId, type SessionId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, type SyncWriteRegistry } from '../sync-write/registry'
import { sessionCommandCtx } from './command-ctx'
import { SESSION_COMMAND_HANDLERS, type SessionCommandCtx } from './command-plane'
import { applyRename, mayWrite, ownedTarget } from './rename-target-path'
import {
  type SessionStateDeps,
  sessionStateCommandForSync,
  sessionStatePrincipalFor,
} from './session-state/registry'

/** The session-state commands the apps queue (client `OUTBOX_COMMANDS`). */
export const QUEUED_SESSION_STATE_COMMANDS = [
  'pins.set',
  'tabs.setOrder',
  'sessions.setArchived',
  'sessions.setWorkState',
  'snoozes.set',
  'snoozes.clear',
  'sessions.markRead',
  'sessions.markUnread',
  'sessions.dismissOffer',
] as const

/** The chat sends: one handler table, two lifecycles. */
export const QUEUED_SEND_COMMANDS = ['sendText', 'resumeAndSend'] as const

export interface SessionSyncWriteDeps {
  modules(): RegistryModules
}

function sessionStateDeps(modules: RegistryModules): SessionStateDeps {
  return {
    sessions: modules.sessions,
    state: modules.sessions.state,
    mutations: modules.mutations,
  }
}

function registerSessionState(registry: SyncWriteRegistry, deps: SessionSyncWriteDeps): void {
  for (const name of QUEUED_SESSION_STATE_COMMANDS) {
    const command = sessionStateCommandForSync(name)
    if (!command) throw new Error(`sync write: no session-state command named ${name}`)
    registry.register({
      name,
      def: command.def,
      target: async (input, { principal }) =>
        (await command.target(
          input as Record<string, unknown>,
          sessionStatePrincipalFor(principal),
          sessionStateDeps(deps.modules()),
        )) ?? undefined,
      handle: async (ctx, input) =>
        await command.handle(
          input as Record<string, unknown>,
          sessionStatePrincipalFor(ctx.principal),
          sessionStateDeps(deps.modules()),
        ),
    })
  }
}

function registerRename(registry: SyncWriteRegistry, deps: SessionSyncWriteDeps): void {
  registry.register({
    contract: sessionRenameContract,
    target: async (input, { principal }) => {
      const target = await ownedTarget(
        { sessions: deps.modules().sessions },
        (input as SessionRenameInput).sessionId,
      )
      // The live delegation ceiling: an agent's human must still hold the
      // session. `authorize` alone cannot ask that.
      return target !== undefined && mayWrite(principal, target) ? target : undefined
    },
    handle: async (ctx, input) => {
      const outcome = await applyRename(
        { sessions: deps.modules().sessions },
        input as SessionRenameInput,
        ctx.principal,
      )
      if (!outcome.ok) {
        throw new SyncWriteRefused(
          { kind: 'conflict' },
          { cause: new TRPCError({ code: 'CONFLICT', message: outcome.reason }) },
        )
      }
      return outcome
    },
  })
}

/** The plane's per-call context for a principal: its gates and its mail port. */
async function planeCtx(deps: SessionSyncWriteDeps, principal: CommandPrincipal) {
  if (principal.kind === 'system') throw new Error('a system principal has no chat send')
  return await sessionCommandCtx(deps.modules(), principal.capability)
}

/** The wake choices a send may carry, which this path does not take yet. */
const WAKE_CHOICES = ['model', 'effort', 'forceUnknownModel'] as const

function registerSends(registry: SyncWriteRegistry, deps: SessionSyncWriteDeps): void {
  for (const key of QUEUED_SEND_COMMANDS) {
    const name = `sessions.${key}`
    const def = (sessionCommandPlane.defs as Record<string, CommandDef>)[key]
    if (!def) throw new Error(`sync write: no command-plane contract named ${name}`)
    const handler = SESSION_COMMAND_HANDLERS[key] as (
      ctx: SessionCommandCtx,
      input: unknown,
    ) => Promise<unknown>
    registry.register({
      name,
      def,
      target: async (input, { principal }) => {
        const plane = await planeCtx(deps, principal)
        try {
          // Resolves the session and runs the plane's gates; undefined when
          // the session is absent, which the handler answers (see the header).
          await plane.target((input as { sessionId: SessionId }).sessionId, name)
        } catch {
          return undefined
        }
        return NO_TARGET
      },
      handle: async (ctx, raw) => {
        const input = raw as Record<string, unknown> & { sessionId: SessionId }
        const wake = WAKE_CHOICES.filter((field) => input[field] !== undefined)
        if (wake.length > 0) throw new SyncWriteRefused({ kind: 'invalid', details: wake })
        // A chat send's mutationId IS its message's id (POD-4763). The envelope
        // carries it; an input that does not repeat it still names the message.
        const withId =
          input.mutationId === undefined && MessageId.safeParse(ctx.mutationId).success
            ? { ...input, mutationId: ctx.mutationId }
            : input
        const plane = await planeCtx(deps, ctx.principal)
        const residency = deps.modules().sessions.residency
        const run = async () => await handler(plane, withId)
        return residency ? await residency.withSession(input.sessionId, name, run) : await run()
      },
    })
  }
}

export function registerSessionCommands(
  registry: SyncWriteRegistry,
  deps: SessionSyncWriteDeps,
): void {
  registerSessionState(registry, deps)
  registerRename(registry, deps)
  registerSends(registry, deps)
}
