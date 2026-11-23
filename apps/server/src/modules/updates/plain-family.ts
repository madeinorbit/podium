/** Plain update declarations and handlers, without transport adapters. */
import { type CommandDef, defineCommands } from '@podium/commands'
import { asMachineId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { serverBuildVersion } from '../../build-version'
import type { Context } from '../../trpc'
import { familyState } from '../derived-family'
import { type PlainDefRegistration, trpcRequest } from '../plain-command/registry'
import { approveReleaseProposal, assertMayUpdate, updateFleet } from './handlers'
import { legacyInstanceTrustMessage } from './service'

export const updateCommands = defineCommands('updates', {
  approveProposal: {
    input: z.object({ headSha: z.string().min(1), version: z.string().min(1) }),
    action: 'write',
    exposure: ['trpc'],
    conflict: 'n/a',
    visibility: 'deployment-substrate',
  },
  checkNow: {
    input: z.undefined().optional(),
    action: 'write',
    exposure: ['trpc'],
    conflict: 'n/a',
    visibility: 'deployment-substrate',
  },
  repairPayload: {
    input: z.object({ id: z.string().min(1).optional() }).optional(),
    action: 'write',
    exposure: ['trpc'],
    conflict: 'n/a',
    visibility: 'deployment-substrate',
  },
  repairCompatibility: {
    input: z.undefined().optional(),
    action: 'write',
    exposure: ['trpc'],
    conflict: 'n/a',
    visibility: 'deployment-substrate',
  },
} satisfies Record<string, CommandDef>)

export type UpdateCommandName = keyof typeof updateCommands.defs

type UpdateHandler<N extends UpdateCommandName> = (
  ctx: Context,
  input: z.output<(typeof updateCommands.defs)[N]['input']>,
) => unknown

/** The plain update handlers, each over the tRPC request it is served on. */
export const UPDATE_PLAIN_HANDLERS = {
  approveProposal: async (ctx, input) => await approveReleaseProposal(ctx, input),
  /**
   * "Check for updates now" (spec §9.2). The daily timer answers "is anything
   * new"; this answers it for a human who is looking at the panel and does not
   * want to wait a day. Rate-limited per channel inside the service, so a
   * held-down button is one feed request, not a loop.
   */
  checkNow: async (ctx) => await familyState(ctx).modules.updates.checkNow(),
  /** Explicit byte repair: same target and same grant machinery, equality notwithstanding. */
  repairPayload: async (ctx, input) => {
    assertMayUpdate(ctx)
    const state = familyState(ctx)
    const machineId = input?.id ? asMachineId(input.id) : state.store.hostMachine?.id
    if (!machineId)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This server has no host machine to repair. Name a machine to repair its payload.',
      })
    const outcome = await state.modules.updates.repairMachine(machineId, {
      initiator: { kind: 'operator-repair' },
      eligibility: "a person asked for this machine's payload to be re-delivered",
    })
    const machineName =
      (await state.modules.updates.fleet()).find((machine) => machine.id === machineId)?.name ??
      machineId
    if (outcome.result !== 'granted' && outcome.result !== 'in-flight') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          outcome.result === 'no-target'
            ? outcome.reason
            : outcome.result === 'legacy-instance-trust'
              ? legacyInstanceTrustMessage(machineName)
              : `Payload repair is ${outcome.result}.`,
      })
    }
    return { outcome, fleet: await updateFleet(ctx) }
  },
  repairCompatibility: async (ctx) => {
    assertMayUpdate(ctx)
    if (!ctx.requestCoordinatorRestart) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This Podium installation cannot rebuild its web app automatically.',
      })
    }
    await ctx.requestCoordinatorRestart()
    return { state: 'in-progress' as const, version: serverBuildVersion() }
  },
} satisfies { [N in UpdateCommandName]: UpdateHandler<N> }

/** The plain update commands, registered in `plain-command/commands.ts`. */
export const UPDATE_PLAIN_REGISTRATIONS: readonly PlainDefRegistration[] = (
  Object.keys(updateCommands.defs) as UpdateCommandName[]
).map((name) => ({
  name: `updates.${name}`,
  def: updateCommands.defs[name],
  handle: async (ctx, input, source) =>
    await (UPDATE_PLAIN_HANDLERS[name] as UpdateHandler<UpdateCommandName>)(
      trpcRequest(ctx, source),
      input as never,
    ),
}))
