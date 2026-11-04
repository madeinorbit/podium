/**
 * Layout tRPC surface (POD-1350) — `layout.get` · `layout.set` · `layout.clear`.
 *
 * Writes run the contract-derived LIVE gate ({@link layoutAuthzFailure}) before
 * any store touch, then the handler. See POD-402 review gap 1.
 *
 * State is reached ONLY through {@link familyState} → `modules.layout` (the
 * POD-314 seam). No `sessionStore` / `mods(ctx)` longhand in this file —
 * `router-triple-access` counts those as transport reach-throughs.
 */

import {
  layoutClearContract,
  layoutClearInput,
  layoutSetContract,
  layoutSetInput,
} from '@podium/commands'
import type { LayoutSnapshot } from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { Context } from '../../trpc'
import { t } from '../../trpc'
import { familyState } from '../derived-family'
import { routeThroughEntry } from '../sync-write/route-adapter'
import { layoutActor, layoutAuthzDeps, layoutAuthzFailure } from './authz'

async function authorizeWrite(
  ctx: Context,
  name: string,
): Promise<{ actor: NonNullable<ReturnType<typeof layoutActor>> }> {
  const deps = await layoutAuthzDeps(ctx)
  const refusal = layoutAuthzFailure(name, deps)
  if (refusal) throw refusal
  const actor = layoutActor(deps)
  if (actor === null) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `${name} writes on behalf of a user, and this principal has none`,
    })
  }
  return { actor }
}

/** Layout procedures for the root router under the `layout` namespace. */
export function layoutFamilyProcedures() {
  return {
    /** Bootstrap snapshot for the calling principal (tRPC read path). */
    get: t.procedure.query(async ({ ctx }) => {
      const { actor } = await authorizeWrite(ctx, layoutSetContract.name)
      return await familyState(ctx).modules.layout.getSnapshot(actor)
    }),

    // THIN ADAPTERS ONTO `sync.submit` (POD-6350) until POD-6359 removes them:
    // the gate runs first here only so a refused caller keeps the message it
    // always got; the entry point runs it again, live, in its fixed order, and
    // the write itself (one unit of work, deduplicated) is the entry point's.
    set: t.procedure.input(layoutSetInput).mutation(async ({ ctx, input }) => {
      await authorizeWrite(ctx, layoutSetContract.name)
      return (await routeThroughEntry(ctx, {
        command: layoutSetContract.name,
        input,
      })) as LayoutSnapshot
    }),

    clear: t.procedure.input(layoutClearInput).mutation(async ({ ctx, input }) => {
      await authorizeWrite(ctx, layoutClearContract.name)
      return (await routeThroughEntry(ctx, {
        command: layoutClearContract.name,
        input,
      })) as LayoutSnapshot
    }),
  }
}
