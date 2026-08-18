import { asMachineId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { checkMachineVerb, ownershipFromMachines } from '../../machine-access'
import { type Context, t } from '../../trpc'
import { familyState } from '../derived-family'

/**
 * The operation surface (POD-2097, spec §3.0/§3.7). Three procedures, and the
 * first two are the whole of what a renderer needs.
 *
 * `active` SERVES THE STORED BYTES, not a projection of them. Two reasons, and
 * both are the frozen contract (P8): a server must be able to hand an old
 * bundle a field that bundle has never heard of, and a bundle must be able to
 * read a field its server did not invent. Anything this file re-shaped on the
 * way out would be a second definition of the contract, in the one place where
 * the two ends are guaranteed to be different builds — the web bundle is
 * swapped during the operation it is rendering.
 */

const operationsModule = (ctx: Context) => familyState(ctx).modules.operations

function assertActionAuthorized(ctx: Context, operationId: string): void {
  const principal = ctx.principal
  if (principal.kind !== 'system' && principal.capability.role !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'operation recovery requires an admin account',
    })
  }

  const operation = operationsModule(ctx).engine.get(operationId)?.operation
  const details =
    operation?.details && typeof operation.details === 'object' ? operation.details : {}
  const targetMachineId = details.targetMachineId
  if (typeof targetMachineId !== 'string') return

  const failure = checkMachineVerb(
    principal,
    asMachineId(targetMachineId),
    ownershipFromMachines(familyState(ctx).modules.machines),
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

export function operationProcedures() {
  return {
    /** The one live operation, or null. Null is the ordinary answer. */
    active: t.procedure
      .input(z.object({ group: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const engine = operationsModule(ctx).engine
        const row = engine.active(input?.group)
        return row ? await engine.project(row) : null
      }),

    /** The audit trail that today does not exist: "did last night's update finish?" */
    history: t.procedure
      .input(
        z
          .object({
            kind: z.string().optional(),
            limit: z.number().int().min(1).max(100).optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        operationsModule(ctx)
          .engine.history(input?.kind, input?.limit)
          .map((row) => JSON.parse(row.payload) as unknown),
      ),

    /**
     * Cancel, when the step in flight says it is safe to (§3.2). A refusal is a
     * RETURNED VALUE rather than an error: "this can't be canceled now, it will
     * finish or fail" is a sentence the panel renders, not an exception it
     * catches.
     */
    cancel: t.procedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => operationsModule(ctx).engine.cancel(input.id)),

    settleAsk: t.procedure
      .input(z.object({ id: z.string(), actionId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        assertActionAuthorized(ctx, input.id)
        return operationsModule(ctx).engine.dispatchAction(
          input.id,
          input.actionId,
          ctx.principal,
          { settleAsk: true },
        )
      }),

    action: t.procedure
      .input(z.object({ id: z.string(), actionId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        assertActionAuthorized(ctx, input.id)
        return operationsModule(ctx).engine.dispatchAction(
          input.id,
          input.actionId,
          ctx.principal,
          { settleAsk: false },
        )
      }),
  }
}
