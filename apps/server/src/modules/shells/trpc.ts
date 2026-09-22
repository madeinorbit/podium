/**
 * Dock-shell tRPC surface (POD-4436) — `shells.forWorktree`.
 *
 * Returns-or-creates the calling principal's dock shell for one worktree, so
 * the same dock shell opens on every device. Creation stays a normal shell
 * spawn (agentKind 'shell'); only the worktree→shell mapping is new.
 *
 * Tab shells (New Shell from the + menu) are unmapped by design (SP-75b1):
 * they go through `sessions.create` directly and never touch this router.
 *
 * State is reached ONLY through {@link familyState} → `modules.dockShells`
 * (the POD-314 seam). No `sessionStore` / `mods(ctx)` longhand in this file.
 */

import { MachineIdField, SessionIdField } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { Context } from '../../trpc'
import { t } from '../../trpc'
import { familyState } from '../derived-family'
import { layoutActor, layoutAuthzDeps } from '../layout/authz'
import { visibleMachinesFor } from '../sessions/command-ctx'

const forWorktreeInput = z.object({
  /** The worktree path the dock is open on (raw cwd spelling; normalized server-side). */
  worktreePath: z.string().min(1).max(1024),
  /** Spawn target when the worktree lives on a non-default machine. */
  machineId: MachineIdField.optional(),
})

const forWorktreeOutput = z.object({
  sessionId: SessionIdField,
  created: z.boolean(),
})

/** Shell procedures for the root router under the `shells` namespace. */
export function shellFamilyProcedures() {
  return {
    /**
     * Return-or-create the caller's dock shell for a worktree. The second
     * device opening the same worktree attaches to the same session id; two
     * overlapping opens create exactly one shell (claim-before-create in the
     * service, arbitrated by the `(user_id, worktree_key)` primary key).
     */
    forWorktree: t.procedure
      .input(forWorktreeInput)
      .output(forWorktreeOutput)
      .mutation(async ({ ctx, input }) => {
        const deps = await layoutAuthzDeps(ctx)
        if (deps.role !== 'member' && deps.role !== 'admin') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'shells.forWorktree requires a member account',
          })
        }
        const actor = layoutActor(deps)
        if (actor === null) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'shells.forWorktree writes on behalf of a user, and this principal has none',
          })
        }
        if (input.machineId !== undefined) {
          const machines = await visibleMachinesFor(familyState(ctx).modules, ctx.capability)
          const target = machines.find((m) => m.id === input.machineId)
          if (!target) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown machine' })
          }
          if ((target as { use?: string }).use === 'denied') {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'machine use denied' })
          }
        }
        const service = familyState(ctx).modules.dockShells
        const result = await service.forWorktree(actor, input.worktreePath, {
          ...(input.machineId ? { machineId: input.machineId } : {}),
        })
        return { sessionId: result.sessionId, created: result.created }
      }),
  }
}
