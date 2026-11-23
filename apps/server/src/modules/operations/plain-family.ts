/**
 * The operation engine's writes on the plain path (ADR 12 D8, POD-6593).
 *
 * An operation row is the engine's own journal, not a synced kind: nothing a
 * cancel or an answered ask changes reaches a device's replica. So each is a
 * plain command: the front door, then the engine, as the caller. Declared here
 * because they had no declaration before; their routes keep their schemas and
 * their answers (`trpc.ts`).
 *
 * THE ADMIN GATE stays the handler's, in the engine's own words: recovery
 * actions need an admin account, and a target machine named in the operation's
 * details must be one the caller can manage.
 *
 * THE ENGINE'S WORK IS THE SERVER'S OWN. A cancel, an answered ask or a recovery
 * action can drive the operation in-band (its steps, its cleanup, the effect
 * record it executes), exactly as the engine's own timers do. The command
 * answers or starts that work; it does not write through it. So the engine call
 * runs outside the plain scope (`asSystemWrite`), and the writes it makes are
 * the engine's, under the origins it already has.
 */

import { type CommandDef, defineCommands } from '@podium/commands'
import { asMachineId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import { checkMachineVerb, ownershipSnapshotFromMachines } from '../../machine-access'
import { asSystemWrite } from '../../plain-command-scope'
import type { RegistryModules } from '../../relay'
import type { PlainDefRegistration } from '../plain-command/registry'

const operationRef = z.object({ id: z.string() })
const operationAction = z.object({ id: z.string(), actionId: z.string() })

export const operationCommands = defineCommands('operations', {
  cancel: {
    input: operationRef,
    action: 'write',
    exposure: ['trpc'],
    cli: { summary: 'Cancel the live operation, when its step in flight says it is safe to.' },
  },
  settleAsk: {
    input: operationAction,
    action: 'write',
    exposure: ['trpc'],
    cli: { summary: "Answer an operation's ask and settle it." },
  },
  action: {
    input: operationAction,
    action: 'write',
    exposure: ['trpc'],
    cli: { summary: 'Run a recovery action on an operation.' },
  },
} satisfies Record<'cancel' | 'settleAsk' | 'action', CommandDef>)

/** Recovery needs an admin; a named target machine must be one the caller manages. */
export async function assertActionAuthorized(
  modules: RegistryModules,
  principal: CommandPrincipal,
  operationId: string,
): Promise<void> {
  if (principal.kind !== 'system' && principal.capability.role !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'operation recovery requires an admin account',
    })
  }

  const operation = (await modules.operations.engine.get(operationId))?.operation
  const details: Record<string, unknown> =
    operation?.details && typeof operation.details === 'object'
      ? (operation.details as Record<string, unknown>)
      : {}
  const targetMachineId = details.targetMachineId
  if (typeof targetMachineId !== 'string') return

  const failure = checkMachineVerb(
    principal,
    asMachineId(targetMachineId),
    await ownershipSnapshotFromMachines(modules.machines),
    'manage',
  )
  if (!failure) return
  throw new TRPCError({
    code: failure === 'absent' ? 'NOT_FOUND' : 'FORBIDDEN',
    message:
      failure === 'absent'
        ? `unknown machine '${targetMachineId}'`
        : `you cannot manage machine '${targetMachineId}'`,
  })
}

type OperationActionInput = z.infer<typeof operationAction>

const dispatchAs =
  (settleAsk: boolean): PlainDefRegistration['handle'] =>
  async (ctx, input, { modules }) => {
    const { id, actionId } = input as OperationActionInput
    await assertActionAuthorized(modules, ctx.principal, id)
    const { engine } = modules.operations
    return await asSystemWrite(
      async () => await engine.dispatchAction(id, actionId, ctx.principal, { settleAsk }),
    )
  }

export const OPERATION_PLAIN_REGISTRATIONS: readonly PlainDefRegistration[] = [
  {
    name: 'operations.cancel',
    def: operationCommands.defs.cancel,
    handle: async (_ctx, input, { modules }) => {
      const { engine } = modules.operations
      const { id } = input as z.infer<typeof operationRef>
      return await asSystemWrite(async () => await engine.cancel(id))
    },
  },
  {
    name: 'operations.settleAsk',
    def: operationCommands.defs.settleAsk,
    handle: dispatchAs(true),
  },
  {
    name: 'operations.action',
    def: operationCommands.defs.action,
    handle: dispatchAs(false),
  },
]
