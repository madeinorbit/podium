import { type CommandDef, defineCommands } from '@podium/commands'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { serverBuildVersion } from '../../build-version'
import {
  canSeeMachine,
  machineUseDecision,
  ownershipSnapshotFromMachines,
} from '../../machine-access'
import { t } from '../../trpc'
import { familyState } from '../derived-family'
import { LIFECYCLE_EXCLUSION_GROUP } from '../operations/lifecycle'
import type { WriteRoute } from '../write-routes/builder'
import { plainRoute } from '../write-routes/plain'
import { syncRoute } from '../write-routes/sync'
import {
  assertMayUpdate,
  legacyConvergeResult,
  releaseProposalFor,
  serverPlacementOf,
  startUpdateOperation,
  throwIfFailedOnStart,
  updateFleet,
} from './handlers'
import { UPDATE_OPERATION_KIND, UPDATE_STEP_MACHINES, type UpdateSurface } from './operation'
import type { UPDATE_PLAIN_HANDLERS, UpdateCommandName, updateCommands } from './plain-family'
import { readUpdateSpacePreview } from './space-preview'

export * from './handlers'
export { UPDATE_PLAIN_REGISTRATIONS } from './plain-family'

type PlainUpdateProcedure<N extends UpdateCommandName, Out> = WriteRoute<
  z.input<(typeof updateCommands.defs)[N]['input']>,
  Awaited<Out>
>

/** One update command's route, answering a refusal as it always did. */
function plainUpdate<N extends UpdateCommandName>(
  name: N,
): PlainUpdateProcedure<N, ReturnType<(typeof UPDATE_PLAIN_HANDLERS)[N]>> {
  return plainRoute(`updates.${name}`, {
    refused: (refusal) => {
      if (refusal.kind === 'invalid') {
        throw new TRPCError({ code: 'BAD_REQUEST', cause: refusal.error })
      }
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `updates.${name} is not permitted for this caller`,
      })
    },
  })
}

/**
 * The update writes that are effect records (POD-6358): the declarations their
 * old routes are served under. Each reaches `effects.create`.
 */
const updateEffectRoutes = defineCommands('updates', {
  start: {
    input: z.object({ surface: z.string().optional() }).optional(),
    action: 'write',
    exposure: ['trpc'],
  },
  retry: { input: z.object({ id: z.string() }), action: 'write', exposure: ['trpc'] },
  converge: { input: z.undefined().optional(), action: 'write', exposure: ['trpc'] },
} satisfies Record<'start' | 'retry' | 'converge', CommandDef>)

const effectRoute = (name: keyof typeof updateEffectRoutes.defs) => ({
  command: { name: `updates.${name}`, def: updateEffectRoutes.defs[name] },
  registration: 'effects.create',
})

export function updateProcedures() {
  return {
    /** Separate informational request. Never called by start/retry/converge. */
    checkSpace: t.procedure
      .input(
        z
          .object({
            scope: z.enum(['operation', 'all']).optional(),
            expectedVersion: z.string().optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        const state = familyState(ctx)
        const rows = await state.store.machines.listMachines()
        // Reuse the directory read: one grouped grant read supplies this call's
        // existing SEE/USE policy, without querying separately for each machine.
        const ownership = await ownershipSnapshotFromMachines({
          ownershipRows: () => rows,
          grantsForMachines: (ids) => state.store.grants.listForResources('machine', ids),
        })
        return readUpdateSpacePreview(
          {
            machines: async () => rows,
            // Keep the real host in the directory for operation-channel selection;
            // invisible machines are removed before any supervisor is probed.
            canSee: (id) => canSeeMachine(ctx.principal, id, ownership),
            target: (channel) => state.modules.updates.target(channel),
            fleetChannel: state.modules.updates.fleetDefaultChannel(),
            placement: serverPlacementOf(ctx),
            check: async (machineId, target, fingerprint) => {
              const estimate = await state.modules.machines.checkUpdateSpace(
                machineId,
                target,
                fingerprint,
              )
              if (machineUseDecision(ctx.principal, machineId, ownership) === 'granted')
                return estimate
              // SEE includes update health, not inventory paths, even for admins.
              // Keep the required wire field schema-valid with public volume labels;
              // freeform supervisor reasons can contain paths and stay private too.
              return {
                status: estimate.status,
                checkedAt: estimate.checkedAt,
                volumes: estimate.volumes.map((volume, index) => ({
                  ...volume,
                  path: `Volume ${index + 1}`,
                })),
              }
            },
          },
          input,
        )
      }),
    proposal: t.procedure.query(async ({ ctx }) => await releaseProposalFor(ctx)),
    approveProposal: plainUpdate('approveProposal'),
    fleet: t.procedure.query(async ({ ctx }) => await updateFleet(ctx)),
    checkNow: plainUpdate('checkNow'),
    repairPayload: plainUpdate('repairPayload'),
    repairCompatibility: plainUpdate('repairCompatibility'),
    /**
     * The one human click, as a durable operation (§3.2). Answers the operation
     * itself so the caller can render it immediately and then follow
     * `operations.active` — there is no second endpoint to learn.
     */
    start: syncRoute({
      ...effectRoute('start'),
      input: updateEffectRoutes.defs.start.input,
      run: async ({ ctx, input }) => {
        const started = await startUpdateOperation(ctx, {
          ...(input?.surface ? { surface: input.surface as UpdateSurface } : {}),
        })
        return {
          operationId: started.operationId,
          alreadyRunning: started.alreadyRunning,
          operation: started.operation,
        }
      },
    }),

    /**
     * RETRY (§3.2): a NEW operation whose plan is the remainder — the machines
     * that are still not at the target — linked to the one it retries. History
     * stays honest: the failure is not overwritten by its own second attempt.
     */
    retry: syncRoute({
      ...effectRoute('retry'),
      input: updateEffectRoutes.defs.retry.input,
      run: async ({ ctx, input }) => {
        assertMayUpdate(ctx)
        const engine = familyState(ctx).modules.operations.engine
        const row = (await engine.history(UPDATE_OPERATION_KIND, 100)).find(
          (r) => r.id === input.id,
        )
        if (!row) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'That update is no longer on record.',
          })
        }
        const previous = row.operation
        const machinesStep = (previous?.steps ?? []).find(
          (step) => step.id === UPDATE_STEP_MACHINES,
        )
        // The REMAINDER, from the failed operation's own record of where each
        // place got to. A place that reached the target is not retried — that is
        // what makes "Try again" cheap after a half-applied update (§8).
        const remainder = (machinesStep?.places ?? [])
          .filter((place) => place.state !== 'current')
          .map((place) => place.id)
        const started = await startUpdateOperation(ctx, {
          retryOf: input.id,
          ...(remainder.length > 0 ? { onlyMachines: remainder } : {}),
        })
        return {
          operationId: started.operationId,
          alreadyRunning: started.alreadyRunning,
          operation: started.operation,
        }
      },
    }),

    /**
     * KEPT FOR ONE RELEASE (POD-2098): the shipped dialog's entry point, now a
     * thin alias over `start`. It exists so this issue does not regress the live
     * UI while the operation panel is built in its own issue; the moment that
     * lands, this and its shape go.
     */
    converge: syncRoute({
      ...effectRoute('converge'),
      run: async ({ ctx }) => {
        const state = familyState(ctx)
        const engine = state.modules.operations.engine
        const started = await startUpdateOperation(ctx)
        /**
         * THE ONE PLACE THAT WAITS, and only because the OLD contract does.
         *
         * `engine.start` deliberately no longer awaits the drive: a click must not
         * be held for the length of the first runner. But this endpoint's shipped
         * caller reads `done`, `total` and `grantedMachineIds` out of the
         * response, and it has no way to hear about a failure except a rejection
         * — so it needs the answer the old `startUpdate` gave, which was "the
         * plan has run until something is genuinely in flight".
         *
         * `whenSettled` is EXACTLY that and no more: every runner here hands its
         * work out and answers `running`, so the queue empties as soon as the plan
         * blocks. It is not a poll, it has no sleep, and it goes away with this
         * endpoint when the panel lands.
         */
        await engine.whenSettled(started.operationId)
        const operation =
          (await engine.active(LIFECYCLE_EXCLUSION_GROUP))?.operation ??
          (await engine.history(UPDATE_OPERATION_KIND, 1))[0]?.operation ??
          started.operation
        throwIfFailedOnStart(operation)
        return legacyConvergeResult(
          state.modules.updates,
          operation,
          serverBuildVersion(),
          serverPlacementOf(ctx),
        )
      },
    }) as unknown as WriteRoute<void, Awaited<ReturnType<typeof legacyConvergeResult>>>,
  }
}
