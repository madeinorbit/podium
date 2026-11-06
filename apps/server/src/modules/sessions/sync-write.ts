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
 *
 * And the command plane's writes that the apps send at once (POD-6416, plan
 * Task 16), on the same registration: `sessions.continue` (a stored `continue`
 * message for an agent; a keystroke for a shell, typed after the commit) and
 * `sessions.setIssueId` (the session-state envelope's own target and handler).
 * Their old routes are adapters onto `submit` ({@link submitPlaneCommand}).
 */

import { randomUUID } from 'node:crypto'
import {
  type CommandDef,
  type SessionRenameInput,
  sessionCommandPlane,
  sessionRenameContract,
} from '@podium/commands'
import { asMutationId, MessageId, type SessionId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { commandAccess } from '../issues/command-ctx'
import { ModelValidationError } from '../../model-validation'
import { SyncWriteRefused } from '../sync-write/entry'
import {
  NO_TARGET,
  type SyncWriteContext,
  type SyncWriteRegistry,
  type SyncWriteTarget,
  type SyncWriteTransport,
} from '../sync-write/registry'
import { refusalAsTrpcError } from '../sync-write/route-adapter'
import { sessionCommandCtx } from './command-ctx'
import {
  SESSION_COMMAND_HANDLERS,
  type SessionCommandCtx,
  type SessionCommandKey,
} from './command-plane'
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

/**
 * The session-state writes the apps send at once rather than queue. No shipped
 * client calls `sessions.setIssueId`, so it has no route: `sync.submit` is its
 * only door (POD-6416).
 */
export const IMMEDIATE_SESSION_STATE_COMMANDS = ['sessions.setIssueId'] as const

/** The command-plane writes on the entry point that are not queued (POD-6416). */
export const IMMEDIATE_PLANE_COMMANDS = ['continue'] as const

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

function registerSessionState(
  registry: SyncWriteRegistry,
  deps: SessionSyncWriteDeps,
  names: readonly string[],
): void {
  for (const name of names) {
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
async function planeCtx(
  deps: SessionSyncWriteDeps,
  principal: CommandPrincipal,
  overrideScope?: boolean,
) {
  if (principal.kind === 'system') throw new Error('a system principal has no chat send')
  return await sessionCommandCtx(deps.modules(), principal.capability, overrideScope)
}

/**
 * THE ISSUE SCOPE AS THE ENTRY POINT'S TARGET (POD-6416), as the issue family
 * answers it (`issueTarget`): a scoped caller's command on a session of an
 * issue names that issue, so `authorize` decides the scope with the envelope's
 * out-of-scope confirmation (`--outside-scope`) and answers
 * `confirmation-required` when it is missing. The plane's other gates (the
 * session exists and is visible, machine `use`, the issueless parent rule)
 * have run already.
 */
async function sessionIssueTarget(
  modules: RegistryModules,
  principal: CommandPrincipal,
  session: { issueId?: string | null; cwd: string },
): Promise<SyncWriteTarget> {
  if (principal.kind === 'system') return undefined
  const scope = principal.capability.scope
  if (scope.kind === 'all') return NO_TARGET
  const issueId = session.issueId ?? (await modules.issues.reports.issueForCwd(session.cwd))
  if (!issueId) return NO_TARGET
  const access = commandAccess(modules.issues)
  if (scope.kind === 'owned') return (await access.ownedTarget?.(issueId, 'write')) ?? undefined
  return { id: issueId, ancestorIds: await access.ancestorIds(issueId) }
}

/**
 * One command-plane command on the entry point. The target resolver runs the
 * plane's own gates and refuses on a denial; an ABSENT session is the
 * handler's to answer in its pinned shape (POD-379). The handler runs inside
 * the unit of work with its session resident.
 */
function registerPlaneCommand(
  registry: SyncWriteRegistry,
  deps: SessionSyncWriteDeps,
  key: SessionCommandKey,
  prepare: (ctx: SyncWriteContext, input: Record<string, unknown>) => Record<string, unknown>,
  /** Leave the issue scope to `authorize` ({@link sessionIssueTarget}), so the
   *  out-of-scope confirmation reaches it. The sends keep the plane's own check. */
  scopeByAuthorize = false,
): void {
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
      const plane = await planeCtx(deps, principal, scopeByAuthorize)
      let row: Awaited<ReturnType<SessionCommandCtx['target']>>
      try {
        // Resolves the session and runs the plane's gates; undefined when
        // the session is absent, which the handler answers (see the header).
        row = await plane.target((input as { sessionId: SessionId }).sessionId, name)
      } catch {
        return undefined
      }
      if (row === undefined || !scopeByAuthorize) return NO_TARGET
      return await sessionIssueTarget(deps.modules(), principal, row)
    },
    handle: async (ctx, raw) => {
      const input = prepare(ctx, raw as Record<string, unknown>) as Record<string, unknown> & {
        sessionId: SessionId
      }
      // The scope was decided at the target check (and confirmed, when it had
      // to be); the handler's own gate must not ask a second time.
      const plane = await planeCtx(deps, ctx.principal, scopeByAuthorize)
      const residency = deps.modules().sessions.residency
      const run = async () => {
        try {
          return await handler(plane, input)
        } catch (error) {
          // An explicit wake's invalid model or effort (POD-6415) is the
          // caller's to fix, refused with its own words; the route throws it.
          if (error instanceof ModelValidationError) {
            throw new SyncWriteRefused({ kind: 'invalid', message: error.message }, { cause: error })
          }
          throw error
        }
      }
      return residency ? await residency.withSession(input.sessionId, name, run) : await run()
    },
  })
}

function registerSends(registry: SyncWriteRegistry, deps: SessionSyncWriteDeps): void {
  for (const key of QUEUED_SEND_COMMANDS) {
    registerPlaneCommand(registry, deps, key, (ctx, input) => {
      // A wake choice (--model/--effort) is the plane's to take: it becomes a
      // `session.launch` resume record in this unit (POD-6415).
      // A chat send's mutationId IS its message's id (POD-4763). The envelope
      // carries it; an input that does not repeat it still names the message.
      return input.mutationId === undefined && MessageId.safeParse(ctx.mutationId).success
        ? { ...input, mutationId: ctx.mutationId }
        : input
    })
  }
}

/**
 * THE OLD ROUTE OF A PLANE COMMAND, AS AN ADAPTER ONTO `submit` (POD-6416),
 * for the transports that are not tRPC (the relay; tRPC goes through
 * `routeThroughEntry`). It answers as the route did: the result on `applied`;
 * the family's own error, else the refusal, thrown.
 *
 * The mutationId is the input's when it carries one (an older caller's retry
 * dedupes against itself), else fresh: deduplicated against nothing, which is
 * what a call without one always meant.
 */
export async function submitPlaneCommand(
  modules: RegistryModules,
  principal: CommandPrincipal,
  transport: SyncWriteTransport,
  call: { command: string; input: unknown; confirmed?: boolean },
): Promise<unknown> {
  const carried = (call.input as { mutationId?: unknown } | null | undefined)?.mutationId
  const { reply, cause } = await modules.syncWrite.submitDetailed(
    {
      mutationId: asMutationId(
        typeof carried === 'string' && carried.length > 0
          ? carried
          : `mut_${transport}_${randomUUID()}`,
      ),
      command: call.command,
      version: 1,
      input: call.input,
      ...(call.confirmed === true ? { confirmed: true as const } : {}),
    },
    principal,
    transport,
  )
  if (reply.outcome === 'applied') return reply.result
  if (cause !== undefined) throw cause
  throw refusalAsTrpcError(call.command, reply.refusal)
}

export function registerSessionCommands(
  registry: SyncWriteRegistry,
  deps: SessionSyncWriteDeps,
): void {
  registerSessionState(registry, deps, QUEUED_SESSION_STATE_COMMANDS)
  registerRename(registry, deps)
  registerSends(registry, deps)
}

/** The session family's writes that are sent at once (POD-6416). */
export function registerSessionFamilyCommands(
  registry: SyncWriteRegistry,
  deps: SessionSyncWriteDeps,
): void {
  registerSessionState(registry, deps, IMMEDIATE_SESSION_STATE_COMMANDS)
  for (const key of IMMEDIATE_PLANE_COMMANDS) {
    registerPlaneCommand(registry, deps, key, (_ctx, input) => input, true)
  }
}
