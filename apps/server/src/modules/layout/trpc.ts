/**
 * Layout tRPC surface (POD-1350) — `layout.get` · `layout.set` · `layout.clear`.
 *
 * Writes are gated by the L1 contracts in `@podium/commands` (closed key
 * vocabulary, per-user-state class, offline-eligible + outbox). The get is a
 * READ and has no write-class visibility; it is still principal-scoped.
 *
 * Bootstrap representation for POD-403: `get` returns the full
 * {@link LayoutSnapshot} for the calling user. Command responses return the
 * same shape after a write so ui-state has one seam to hydrate from.
 */

import {
  layoutClearContract,
  layoutClearInput,
  layoutSetContract,
  layoutSetInput,
} from '@podium/commands'
import type { UserId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { onBehalfOfUser } from '../../command-principal'
import type { Context } from '../../trpc'
import { t } from '../../trpc'
import { LayoutService } from './service'

function requireActor(ctx: Context, name: string): UserId {
  const actor = onBehalfOfUser(ctx.principal)
  if (actor === null) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `${name} writes on behalf of a user, and this principal has none`,
    })
  }
  return actor
}

function layoutService(ctx: Context): LayoutService {
  return new LayoutService(ctx.registry.sessionStore.layout)
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Layout procedures for the root router under the `layout` namespace. */
export function layoutFamilyProcedures() {
  return {
    /** Bootstrap snapshot for the calling principal. */
    get: t.procedure.query(({ ctx }) => {
      const actor = requireActor(ctx, 'layout.get')
      return layoutService(ctx).getSnapshot(actor)
    }),

    set: t.procedure.input(layoutSetInput).mutation(({ ctx, input }) => {
      // Contract is the schema source of truth; re-parse so a bypassed client
      // cannot skip the closed vocabulary (defense in depth).
      const parsed = layoutSetContract.input.parse(input)
      const actor = requireActor(ctx, layoutSetContract.name)
      return layoutService(ctx).set(actor, parsed.values, nowIso())
    }),

    clear: t.procedure.input(layoutClearInput).mutation(({ ctx, input }) => {
      const parsed = layoutClearContract.input.parse(input)
      const actor = requireActor(ctx, layoutClearContract.name)
      return layoutService(ctx).clear(actor, parsed.keys)
    }),
  }
}
