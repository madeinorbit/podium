/**
 * Feed-cursor tRPC surface (POD-1380) — `readPosition.get` · `readPosition.advance`.
 *
 * Writes run the contract-derived LIVE gate ({@link readPositionAuthzFailure})
 * before any store touch, then the handler — the same order `modules/layout`
 * uses, for the same POD-402 review gap.
 *
 * The read is gated identically to the write. A read position is per-user state,
 * so "who may see it" and "who may move it" are the same question, and the
 * snapshot returned is always the ACTOR's — there is no argument by which a
 * caller could ask for someone else's.
 *
 * State is reached ONLY through {@link familyState} → `modules.readPosition` (the
 * POD-314 seam); no `sessionStore` / `mods(ctx)` longhand here.
 */

import { readPositionAdvanceContract, readPositionAdvanceInput } from '@podium/commands'
import { TRPCError } from '@trpc/server'
import type { Context } from '../../trpc'
import { t } from '../../trpc'
import { familyState } from '../derived-family'
import { readPositionActor, readPositionAuthzDeps, readPositionAuthzFailure } from './authz'

function nowIso(): string {
  return new Date().toISOString()
}

function authorize(ctx: Context, name: string): { actor: NonNullable<ReturnType<typeof readPositionActor>> } {
  const deps = readPositionAuthzDeps(ctx)
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
    get: t.procedure.query(({ ctx }) => {
      const { actor } = authorize(ctx, readPositionAdvanceContract.name)
      return familyState(ctx).modules.readPosition.getSnapshot(actor)
    }),

    advance: t.procedure.input(readPositionAdvanceInput).mutation(({ ctx, input }) => {
      const { actor } = authorize(ctx, readPositionAdvanceContract.name)
      const parsed = readPositionAdvanceContract.input.parse(input)
      return familyState(ctx).modules.readPosition.advance(
        actor,
        parsed.streamId,
        { lastEventId: parsed.lastEventId, seenAt: parsed.seenAt ?? null },
        nowIso(),
      )
    }),
  }
}
