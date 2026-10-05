import { NAVIGATION_LOADING, type NavigationProvider } from '@podium/client-core/navigation-provider'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId } from '@podium/model/browser'
import { allowImperativeRead } from '@podium/mobx-helpers'
import { parseSessionRef } from '@podium/protocol'
import { compareStructural, transaction } from 'mobx'
import { missions } from './mission'
import { navigationActivity } from './navigation-activity'
import type { MobxPool } from './pool'
import { createPoolProjection } from './runtime-pool'
import type { SliceIssue } from './shared/slice-types'
import { LOADING } from './worklist/rollup'

/** An addressed read port over the existing principal's pool. Row reads use
 * its single loading reader; mission invalidation belongs to the pool cache. */
export function createPoolNavigationProvider(pool: MobxPool): NavigationProvider {
  const provider: NavigationProvider = {
    onTopology(changed) {
      return pool.queries.onTopology(changed)
    },
    issueSessions(id) {
      const rows: SessionView[] = []
      for (const key of pool.queries.ids({ kind: 'commandIssueSessions', issueId: id, archived: false })) {
        const row = pool.row('session', key)
        if (row === LOADING) return NAVIGATION_LOADING
        if (row) rows.push(row as SessionView)
      }
      return rows
    },
    issue(id) {
      let row = pool.row('issue', id, 'summary') as SliceIssue | typeof LOADING | undefined
      if (
        row &&
        row !== LOADING &&
        (!Object.hasOwn(row, 'id') || !Object.hasOwn(row, 'updatedAt'))
      ) {
        row = pool.row('issue', id) as SliceIssue | typeof LOADING | undefined
      }
      if (row === LOADING) return NAVIGATION_LOADING
      // Borrow the normalized row; do not retain a parallel issue index.
      return row as ReturnType<NavigationProvider['issue']>
    },
    missionRoot(id) {
      const root = missions(pool).rootFor(id)
      return root === LOADING
        ? NAVIGATION_LOADING
        : root === undefined
          ? undefined
          : asIssueId(root)
    },
    missionMembers(rootId) {
      const ids = missions(pool).members(rootId)
      return ids === LOADING ? NAVIGATION_LOADING : ids
    },
    session(id) {
      let row = pool.row('session', id)
      if (row === LOADING) return NAVIGATION_LOADING
      if (row !== undefined || !parseSessionRef(id.trim())) return row as SessionView | undefined
      const key = pool.queries.sessionReferenceId(id.trim())
      if (!key) return undefined
      row = pool.row('session', key)
      return row === LOADING ? NAVIGATION_LOADING : (row as SessionView | undefined)
    },
    sessionMembership(id) {
      const row = pool.row('session', id, 'summary-fields')
      return row === LOADING
        ? NAVIGATION_LOADING
        : (row as ReturnType<NonNullable<NavigationProvider['sessionMembership']>>)
    },
    registeredWorktree(path) {
      return (pool.row('worktree', path) as { path?: string } | undefined)?.path === path
    },
    worktreeForCwd(cwd) {
      // Probe directory ancestors, preserving plain and trailing-slash roots.
      // The source's session relation also accepts issue-only roots; navigation
      // deliberately follows only lanes registered by the machine scan.
      let path = cwd.length > 1 && cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
      if (provider.registeredWorktree!(cwd)) return cwd
      if (path !== cwd && provider.registeredWorktree!(path)) return path
      while (path.length > 1) {
        const slash = path.lastIndexOf('/')
        if (slash < 0) return null
        path = slash === 0 ? '/' : path.slice(0, slash)
        if (path !== '/' && provider.registeredWorktree!(`${path}/`)) return `${path}/`
        if (provider.registeredWorktree!(path)) return path
      }
      return null
    },
    firstWorktree: () => pool.queries.firstWorktreePath(),
    hasWorktreeSession: path => pool.queries.hasSessionWithin(path),
    worktreeSession(id) {
      const row = pool.row('session', id, 'summary-fields')
      return row === LOADING ? NAVIGATION_LOADING : row as ReturnType<NonNullable<NavigationProvider['worktreeSession']>>
    },
    topologySession: id => pool.queries.sessionTopology(id),
    activityAt(id) {
      const latest = navigationActivity(pool).activityAt(id)
      return latest === LOADING ? NAVIGATION_LOADING : latest
    },
    issueReadAt: (id) => pool.readCursor(id),
    // This port returns small scalar tuples, not memoized row identities.
    watch: (read, changed) => createPoolProjection(pool, read, { equals: compareStructural }).subscribe(changed),
  }
  // Runtime actions also use this port outside a reactive read. Permit those
  // addressed reads without detaching the same methods from watched projections.
  const read = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R =>
    allowImperativeRead(() => transaction(() => fn(...args)))
  return {
    ...provider,
    issue: read(provider.issue),
    issueSessions: read(provider.issueSessions!),
    missionRoot: read(provider.missionRoot),
    missionMembers: read(provider.missionMembers),
    session: read(provider.session),
    sessionMembership: read(provider.sessionMembership!),
    registeredWorktree: read(provider.registeredWorktree!),
    worktreeForCwd: read(provider.worktreeForCwd!),
    firstWorktree: read(provider.firstWorktree!),
    hasWorktreeSession: read(provider.hasWorktreeSession!),
    worktreeSession: read(provider.worktreeSession!),
    topologySession: read(provider.topologySession!),
    activityAt: read(provider.activityAt),
    issueReadAt: read(provider.issueReadAt),
  }
}
