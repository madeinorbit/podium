import type { IssueId, IssueProjection } from '@podium/model'
import type { SessionView } from '../session-values'

/** A cold read is different from an id outside this principal's slice. The
 * provider queues its ordinary batched loader before returning this value. */
export const NAVIGATION_LOADING = Symbol('navigation loading')
export type NavigationRead<T> = T | undefined | typeof NAVIGATION_LOADING
export type NavigationWorktreeSession = Pick<SessionView, 'sessionId' | 'cwd' | 'name' | 'title'>
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
  issueSessions?(id: string): NavigationRead<readonly SessionView[]>
  /** Pool topology changes, excluding ordinary activity/title updates. */
  onTopology?(changed: () => void): () => void
  activityAt(id: string): NavigationRead<string>
  issueReadAt(id: string): string | null | undefined
  /** Track just the addressed reads made by the current navigation. */
  watch?(read: () => readonly unknown[], changed: () => void): () => void
}

/** Installed synchronously while a client's pool import is in flight. */
export const loadingNavigationProvider: NavigationProvider = {
  worktreeSessions: () => NAVIGATION_LOADING,
  issue: () => NAVIGATION_LOADING,
  missionRoot: () => NAVIGATION_LOADING,
  missionMembers: () => NAVIGATION_LOADING,
  session: () => NAVIGATION_LOADING,
  activityAt: () => NAVIGATION_LOADING,
  issueReadAt: () => undefined,
}

/** Opt-in store-level counts at the actual legacy reads, including reads made
 * by reactions and spread selection states. No ids or rows are retained. */
const emptyCounts = () => ({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
let enabled = false
let counts = emptyCounts()
export const navigationStats = {
  enable() {
    enabled = true
  },
  disable() {
    enabled = false
  },
  reset() {
    counts = emptyCounts()
  },
  read() {
    return { ...counts }
  },
}
export function countLegacyNavigation(key: keyof typeof counts): void {
  if (enabled) counts[key]++
}
