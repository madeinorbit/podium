import { NAVIGATION_LOADING, type NavigationProvider } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId } from '@podium/model/browser'
import { parseSessionRef } from '@podium/protocol'
import { _isComputingDerivation, compareStructural, runInAction } from 'mobx'
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
      // The source owns these facts once. Following its revision needs no
      // history scan, row facets or second per-session metadata map.
      let index = pool.coldIndex(), version = index.sessionTopologyVersion
      return pool.queries.onChange(event => {
        const next = pool.coldIndex(), revision = next.sessionTopologyVersion
        const moved = event.type === 'replace' || next !== index || revision !== version
        index = next
        version = revision
        if (moved) changed()
      })
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
      // Permanent birth refs are also local navigation targets. The declared
      // reference question names the candidates; it never enumerates history.
      // Cold candidates answer through the declared scalar summary.
      const ref = id.trim()
      let pending = false
      for (const key of pool.queries.indexed({ kind: 'sessionReference', ref }).sort()) {
        const summary = pool.row('session', key, 'summary')
        if (summary === LOADING) {
          pending = true
          continue
        }
        if ((summary as { displayRef?: string } | undefined)?.displayRef !== ref) continue
        row = pool.row('session', key)
        return row === LOADING ? NAVIGATION_LOADING : (row as SessionView | undefined)
      }
      return pending ? NAVIGATION_LOADING : undefined
    },
    sessionMembership(id) {
      const row = pool.row('session', id, 'summary-fields')
      return row === LOADING
        ? NAVIGATION_LOADING
        : (row as ReturnType<NonNullable<NavigationProvider['sessionMembership']>>)
    },
    worktreeSessions() {
      const rows = []
      const ids = pool.queries
        .ids({ kind: 'shellSessions' })
        .filter((id) => !pool.queries.collapsed(id))
        .sort((a, b) => {
          const left = pool.queries.orderKey(a),
            right = pool.queries.orderKey(b)
          return left < right ? -1 : left > right ? 1 : a.localeCompare(b)
        })
      for (const id of ids) {
        const row = pool.row('session', id, 'summary-fields')
        if (row === LOADING) return NAVIGATION_LOADING
        if (row) rows.push(row)
      }
      return rows as ReturnType<NonNullable<NavigationProvider['worktreeSessions']>>
    },
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
    _isComputingDerivation() ? fn(...args) : runInAction(() => fn(...args))
  return {
    ...provider,
    issue: read(provider.issue),
    issueSessions: read(provider.issueSessions!),
    missionRoot: read(provider.missionRoot),
    missionMembers: read(provider.missionMembers),
    session: read(provider.session),
    sessionMembership: read(provider.sessionMembership!),
    worktreeSessions: read(provider.worktreeSessions!),
    activityAt: read(provider.activityAt),
    issueReadAt: read(provider.issueReadAt),
  }
}
