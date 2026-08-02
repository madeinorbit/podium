/**
 * Layout tRPC surface (POD-1350) — `layout.get` · `layout.set` · `layout.clear`.
 *
 * Writes run the contract-derived LIVE gate ({@link layoutAuthzFailure}) before
 * any store touch, then the handler. See POD-402 review gap 1.
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
import { layoutActor, layoutAuthzDeps, layoutAuthzFailure } from './authz'
import { LayoutService } from './service'

function nowIso(): string {
  return new Date().toISOString()
}

function layoutService(ctx: Context): LayoutService {
  return new LayoutService({
    layout: ctx.registry.sessionStore.layout,
    // Ledger is on the registry composition; capture publishes userLayout rows.
    ledger: ctx.registry.changeLedger,
  })
}

function authorizeWrite(ctx: Context, name: string): { actor: NonNullable<ReturnType<typeof layoutActor>> } {
  const deps = layoutAuthzDeps(ctx)
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
    get: t.procedure.query(({ ctx }) => {
      // Same member floor as writes — no admin may read another person's layout.
      // Reuses layout.set's floor declaration so there is one policy object.
      const { actor } = authorizeWrite(ctx, layoutSetContract.name)
      return layoutService(ctx).getSnapshot(actor)
    }),

    set: t.procedure.input(layoutSetInput).mutation(({ ctx, input }) => {
      const { actor } = authorizeWrite(ctx, layoutSetContract.name)
      const parsed = layoutSetContract.input.parse(input)
      return layoutService(ctx).set(actor, parsed.values, nowIso())
    }),

    clear: t.procedure.input(layoutClearInput).mutation(({ ctx, input }) => {
      const { actor } = authorizeWrite(ctx, layoutClearContract.name)
      const parsed = layoutClearContract.input.parse(input)
      return layoutService(ctx).clear(actor, parsed.keys)
    }),
  }
}
