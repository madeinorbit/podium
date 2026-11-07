/**
 * AN AGENT'S APPROVAL REQUEST ON THE SYNC WRITE ENTRY POINT (POD-6603, ADR 12
 * D2/D9).
 *
 * `podium approval request` files a held operation for a person to decide. It
 * was the relay arm's direct call into the service; it is a sync command now:
 * it enters through `submit`, the request row and its `issue.approval_requested`
 * activity event are written in the command's unit of work (the event carries
 * its provenance), and the pending-set broadcast follows the commit.
 *
 * THE TARGET IS THE CALLING SESSION. The relay binds the session and its
 * machine onto the input from the relay context (`relay-gate.ts`
 * `bindRelayContext`), never from the agent; the target check holds the
 * input's session to the capability's own, so no other session's request can be
 * filed, and no scope check applies (a session is always within its own scope),
 * as `sessions.title` reads it.
 *
 * AN IDENTICAL PENDING REQUEST IS ANSWERED, NOT DUPLICATED: the service's own
 * rule, so an agent retrying does not stack popups. `approvals.get` stays a
 * relay read.
 *
 * TRANSPORTS: the relay only. A person decides with `approvals.approve` and
 * `approvals.deny`; nobody files a request over tRPC.
 */

import { type CommandDef, defineCommands } from '@podium/commands'
import type { SessionId } from '@podium/model'
import { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { NO_TARGET, refuseTarget, type SyncWriteRegistry } from '../sync-write/registry'

/** The op and the relay context; the service parses the op with its own schema,
 *  so a bad one keeps the words it always had. */
const RequestInput = z.object({
  op: z.unknown().optional(),
  sessionId: z.unknown().optional(),
  machineId: z.unknown().optional(),
})

export const approvalRequestCommands = defineCommands('approvals', {
  request: {
    input: RequestInput,
    action: 'write',
    exposure: ['relay'],
    conflict: 'append',
    visibility: 'personal',
    cli: { summary: 'Ask a person to approve an operation for the calling session.' },
  },
} satisfies Record<'request', CommandDef>)

export const APPROVAL_REQUEST_COMMAND = 'approvals.request' as const

/** The session behind the call, from the capability; never from the input. */
const actorOf = (principal: CommandPrincipal): SessionId | undefined =>
  principal.kind === 'system' ? undefined : principal.capability.actorSessionId

const NO_ACTOR = refuseTarget({
  kind: 'unauthorized',
  message: 'approvals.request is only callable by a session (no actor bound)',
})

const NOT_YOURS = refuseTarget({
  kind: 'unauthorized',
  message: 'an approval request is filed by the calling session only',
})

export interface ApprovalRequestDeps {
  modules(): RegistryModules
}

export function registerApprovalRequest(
  registry: SyncWriteRegistry,
  deps: ApprovalRequestDeps,
): void {
  registry.register({
    name: APPROVAL_REQUEST_COMMAND,
    def: approvalRequestCommands.defs.request,
    target: (input, { principal }) => {
      const actor = actorOf(principal)
      if (actor === undefined) return NO_ACTOR
      return input.sessionId === actor ? NO_TARGET : NOT_YOURS
    },
    handle: async (ctx, input) =>
      await deps.modules().approvals.request(input, {
        afterCommit: (step, label) => ctx.afterCommit(step, label),
      }),
  })
}
