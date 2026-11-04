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

import { layoutClearContract, layoutSetContract, USER_LAYOUT_RECORD } from '@podium/commands'
import { parseLayoutRowId, type UserId, type UserRole } from '@podium/model'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import { registerRecordKind } from '../records/generic'
import { SyncWriteRefused } from '../sync-write/entry'
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
  registerLayoutRecord(registry, deps, now)
}

/**
 * ONE LAYOUT KEY AS A GENERIC RECORD (ADR 12 D3, POD-6404): `records.userLayout`
 * edits set one key's value and removes forget it, through the same service and
 * the same live role gate as `layout.set` / `layout.clear`. The row id names
 * its user; anyone else's row is refused. A cleared `value` forgets the key too.
 */
function registerLayoutRecord(
  registry: SyncWriteRegistry,
  deps: LayoutSyncWriteDeps,
  now: () => string,
): void {
  /** The key, when the row is the caller's own; else undefined. */
  const ownKey = (id: string, actor: UserId | undefined): string | undefined => {
    if (actor === undefined) return undefined
    try {
      const row = parseLayoutRowId(id)
      return row.userId === actor ? row.key : undefined
    } catch {
      return undefined
    }
  }
  const keyFor = (id: string, principal: CommandPrincipal): string => {
    const key = ownKey(id, onBehalfOfUser(principal) ?? undefined)
    if (key === undefined) throw new SyncWriteRefused({ kind: 'target-not-found' })
    return key
  }
  registerRecordKind(registry, USER_LAYOUT_RECORD, {
    target: async (op, id, { principal }) => {
      // The family's own live role floor: an edit is a set, a remove a clear.
      const family = op === 'remove' ? layoutClearContract : layoutSetContract
      const actor = await gate(deps, family.name, principal)
      return ownKey(id, actor) === undefined ? undefined : NO_TARGET
    },
    edit: async (ctx, id, patch, _expected, unset) => {
      const key = keyFor(id, ctx.principal)
      const actor = actorOf(ctx.principal)
      if (unset.includes('value')) return await deps.layout.clear(actor, [key])
      return await deps.layout.set(actor, { [key]: patch.value }, now())
    },
    remove: async (ctx, id) =>
      await deps.layout.clear(actorOf(ctx.principal), [keyFor(id, ctx.principal)]),
  })
}
