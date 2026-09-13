import { asMachineId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { checkMachineVerb, ownershipSnapshotFromMachines } from '../../machine-access'
import { type Context, t } from '../../trpc'
import { familyState } from '../derived-family'
import { adminFloorMessage, adminFloorRefusal } from '../../command-principal'
import { roleFloorDeps } from '../role-floor'

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

/**
 * THE ADMIN FLOOR FOR ALL THREE OPERATION CONTRACTS, taken against the ACCOUNT
 * rather than against the transport (PDM-299).
 *
 * WHAT THIS USED TO READ, and why it was the odd one out: `ctx.principal
 * .capability.role !== 'admin'`. For a human that is exactly right by accident
 * — `userCommandPrincipal` mints the capability role FROM the account row on
 * every request and `UserRole` has only two members, so `capability.role ===
 * 'admin'` is equivalent to the live store role. For an AGENT it was the wrong
 * question asked of the wrong field: `relay.ts` and `SessionAuthz` hard-code
 * `role: 'worker'` on every live agent capability, so this line refused every
 * agent — not because a rule decided anything, but because no mint can produce
 * the value it compared against.
 *
 * That made the refusal untestable in the only way that matters. An assertion
 * that "an agent is refused" passed here for the wrong reason (false-green
 * catalogue entry 14), and it would have kept passing if the rule were deleted.
 *
 * Now the account grade is resolved through {@link roleFloorDeps} — the same
 * construction `fleetAuthzDeps`, `settingsAuthzDeps` and the derived builder
 * use, reading the delegating human's role LIVE (ADR 9 D5 A1) — and the
 * decision is {@link adminFloorRefusal}, the one function all five sites go
 * through. An agent is refused because the RULE refuses it, which is a thing a
 * test can break.
 *
 * NO CONTRACT IS CONSULTED HERE YET, and that is deliberate scope. All three
 * contracts declare `roleFloor: 'admin'` and this file hard-codes the same
 * floor, so they agree — but the family joins no contract table, so no builder
 * governs it. `PDM-297` owns that join; when it lands, this whole function
 * becomes `roleFloorFailure(qualifiedName, contract, deps)` and the hard-coded
 * floor goes with it.
 */
async function assertActionAuthorized(ctx: Context, operationId: string): Promise<void> {
  const { principal, role } = await roleFloorDeps(ctx)
  const refusal = adminFloorRefusal(principal.kind, role)
  if (refusal !== undefined) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: adminFloorMessage('operation recovery requires an admin account', refusal),
    })
  }

  const operation = (await operationsModule(ctx).engine.get(operationId))?.operation
  const details: Record<string, unknown> =
    operation?.details && typeof operation.details === 'object'
      ? (operation.details as Record<string, unknown>)
      : {}
  const targetMachineId = details.targetMachineId
  if (typeof targetMachineId !== 'string') return

  const failure = checkMachineVerb(
    principal,
    asMachineId(targetMachineId),
    await ownershipSnapshotFromMachines(familyState(ctx).modules.machines),
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
        const row = await engine.active(input?.group)
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
      .query(async ({ ctx, input }) =>
        (await operationsModule(ctx)
          .engine.history(input?.kind, input?.limit))
          .map((row) => JSON.parse(row.payload) as unknown),
      ),

    /**
     * Cancel, when the step in flight says it is safe to (§3.2). A refusal is a
     * RETURNED VALUE rather than an error: "this can't be canceled now, it will
     * finish or fail" is a sentence the panel renders, not an exception it
     * catches.
     */
    /**
     * THE FLOOR THIS PROCEDURE DECLARED AND DID NOT ASK FOR (PDM-294).
     *
     * `operations.cancel`'s contract carries the same policy as `settleAsk` and
     * `action` — `roleFloor: 'admin'`, `resource: 'machine'`,
     * `machineVerb: 'manage'` — and its rationale says so in as many words:
     * *"only an admin who can manage the operation target may invoke it"*. Two
     * of the three went through {@link assertActionAuthorized} and this one did
     * not, so any signed-in member could tear down another person's lifecycle
     * staging mid-flight.
     *
     * The SAME function, deliberately, rather than a second admin comparison in
     * this file: the three contracts declare the identical policy, and two
     * spellings of one rule is how the two stop agreeing.
     */
    cancel: t.procedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        await assertActionAuthorized(ctx, input.id)
        return operationsModule(ctx).engine.cancel(input.id)
      }),

    settleAsk: t.procedure
      .input(z.object({ id: z.string(), actionId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        await assertActionAuthorized(ctx, input.id)
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
        await assertActionAuthorized(ctx, input.id)
        return operationsModule(ctx).engine.dispatchAction(
          input.id,
          input.actionId,
          ctx.principal,
          { settleAsk: false },
        )
      }),
  }
}
