import { allowImperativeRead } from '@podium/mobx-helpers'
import { beginSwitch } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { pickPaneSession } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/loading'
import { missions } from '@podium/client-graph/mission'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import {
  asIssueId,
  asSessionId,
  type IssueColorSlot,
  type IssueId,
  type SessionId,
} from '@podium/model/browser'
import { useMemo, useRef } from 'react'
import { useOperatorFocus } from '@/app/operator-focus'
import { readIssueMenuPoolInputs } from '@/features/issues/issue-menu-pool-inputs'
import { readIssueMenuOrigins } from '@/features/issues/issue-menu-readers'
import { navigationIssue } from './pool-row-data'
import type { UnifiedIssueRowMenuData } from './UnifiedIssueRow'

/** Addressed mission target seam shared with the explorer. It reads the raw
 * parent relation so an archived ancestor stops the walk, as in navigation. */
export function poolMissionRoot(
  pool: MobxPool,
  id: string | null,
): SliceIssue | typeof LOADING | undefined {
  if (!id) return undefined
  let current = pool.row('issue', id) as SliceIssue | typeof LOADING | undefined
  const seen = new Set<string>()
  while (
    current !== undefined &&
    current !== LOADING &&
    current.parentId &&
    !seen.has(current.id)
  ) {
    seen.add(current.id)
    const parentId = pool.graph.one('issue', current.id, 'treeParent')
    if (!parentId) break
    const summary = pool.row('issue', parentId, 'summary') as
      | SliceIssue
      | typeof LOADING
      | undefined
    if (summary === LOADING) return LOADING
    if (summary?.archived || summary?.deletedAt) break
    const parent = pool.row('issue', parentId) as SliceIssue | typeof LOADING | undefined
    if (parent === LOADING) return LOADING
    if (parent === undefined || parent.archived || parent.deletedAt) break
    current = parent
  }
  return current
}

/** Resolve one focus through formal parents and sender provenance. The sender
 * may be headless (outside R2) or cold; its declared owner summary still names
 * the issue, without a second membership index or an enumeration. */
export function poolMissionContains(
  pool: MobxPool,
  rootId: string,
  id: string,
): boolean | typeof LOADING {
  const seen = new Set<string>()
  const visit = (member: string): boolean | typeof LOADING => {
    if (member === rootId) return true
    if (seen.has(member)) return false
    seen.add(member)
    const issue = pool.row('issue', member) as SliceIssue | typeof LOADING | undefined
    if (issue === LOADING) return LOADING
    if (!issue) return false
    // Formal closure is rooted at the original mission only. A child of a
    // provenance member does not join unless it has its own sender route.
    const parents = new Set<string>([member])
    let parent = pool.graph.one('issue', member, 'parent')
    while (parent && !parents.has(parent)) {
      if (parent === rootId) return true
      parents.add(parent)
      const ancestor = pool.row('issue', parent)
      if (ancestor === LOADING) return LOADING
      if (!ancestor) break
      parent = pool.graph.one('issue', parent, 'parent')
    }
    if (
      issue.stage !== 'proposed' &&
      issue.stage !== 'backlog' &&
      issue.deps?.some((dep) => dep.type === 'discovered-from')
    )
      return false
    const starter = pool.graph.one('issue', member, 'startedBy')
    if (!starter) return false
    const sender = pool.row('session', starter, 'summary')
    if (sender === LOADING) return LOADING
    const owner = (sender as { issueId?: string } | undefined)?.issueId
    return owner ? visit(owner) : false
  }
  return visit(id)
}

/** Navigation includes the formal mission at every depth and tasks filed by
 * its explicitly attached sessions. Display nesting is narrower than this:
 * hidden descendants and unstarted spin-offs can still supply a pane. */
function sessionMembership(
  pool: MobxPool,
  issueIds?: ReadonlySet<string>,
): Map<string, SessionView[]> {
  const byIssue = new Map<string, SessionView[]>()
  // Navigation already has the mission. R2 supplies its retained, non-headless
  // candidates without reading or grouping every other session's row.
  const retained = issueIds ? new Set<string>() : undefined
  if (issueIds && retained)
    for (const id of issueIds) {
      for (const sessionId of pool.graph.many('issue', id, 'sessions')) retained.add(sessionId)
    }
  // A scoped question orders only its related resident slots. The unscoped
  // compatibility menu caller is retired by the separate menu-demand fix.
  const candidates = retained
    ? [...retained].filter(id => pool.tables.session.has(id)).sort((a, b) =>
      (pool.queries.residentInsertionOrder('session', a) ?? Infinity) -
      (pool.queries.residentInsertionOrder('session', b) ?? Infinity))
    : pool.tables.session.keys()
  for (const id of candidates) {
    const session = pool.row('session', id) as SessionView | typeof LOADING | undefined
    if (session === undefined || session === LOADING || !session.issueId) continue
    const members = byIssue.get(session.issueId)
    if (members) members.push(session)
    else byIssue.set(session.issueId, [session])
  }
  return byIssue
}

/** Pool reads are gesture-local. Writes and batching remain the app's actions. */
export function createPoolWorkActions(
  pool: MobxPool,
  runtime: Pick<ReturnType<typeof useStoreHandle>, 'access'>,
  focus: (id: string) => void,
) {
  let lastIssueNavigation: string | null = null
  const batch = (fn: () => void) =>
    (runtime.access as unknown as { batchGesture: (fn: () => void) => void }).batchGesture(
      fn,
    )
  const trace = (target: SessionId | null, issueId: IssueId | null) => {
    if (target && target !== runtime.access.paneA && !target.startsWith('file:'))
      beginSwitch({ sessionId: asSessionId(target), issueId })
  }
  const selectIssue = (id: string, paneSession?: SessionId): void => {
    const clicked = pool.sidebar.row(id)
    if (clicked === undefined || clicked === LOADING) return
    const mission = missions(pool)
    const rootId = mission.rootFor(id)
    if (rootId === undefined || rootId === LOADING) return
    const issueIds = mission.members(rootId)
    if (issueIds === LOADING) return
    const store = runtime.access
    const members = new Map<string, SessionView>()
    // R2 already applies resume collapse. Headless provenance remains raw;
    // it never participates in collapse or supplies a workspace pane.
    const sessions = sessionMembership(pool, issueIds)
    const orderedMembers = [...issueIds].filter(member => pool.tables.issue.has(member)).sort((a, b) =>
      (pool.queries.residentInsertionOrder('issue', a) ?? Infinity) -
      (pool.queries.residentInsertionOrder('issue', b) ?? Infinity))
    for (const member of orderedMembers) {
      // The app's issue membership summary comes from session.issueId and
      // excludes dock shells. Cwd-only seats can draw a row but do not become
      // workspace pane candidates for an issue.
      for (const session of sessions.get(member) ?? []) {
        if (!session.archived && session.headless !== true && session.agentKind !== 'shell')
          members.set(session.sessionId, session)
      }
    }
    const files = clicked.issue.worktreePath
      ? store.fileTabs.filter((f) => f.worktreePath === clicked.issue.worktreePath).map((f) => f.id)
      : []
    const target = paneSession ?? pickPaneSession([...members.values()], store.paneA, files)
    trace(target, asIssueId(id))
    batch(() => {
      const changed = store.navigateWorkspace({
        selectedIssueId: asIssueId(rootId),
        ...(clicked.issue.worktreePath ? { selectedWorktree: clicked.issue.worktreePath } : {}),
        tabId: target,
        firstPane: true,
      })
      const commandKey = JSON.stringify([id, paneSession, clicked.issue.updatedAt])
      if (!changed && lastIssueNavigation === commandKey) return
      lastIssueNavigation = commandKey
      void store.markIssueRead(id)
      if (clicked.unsnoozed) void store.deferIssue(id, null)
      if (paneSession) void store.markSessionRead(paneSession)
    })
    focus(id)
  }
  const selectWorktree = (path: string): void => {
    const store = runtime.access
    batch(() => {
      store.setSelectedIssueId(null)
      store.setSelectedWorktree(path)
      const members = [...pool.graph.many('worktree', path, 'sessions')].flatMap((id) => {
        const session = pool.row('session', id) as SessionView | typeof LOADING | undefined
        return session === undefined ||
          session === LOADING ||
          session.archived ||
          session.headless === true
          ? []
          : [session as unknown as SessionView]
      })
      const files = store.fileTabs.filter((f) => f.worktreePath === path).map((f) => f.id)
      const target = pickPaneSession(members, store.paneA, files)
      trace(target, null)
      store.setPane('A', target)
      if (target && members.some((s) => s.sessionId === target)) void store.markSessionRead(target)
      store.setView('workspace')
    })
  }
  return {
    selectIssue: (id: string, paneSession?: SessionId) => allowImperativeRead(() => selectIssue(id, paneSession)),
    selectPanelForIssue: (id: string, sessionId: SessionId) => allowImperativeRead(() => selectIssue(id, sessionId)),
    selectWorktree: (path: string) => allowImperativeRead(() => selectWorktree(path)),
    selectPanel: (path: string, sessionId: SessionId) => {
      const store = runtime.access
      batch(() => {
        trace(sessionId, null)
        store.setSelectedIssueId(null)
        store.setSelectedWorktree(path)
        store.setPane('A', sessionId)
        void store.markSessionRead(sessionId)
        store.setView('workspace')
      })
    },
    openIssuePage: (id: IssueId) => {
      const store = runtime.access
      store.setOpenIssueId(id)
      store.setView('issues')
    },
    renameIssue: (id: string, title: string) => {
      void runtime.access.updateIssue(id, { title })
    },
    setIssueColor: (id: string, color: IssueColorSlot | null) =>
      runtime.access.updateIssue(id, { color }),
    archiveIssue: (id: string) => runtime.access.archiveIssue(id),
    deleteIssue: (id: string) => runtime.access.deleteIssue(id),
    applySortPatches: (patches: { id: string; sortKey: string; pinned?: boolean }[]) =>
      Promise.all(patches.map(({ id, ...patch }) => runtime.access.updateIssue(id, patch))),
    setIssueTucked: (id: string, tucked: boolean) =>
      runtime.access.setIssueTucked(id, tucked),
    resolveMenuData: (id: string): UnifiedIssueRowMenuData => allowImperativeRead(() => {
      const value = pool.sidebar.row(id)
      if (!value || value === LOADING)
        return { single: [], all: [], poolInputs: value === LOADING ? LOADING : readIssueMenuPoolInputs(pool, []) }
      // The menu acts on this issue. Its membership and direct children are
      // declared per-key relations; no other issue or session is a candidate.
      const memberSessionIds = [...pool.graph.many('issue', id, 'sessions')].flatMap((key) => {
        const session = pool.row('session', key) as SessionView | typeof LOADING | undefined
        // R2 already declares this retained member. Preserve a pending ID so
        // the menu inputs wait for its addressed payload rather than omit it.
        if (session === LOADING) return [asSessionId(key)]
        return session && session.issueId === id && session.agentKind !== 'shell'
          ? [session.sessionId] : []
      })
      const childIds = [...pool.graph.many('issue', id, 'treeChildren')].map(asIssueId)
      const single = [{
        ...navigationIssue(value.issue),
        memberSessionIds,
        childIds,
        ...pool.queries.issueChildCounts(id),
        unread: value.issue.unread,
        deferred: value.deferred,
      }]
      // Placement needs only the direct origin's label. Catalog choices are
      // requested by the menu after their submenu becomes visible.
      const all = readIssueMenuOrigins(pool, single)
      return { single, all, poolInputs: readIssueMenuPoolInputs(pool, single) }
    }),
  }
}

export type PoolWorkActions = ReturnType<typeof createPoolWorkActions>

export function usePoolUnifiedWork(pool: MobxPool): PoolWorkActions {
  const runtime = useStoreHandle()
  const { setFocusedIssueId } = useOperatorFocus()
  const focus = useRef(setFocusedIssueId)
  focus.current = setFocusedIssueId
  return useMemo(
    () => createPoolWorkActions(pool, runtime, (id) => focus.current(id)),
    [pool, runtime],
  )
}
