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
 *     it yet;
 *   - a raw SELECT of a process that reads the database without the store (the janitor), listed
 *     with its SQL text: the audit finds the text in the file and holds it to the cross-workspace
 *     rule (a read). Such a read only lists the workspaces with work; the work then reads each
 *     workspace's own rows.
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
   * creates a workspace's `sync_feed` row. `raw-read`: a raw SELECT outside the definition
   * registry, named by its {@link sql}.
   */
  readonly use: 'read' | 'provisioning' | 'raw-read'
  /** A `raw-read`'s statement, exactly as its file spells it. */
  readonly sql?: string
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
})

/**
 * The janitor's one fleet read: the workspaces with a feed, which is every provisioned workspace.
 * Each of its reads is then made for one listed workspace and reads only that workspace's rows
 * (POD-7021). A definition in the janitor's reads since POD-6993, so it runs on either engine.
 */
export const LIST_WORKSPACES_WITH_FEED: CrossWorkspaceAllowlistEntry = Object.freeze({
  use: 'read',
  file: 'apps/server/src/store/janitor-reads.ts',
  name: 'listWorkspacesWithFeed',
  reason:
    'The janitor finds the workspaces whose maintenance it observes: one row per provisioned ' +
    'workspace, ids only. Every observation it then makes reads one workspace, and nothing is ' +
    'written through this read.',
  index: 'sync_feed primary key (workspace_id)',
  issue: 'POD-7021',
})

/**
 * The wake-up poll (POD-7292, POD-6954 design 4.2): the feed heads of the workspaces this
 * process has subscribers for, in one statement per poll tick. A process serves many
 * workspaces; one read per workspace per tick would make the safety net's cost grow with
 * them. It reads ids and heads only, and whatever a woken subscriber then reads, it reads
 * from its own workspace.
 */
export const WAKE_UP_FEED_HEADS: CrossWorkspaceAllowlistEntry = Object.freeze({
  use: 'read',
  file: 'apps/server/src/store/wake-up-reads.ts',
  name: 'readFeedHeads',
  reason:
    'The workspace wake-up poll reads the feed heads of the workspaces a process has ' +
    'subscribers for, in ONE batched statement per tick instead of one per workspace, so a ' +
    'lost wake-up signal is healed without the poll growing with the workspaces served. Ids ' +
    'and heads only; nothing is written through this read.',
  index: 'sync_feed primary key (workspace_id)',
  issue: 'POD-7292',
})

/** Every entry, in the order they were added. */
export const CROSS_WORKSPACE_ALLOWLIST: readonly CrossWorkspaceAllowlistEntry[] = Object.freeze([
  PROVISION_WORKSPACE_FEED,
  LIST_WORKSPACES_WITH_FEED,
  WAKE_UP_FEED_HEADS,
])

/** The entry for a definition keyed `file:name`, if it has one. */
export function allowlistEntryFor(key: string): CrossWorkspaceAllowlistEntry | undefined {
  return CROSS_WORKSPACE_ALLOWLIST.find((entry) => `${entry.file}:${entry.name}` === key)
}
