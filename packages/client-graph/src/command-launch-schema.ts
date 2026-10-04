import type { Store } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import type { SliceIssue } from './shared/slice-types'
import type { WorktreeView } from '@podium/client-core/values'

/** Read-side declarations; the existing runtime still owns every write. */
export interface CommandLaunchRows {
  commandWindow: Pick<Store, 'paletteOpen' | 'pins' | 'selectedIssueId' | 'openIssueId' | 'selectedWorktree' | 'paneA' | 'recentFiles' | 'sidebarSettings'>
  commandCatalog: { repositories: readonly string[]; repos: readonly string[]; worktrees: readonly string[]; machines: readonly string[]; issues: readonly string[]; sessions: readonly string[] }
  commandRepository: Store['repos'][number] & { groupId: string; linked: boolean }
  commandRepo: { id: string }
  commandWorktree: WorktreeView & { repositoryId: string; groupId: string }
  commandMachine: Store['machines'][number]
  commandIssue: SliceIssue
}
export type CommandEntity = keyof CommandLaunchRows

declare module './source-registry' {
  interface PoolSourceRows extends CommandLaunchRows {}
}

export const COMMAND_LAUNCH_SCHEMA = {
  commandWindow: { key: 'window', source: 'engine:locals', cold: 'never', fields: ['paletteOpen', 'pins', 'selectedIssueId', 'openIssueId', 'selectedWorktree', 'paneA', 'recentFiles', 'sidebarSettings'] },
  commandCatalog: { key: 'catalog', source: 'pool:keys', cold: 'never' },
  commandRepository: { key: 'machineId,path', source: 'engine:repos', cold: 'never' },
  commandRepo: { key: 'repoId ?? origin ?? machineId,path', source: 'engine:repos', cold: 'never' },
  commandWorktree: { key: 'repositoryId,path', source: 'engine:repos.worktrees', cold: 'never' },
  commandMachine: { key: 'id', source: 'engine:machines', cold: 'never' },
  commandIssue: { key: 'id', source: 'pool:issue', cold: 'summary' },
} as const satisfies Record<CommandEntity, object>
export const COMMAND_ENTITIES = Object.keys(COMMAND_LAUNCH_SCHEMA) as CommandEntity[]

/** The generic source maintains only these declared edges, over resident rows.
 * Cold members contribute through summaries, never an additional index. */
export const COMMAND_RELATIONS = [
  { from: 'commandRepository', to: 'commandRepo', name: 'repositories', key: 'groupId' },
  { from: 'commandRepository', to: 'commandMachine', name: 'repositories', key: 'machineId' },
  { from: 'commandWorktree', to: 'commandRepository', name: 'worktrees', key: 'repositoryId' },
  { from: 'commandWorktree', to: 'commandRepo', name: 'worktrees', key: 'groupId' },
  { from: 'session', to: 'commandIssue', name: 'sessions', key: 'issueId', excludeShell: true },
  { from: 'session', to: 'commandMachine', name: 'sessions', key: 'machineId' },
  { from: 'session', to: 'commandWorktree', name: 'sessions', key: 'cwd', match: 'exact-worktree' },
  { from: 'session', to: 'commandRepository', name: 'sessions', key: 'cwd', match: 'repository-containment' },
  { from: 'commandWindow', to: 'issue', name: 'selectedIssue', key: 'selectedIssueId' },
  { from: 'commandWindow', to: 'issue', name: 'openIssue', key: 'openIssueId' },
  { from: 'commandWindow', to: 'session', name: 'focusedSession', key: 'paneA' },
] as const

/** Declared before pool construction. Small browsing/placement projections;
 * contextual commands request the full selected row through the batched loader. */
export const COMMAND_SUMMARIES = {
  issue: ['id', 'seq', 'title', 'stage', 'displayRef', 'linearIdentifier', 'color', 'parentId', 'archived', 'deletedAt', 'isDraftVessel', 'updatedAt', 'worktreePath', 'repoId', 'repoPath'],
  session: ['sessionId', 'cwd', 'machineId', 'issueId', 'agentKind', 'headless', 'lastActiveAt', 'archived', 'status', 'name', 'title', 'displayRef', 'createdAt', 'readAt', 'unread', 'snoozedUntil', 'resumable', 'harnessHandoff', 'resume'],
} as const
export type CommandSessionSummary = Pick<SessionView, typeof COMMAND_SUMMARIES.session[number]>
