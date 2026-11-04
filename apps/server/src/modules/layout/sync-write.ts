/**
 * LAYOUT ON THE SYNC WRITE ENTRY POINT (POD-6350, ADR 12 D2).
 *
 * `layout.set` and `layout.clear` are registered here: a target resolver that is
 * the family's live gate, and a handler that is the service call. The entry
 * point supplies what the old routes lacked:
 *
 *  - ONE UNIT OF WORK. The handler's row write and its change-log append run
 *    inside the entry point's unit, so they commit or roll back together. Before
 *    this, `setMany` committed and the `capture` that published it ran in a
 *    second transaction; a failed append left a row no other device would hear
 *    of until the next boot reconcile.
 *  - DEDUP. A retried write under one mutationId runs once and answers the
 *    recorded snapshot.
 *
 * THE GATE IS THE CONTRACT'S LIVE ROLE FLOOR (`authz.ts`), read in the resolver
 * so it runs before dedup: a replay from a principal demoted since is refused.
 * The answer is `NO_TARGET` because the row IS the principal (the contract's
 * resource is `none`): no shared entity to check, and the write lands on the
 * caller's own human.
 */

import { layoutClearContract, layoutSetContract } from '@podium/commands'
import type { UserId, UserRole } from '@podium/model'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import { NO_TARGET, type SyncWriteRegistry, type SyncWriteTarget } from '../sync-write/registry'
import { layoutAuthzFailure } from './authz'
import type { LayoutService } from './service'

export interface LayoutSyncWriteDeps {
  readonly layout: Pick<LayoutService, 'set' | 'clear'>
  /** The account's role NOW, never a snapshot (ADR 3 D16). */
  roleOf(user: UserId): Promise<UserRole | undefined>
  readonly now?: () => string
}

/** The human the write belongs to, or `undefined` to refuse. */
async function gate(
  deps: LayoutSyncWriteDeps,
  name: string,
  principal: CommandPrincipal,
): Promise<UserId | undefined> {
  const actor = onBehalfOfUser(principal)
  if (actor === null) return undefined
  const role = await deps.roleOf(actor)
  return layoutAuthzFailure(name, { principal, role }) === undefined ? actor : undefined
}

/** The resolver: the live gate, then "no shared target". */
const targetFor =
  (deps: LayoutSyncWriteDeps, name: string) =>
  async (_input: unknown, ctx: { principal: CommandPrincipal }): Promise<SyncWriteTarget> =>
    (await gate(deps, name, ctx.principal)) === undefined ? undefined : NO_TARGET

/** The handler's actor: the resolver has already refused a principal without one. */
function actorOf(principal: CommandPrincipal): UserId {
  const actor = onBehalfOfUser(principal)
  if (actor === null) throw new Error('layout write reached its handler without a human')
  return actor
}

export function registerLayoutCommands(
  registry: SyncWriteRegistry,
  deps: LayoutSyncWriteDeps,
): void {
  const now = deps.now ?? (() => new Date().toISOString())
  registry.register({
    contract: layoutSetContract,
    target: targetFor(deps, layoutSetContract.name),
    handle: async (ctx, input) =>
      await deps.layout.set(actorOf(ctx.principal), input.values, now()),
  })
  registry.register({
    contract: layoutClearContract,
    target: targetFor(deps, layoutClearContract.name),
    handle: async (ctx, input) => await deps.layout.clear(actorOf(ctx.principal), input.keys),
  })
}
