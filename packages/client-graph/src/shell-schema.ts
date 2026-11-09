import type { IssueViewModel } from '@podium/client-core/replica'
import type { ScreenState } from '@podium/client-core/ui'

/** Window controls are borrowed from the existing mutation owner. The shared
 * header owns machine/repository/order rows; this extension supplies missing
 * controls and authoritative shipping lanes, never another runtime or outbox. */
export interface ShellRows {
  shellWindow: Pick<
    ScreenState,
    | 'view'
    | 'paneA'
    | 'selectedIssueId'
    | 'selectedWorktree'
    | 'superOpen'
    | 'paletteOpen'
    | 'autoContinuePromptSessionId'
  >
  shellCatalog: {
    files: readonly string[]
    workspaces: readonly string[]
    lanes: readonly string[]
  }
  shellFile: ScreenState['fileTabs'][number]
  shellWorkspace: ScreenState['workspaces'][string]
  shellShipLane: import('@podium/model').ShipLaneProjection
}
declare module './source-registry' {
  interface PoolSourceRows extends ShellRows {}
}
export type ShellEntity = keyof ShellRows
export const SHELL_SOURCE_KEY = 'shell-controls'
export const SHELL_SCHEMA = {
  shellWindow: {
    key: 'window',
    source: 'ui:screen',
    fields: [
      'view',
      'paneA',
      'selectedIssueId',
      'selectedWorktree',
      'superOpen',
      'paletteOpen',
      'autoContinuePromptSessionId',
    ],
    cold: 'never',
  },
  shellCatalog: { key: 'catalog', source: 'resident:membership', order: 'owner order' },
  shellFile: { key: 'id', source: 'engine:fileTabs', cold: 'never' },
  shellWorkspace: { key: 'workspaceKey', source: 'engine:workspaces', cold: 'never' },
  shellShipLane: { key: 'id', source: 'replica:shipLanes', cold: 'never' },
} as const satisfies Record<ShellEntity, object>
export const SHELL_ENTITIES = Object.keys(SHELL_SCHEMA) as ShellEntity[]
/** Only resident rows enter these buckets. Cold core facts are read through
 * declared summaries; artifact manifests demand the full row in one batch. */
export const SHELL_RELATIONS = [
  { from: 'shellFile', to: 'issue', name: 'files', key: 'issueId' },
  { from: 'shellShipLane', to: 'repo', name: 'shipLanes', key: 'repoId' },
] as const
export const SHELL_SUMMARIES = {
  issue: [
    'id',
    'seq',
    'title',
    'repoId',
    'repoPath',
    'repoName',
    'worktreePath',
    'parentId',
    'archived',
    'deletedAt',
    'stage',
    'closedReason',
    'audience',
    'sortKey',
    'branch',
    'gitState',
    'blocked',
    'supersededBy',
    'duplicateOf',
  ],
  session: [
    'sessionId',
    'displayRef',
    'cwd',
    'machineId',
    'issueId',
    'name',
    'title',
    'archived',
    'lastActiveAt',
    'resume',
    'status',
    'agentKind',
    'headless',
  ],
} as const
export type ShellIssue = Pick<
  IssueViewModel,
  (typeof SHELL_SUMMARIES.issue)[number] | 'prefix' | 'displayRef'
>
