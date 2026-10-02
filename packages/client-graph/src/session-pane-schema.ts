import type { Store } from '@podium/client-core/engine'

/** Window controls belong to the existing engine. Session/process facts use
 * the core session reader and its normalized companions; machines use the
 * declared header source. Conversation rows are outside this schema. */
export interface SessionPaneRows {
  sessionPaneWindow: Pick<Store, 'panelMode' | 'dockShells' | 'reposLoaded' | 'pendingSpawnIds'>
}
declare module './source-registry' { interface PoolSourceRows extends SessionPaneRows {} }
export const SESSION_PANE_ENTITIES = ['sessionPaneWindow'] as const
export const SESSION_PANE_SCHEMA = {
  sessionPaneWindow: { key: 'window', source: 'engine:locals', fields: ['panelMode', 'dockShells', 'reposLoaded', 'pendingSpawnIds'], cold: 'never' },
  session: { source: 'pool:session', reader: 'load', fields: [
    'sessionId', 'status', 'agentState', 'offer', 'issueId', 'cwd', 'machineId', 'machineName',
    'condition', 'handoffTarget', 'name', 'title', 'displayRef', 'agentKind', 'headless',
    'driverFamily', 'transcriptAvailable', 'terminalCapable', 'resumable', 'neverBound',
    'exitCode', 'spawnFailure', 'observedModel', 'observedEffort', 'requestedModel',
    'requestedEffort', 'model', 'effort', 'configureFields', 'snoozedUntil', 'resume',
    'createdAt', 'geometry', 'draftSyncEngine', 'controllerId',
  ] },
  machine: { source: 'header:machine', relation: 'session.machine' },
  issue: { source: 'pool:issue', relations: ['parent', 'worktree'], summary: ['id', 'seq', 'archived', 'deletedAt', 'parentId', 'color', 'worktreePath'] },
} as const
export const SESSION_PANE_SUMMARIES = { issue: SESSION_PANE_SCHEMA.issue.summary }
