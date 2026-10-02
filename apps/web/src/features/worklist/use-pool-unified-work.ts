import type { SessionView as SessionMeta } from '@podium/client-core/session-values'
import { beginSwitch } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import { pickPaneSession } from '@podium/client-core/viewmodels'
import { LOADING, type MobxPool } from '@podium/client-graph'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import {
  asIssueId,
  asSessionId,
  type IssueColorSlot,
  type IssueId,
  type SessionId} from '@podium/model/browser'
import { useMemo, useRef } from 'react'
import { useOperatorFocus } from '@/app/operator-focus'
import { navigationIssue } from './pool-row-data'

/** Navigation includes the formal mission at every depth and tasks filed by
 * its explicitly attached sessions. Display nesting is narrower than this:
 * hidden descendants and unstarted spin-offs can still supply a pane. */
function sessionMembership(pool: MobxPool, retainedOnly = false): Map<string, SessionMeta[]> {
  const byIssue = new Map<string, SessionMeta[]>()
  const retainedByIssue = new Map<string, ReadonlySet<string>>()
  for (const id of pool.tables.session.keys()) {
    const session = pool.row('session', id) as SessionMeta | typeof LOADING | undefined
    if (session === undefined || session === LOADING || !session.issueId) continue
    if (retainedOnly && session.headless !== true) {
      let retained = retainedByIssue.get(session.issueId)
      if (!retained) {
        retained = new Set(pool.graph.many('issue', session.issueId, 'sessions'))
        retainedByIssue.set(session.issueId, retained)
      }
      if (!retained.has(id)) continue
    }
    const members = byIssue.get(session.issueId)
    if (members) members.push(session)
    else byIssue.set(session.issueId, [session])
  }
  return byIssue
}

function missionMembers(
  pool: MobxPool,
  rootId: string,
  sessions: Map<string, SessionMeta[]>,
): Map<string, SliceIssue> {
  const members = new Map<string, SliceIssue>()
  const pending = [rootId]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const issue = pool.row('issue', id)
    if (issue === undefined || issue === LOADING) continue
    members.set(id, issue as SliceIssue)
    // The filtered formal edge excludes archived/deleted children, matching
    // missionParentId. Provenance does not recursively admit formal children.
    pending.push(...pool.graph.many('issue', id, 'children'))
  }
  const filed = [...members.keys()]
  for (let index = 0; index < filed.length; index += 1) {
    // Provenance also follows archived/headless senders. The visible-seat
    // relation excludes headless sessions, so use gesture-local membership.
    for (const session of sessions.get(filed[index]!) ?? []) {
      for (const id of pool.graph.many('session', session.sessionId, 'startedIssues')) {
        if (members.has(id)) continue
        const issue = pool.row('issue', id)
        if (issue === undefined || issue === LOADING) continue
        const candidate = issue as SliceIssue
        const departed =
          candidate.stage !== 'proposed' &&
          candidate.stage !== 'backlog' &&
          candidate.deps?.some((dep) => dep.type === 'discovered-from') === true
        if (departed) continue
        members.set(id, candidate)
        filed.push(id)
      }
    }
  }
  return members
}

/** Pool reads are gesture-local. Writes and batching remain the app's actions. */
export function createPoolWorkActions(
  pool: MobxPool,
  runtime: Pick<ReturnType<typeof useStoreHandle>, 'getSnapshot'>,
  focus: (id: string) => void,
) {
  let lastIssueNavigation: string | null = null
  const batch = (fn: () => void) =>
    (runtime.getSnapshot() as unknown as { batchGesture: (fn: () => void) => void }).batchGesture(
      fn,
    )
  const trace = (target: SessionId | null, issueId: IssueId | null) => {
    if (target && target !== runtime.getSnapshot().paneA && !target.startsWith('file:'))
      beginSwitch({ sessionId: asSessionId(target), issueId })
  }
  const selectIssue = (id: string, paneSession?: SessionId): void => {
    const clicked = pool.sidebar.row(id)
    if (clicked === undefined || clicked === LOADING) return
    let root: SliceIssue = clicked.issue
    const seen = new Set<string>()
    while (root.parentId && !seen.has(root.id)) {
      seen.add(root.id)
      // Archived/deleted ancestors can be cold by design. Their retained
      // summary ends the legacy root walk without requesting a hidden row.
      const hidden = pool.hidden('issue', root.parentId)
      if (hidden?.archived || hidden?.deletedAt) break
      const parent = pool.row('issue', root.parentId) as SliceIssue | typeof LOADING | undefined
      if (parent === LOADING) return
      if (parent === undefined || parent.archived || parent.deletedAt) break
      root = parent
    }
    const store = runtime.getSnapshot()
    const members = new Map<string, SessionMeta>()
    // R2 already applies resume collapse. Headless provenance remains raw;
    // it never participates in collapse or supplies a workspace pane.
    const sessions = sessionMembership(pool, true)
    const mission = missionMembers(pool, root.id, sessions)
    // The legacy candidate order is the slice order, including tie-breaking
    // on lastActiveAt. Walk resident keys, reading only this mission's rows.
    for (const member of pool.tables.issue.keys()) {
      const issue = mission.get(member)
      if (!issue) continue
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
        selectedIssueId: asIssueId(root.id),
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
    const store = runtime.getSnapshot()
    batch(() => {
      store.setSelectedIssueId(null)
      store.setSelectedWorktree(path)
      const members = [...pool.graph.many('worktree', path, 'sessions')].flatMap((id) => {
        const session = pool.row('session', id) as SessionMeta | typeof LOADING | undefined
        return session === undefined ||
          session === LOADING ||
          session.archived ||
          session.headless === true
          ? []
          : [session as unknown as SessionMeta]
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
    selectIssue,
    selectPanelForIssue: (id: string, sessionId: SessionId) => selectIssue(id, sessionId),
    selectWorktree,
    selectPanel: (path: string, sessionId: SessionId) => {
      const store = runtime.getSnapshot()
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
      const store = runtime.getSnapshot()
      store.setOpenIssueId(id)
      store.setView('issues')
    },
    renameIssue: (id: string, title: string) => {
      void runtime.getSnapshot().updateIssue(id, { title })
    },
    setIssueColor: (id: string, color: IssueColorSlot | null) =>
      runtime.getSnapshot().updateIssue(id, { color }),
    archiveIssue: (id: string) => runtime.getSnapshot().archiveIssue(id),
    deleteIssue: (id: string) => runtime.getSnapshot().deleteIssue(id),
    applySortPatches: (patches: { id: string; sortKey: string; pinned?: boolean }[]) =>
      Promise.all(patches.map(({ id, ...patch }) => runtime.getSnapshot().updateIssue(id, patch))),
    setIssueTucked: (id: string, tucked: boolean) =>
      runtime.getSnapshot().setIssueTucked(id, tucked),
    resolveMenuData: (id: string) => {
      // Only on menu open: enumerate resident issues, through the one reader.
      const sessions = sessionMembership(pool)
      const all = [...pool.tables.issue.keys()].flatMap((key) => {
        const value = pool.sidebar.row(key)
        if (value === undefined || value === LOADING) return []
        // These compatibility summaries used to arrive on the legacy issue
        // view. The menu needs the same cascade counts, membership and read
        // state; build them on open from resident relations and the one reader.
        const memberSessionIds = (sessions.get(key) ?? [])
          .filter((session) => session.agentKind !== 'shell')
          .map((session) => session.sessionId)
        const childIds = [...pool.graph.many('issue', key, 'treeChildren')]
        const childDoneCount = childIds.filter((id) => {
          const child = pool.row('issue', id) as SliceIssue | typeof LOADING | undefined
          return child !== undefined && child !== LOADING && child.stage === 'done'
        }).length
        return [
          {
            ...navigationIssue(value.issue),
            memberSessionIds,
            childIds: childIds.map(asIssueId),
            childCount: childIds.length,
            childDoneCount,
            unread: value.issue.unread,
            deferred: value.deferred,
          },
        ]
      })
      return { single: all.filter((issue) => issue.id === id), all }
    },
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
