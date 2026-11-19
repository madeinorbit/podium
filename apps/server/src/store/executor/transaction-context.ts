import type { WorkspaceId } from '@podium/model'

/**
 * WHAT A TRANSACTION IS FOR [POD-6959 design 2.4, contract C3]: one workspace,
 * or the install as a whole.
 *
 * Every transaction frame records one. A repository's transaction runner opens
 * with its handle's context; a caller that names none opens a global
 * transaction at the root and joins whatever is open when nested. The join rules
 * are {@link assertJoinable}'s. A driver reads the context at `begin` through
 * `currentStoreContext()` (POD-6958's Postgres driver takes the workspace's write
 * lock from it), and the per-workspace write slot reads it at admission.
 *
 * A global context may write only `meta`, `server_secrets`, `maintenance_leases`
 * and the provisioning insert of a workspace's `sync_feed` row (C3).
 */
export type StoreContext =
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }
  | { readonly kind: 'global' }

/** The context of work that belongs to no workspace. */
export const GLOBAL_CONTEXT: StoreContext = Object.freeze({ kind: 'global' })

/** The context of `workspaceId`'s work. */
export function workspaceContext(
  workspaceId: WorkspaceId,
): Extract<StoreContext, { kind: 'workspace' }> {
  return Object.freeze({ kind: 'workspace', workspaceId })
}
