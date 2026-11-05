/**
 * Feed-cursor tRPC surface (POD-1380) — `readPosition.get` · `readPosition.advance`.
 *
 * The read runs the contract-derived LIVE gate ({@link readPositionAuthzFailure})
 * before any store touch. The write, `advance`, is on the sync write entry point
 * (`sync-write.ts`, POD-6412), which applies the same gate as its target check;
 * the route below is only a thin adapter onto it.
 *
 * The read is gated identically to the write. A read position is per-user state,
 * so "who may see it" and "who may move it" are the same question, and the
 * snapshot returned is always the ACTOR's — there is no argument by which a
 * caller could ask for someone else's.
 *
 * State is reached ONLY through {@link familyState} → `modules.readPosition` (the
 * POD-314 seam); no `sessionStore` / `mods(ctx)` longhand here.
 */

import { readPositionAdvanceContract } from '@podium/commands'
import { TRPCError } from '@trpc/server'
import type { Context } from '../../trpc'
import { t } from '../../trpc'
import { familyState } from '../derived-family'
import { legacyRouteAdapters } from '../sync-write/family'
import { readPositionActor, readPositionAuthzDeps, readPositionAuthzFailure } from './authz'
import { READ_POSITION_SYNC_FAMILY } from './sync-write'

async function authorize(
  ctx: Context,
  name: string,
): Promise<{ actor: NonNullable<ReturnType<typeof readPositionActor>> }> {
  const deps = await readPositionAuthzDeps(ctx)
  const refusal = readPositionAuthzFailure(name, deps)
  if (refusal) throw refusal
  const actor = readPositionActor(deps)
  if (actor === null) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `${name} writes on behalf of a user, and this principal has none`,
    })
  }
  return { actor }
}

/** Feed-cursor procedures for the root router under the `readPosition` namespace. */
export function readPositionFamilyProcedures() {
  return {
    /** Bootstrap snapshot for the calling principal (tRPC read path). */
    get: t.procedure.query(async ({ ctx }) => {
      const { actor } = await authorize(ctx, readPositionAdvanceContract.name)
      return await familyState(ctx).modules.readPosition.getSnapshot(actor)
    }),

    // LEGACY(remove-after: 2027-03): the shipped mobile app advances through this
    // route. Removing it leaves that app's read positions unsaved on this server.
    ...legacyRouteAdapters(READ_POSITION_SYNC_FAMILY, ['advance']),
  }
}
