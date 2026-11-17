/**
 * THE CROSS-WORKSPACE ALLOWLIST [POD-6959 design 2.4 and 2.5].
 *
 * Every statement that may touch more than one workspace, or a workspace's rows from outside
 * the workspace, with where it is, why it must, the index that serves it and the issue that
 * owns it. Nothing else may:
 *
 *   - a `preparedAcross` definition is made with one of these entries (`preparedAcross(ENTRY,
 *     build)`), must be a SELECT, and runs on the fleet handle only. Fleet jobs use it to find
 *     the workspaces with due work (POD-6962), then do the work through each workspace's own
 *     repositories. Nothing writes across workspaces;
 *   - the one global write to a workspace table, the provisioning insert of a workspace's
 *     `sync_feed` row (contract C3, C4). It runs in the global context because the row it
 *     inserts is the row a workspace's write transaction locks, so no workspace lock can cover
 *     it yet.
 *
 * The workspace-scope audit (`workspace-scope-audit.test.ts`) holds every cross-workspace and
 * global definition to this list, and the source guard (`workspace-scope-guard.test.ts`) refuses
 * a `preparedAcross` call whose entry does not come from this file. Migrations are raw SQL
 * outside the registry and stay off it.
 */

import type { CrossWorkspaceEntry } from '@podium/sync/adapters/sqlite/prepared'

export interface CrossWorkspaceAllowlistEntry extends CrossWorkspaceEntry {
  /**
   * `read`: a `preparedAcross` fleet read (a SELECT). `provisioning`: the global write that
   * creates a workspace's `sync_feed` row.
   */
  readonly use: 'read' | 'provisioning'
  /**
   * The task that adds the definition, while it does not exist yet. The audit fails once the
   * definition exists and this is still set, so the task that lands it removes the field.
   */
  readonly plannedBy?: string
}

/**
 * The provisioning insert: `INSERT INTO sync_feed … ON CONFLICT (workspace_id) DO NOTHING`, made
 * once per workspace by `StoreDatabase.provisionWorkspace(id)` in the global context.
 */
export const PROVISION_WORKSPACE_FEED: CrossWorkspaceAllowlistEntry = Object.freeze({
  use: 'provisioning',
  file: 'apps/server/src/store/database.ts',
  name: 'provisionWorkspaceFeed',
  reason:
    "Creates a workspace's sync_feed row, the row its write transactions lock (contract C4). " +
    'It runs in the global context because the row it inserts does not exist yet, so no ' +
    'workspace lock can cover it; ON CONFLICT DO NOTHING makes a repeat harmless.',
  index: 'sync_feed primary key (workspace_id)',
  issue: 'POD-7010',
  plannedBy: 'POD-7010',
})

/** Every entry, in the order they were added. */
export const CROSS_WORKSPACE_ALLOWLIST: readonly CrossWorkspaceAllowlistEntry[] = Object.freeze([
  PROVISION_WORKSPACE_FEED,
])

/** The entry for a definition keyed `file:name`, if it has one. */
export function allowlistEntryFor(key: string): CrossWorkspaceAllowlistEntry | undefined {
  return CROSS_WORKSPACE_ALLOWLIST.find((entry) => `${entry.file}:${entry.name}` === key)
}
