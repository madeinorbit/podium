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
import { TRPCError } from '@trpc/server'
import type { Context } from '../../trpc'
import { t } from '../../trpc'
import { familyState } from '../derived-family'
import { layoutActor, layoutAuthzDeps, layoutAuthzFailure } from './authz'

function nowIso(): string {
  return new Date().toISOString()
}

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

    set: t.procedure.input(layoutSetInput).mutation(async ({ ctx, input }) => {
      const { actor } = await authorizeWrite(ctx, layoutSetContract.name)
      const parsed = layoutSetContract.input.parse(input)
      return await familyState(ctx).modules.layout.set(actor, parsed.values, nowIso())
    }),

    clear: t.procedure.input(layoutClearInput).mutation(async ({ ctx, input }) => {
      const { actor } = await authorizeWrite(ctx, layoutClearContract.name)
      const parsed = layoutClearContract.input.parse(input)
      return await familyState(ctx).modules.layout.clear(actor, parsed.keys)
    }),
  }
}
