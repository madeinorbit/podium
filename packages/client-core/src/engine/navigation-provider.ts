import type { IssueId, IssueProjection } from '@podium/model'
import type { SessionView } from '../session-values'

/** A cold read is different from an id outside this principal's slice. The
 * provider queues its ordinary batched loader before returning this value. */
export const NAVIGATION_LOADING = Symbol('navigation loading')
export type NavigationRead<T> = T | undefined | typeof NAVIGATION_LOADING
export type NavigationWorktreeSession = Pick<SessionView, 'sessionId' | 'cwd' | 'name' | 'title'>
export interface NavigationTopologySession {
  id: string
  before?: { cwd: string; issueId?: string; order: string }
  after?: { cwd: string; issueId?: string; order: string }
}
export interface NavigationTopologyDelta {
  reset: boolean
  sessions: readonly NavigationTopologySession[]
}
export type NavigationIssue = Pick<
  IssueProjection,
  'id' | 'updatedAt' | 'archived' | 'deletedAt' | 'worktreePath'
>

/** Supplied by each client's pool composition root. The engine knows no graph,
 * replica, index, or second mutation owner. */
export interface NavigationProvider {
  issue(id: string): NavigationRead<NavigationIssue>
  missionRoot(id: string): NavigationRead<IssueId>
  missionMembers(rootId: string): ReadonlySet<string> | typeof NAVIGATION_LOADING
  session(id: string): NavigationRead<SessionView>
  /** Only the facts workspace pruning needs; cold identities stay summaries. */
  sessionMembership?(id: string): NavigationRead<Pick<SessionView, 'sessionId' | 'cwd' | 'issueId'>>
  /** The existing source identities and cold fields for worktree move notices. */
  worktreeSessions?(): NavigationRead<readonly NavigationWorktreeSession[]>
  /** Named registered paths and source-maintained scalar membership. */
  registeredWorktree?(path: string): NavigationRead<boolean>
  worktreeForCwd?(cwd: string): NavigationRead<string | null>
  firstWorktree?(): NavigationRead<string | null>
  hasWorktreeSession?(path: string): NavigationRead<boolean>
  worktreeSession?(id: string): NavigationRead<NavigationWorktreeSession>
  topologySession?(id: string): NavigationTopologySession['after']
  issueSessions?(id: string): NavigationRead<readonly SessionView[]>
  /** Pool topology changes, excluding ordinary activity/title updates. */
  onTopology?(changed: (delta?: NavigationTopologyDelta) => void): () => void
  activityAt(id: string): NavigationRead<string>
  issueReadAt(id: string): string | null | undefined
  /** Track just the addressed reads made by the current navigation. */
  watch?(read: () => readonly unknown[], changed: () => void): () => void
}

/** Installed synchronously while a client's pool import is in flight. */
export const loadingNavigationProvider: NavigationProvider = {
  worktreeSessions: () => NAVIGATION_LOADING,
  registeredWorktree: () => NAVIGATION_LOADING,
  worktreeForCwd: () => NAVIGATION_LOADING,
  firstWorktree: () => NAVIGATION_LOADING,
  hasWorktreeSession: () => NAVIGATION_LOADING,
  worktreeSession: () => NAVIGATION_LOADING,
  issue: () => NAVIGATION_LOADING,
  missionRoot: () => NAVIGATION_LOADING,
  missionMembers: () => NAVIGATION_LOADING,
  session: () => NAVIGATION_LOADING,
  activityAt: () => NAVIGATION_LOADING,
  issueReadAt: () => undefined,
}
