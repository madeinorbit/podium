import { beginSwitch } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import { pickPaneSession } from '@podium/client-core/viewmodels'
import { LOADING, type MobxPool } from '@podium/client-graph'
import {
  asIssueId,
  asSessionId,
  type IssueColorSlot,
  type IssueId,
  type SessionId,
  type SessionMeta,
} from '@podium/model/browser'
import { useMemo, useRef } from 'react'
import { useOperatorFocus } from '@/app/operator-focus'
import { navigationIssue } from './pool-row-data'

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
    let root = clicked
    const seen = new Set<string>()
    while (root.issue.parentId && !seen.has(root.issue.id)) {
      seen.add(root.issue.id)
      const parent = pool.sidebar.row(root.issue.parentId)
      if (
        parent === undefined ||
        parent === LOADING ||
        parent.issue.archived ||
        parent.issue.deletedAt
      )
        break
      root = parent
    }
    const store = runtime.getSnapshot()
    const members = new Map<string, SessionMeta>()
    for (const member of [root.issue.id, ...(pool.issue(root.issue.id)?.nested ?? [])]) {
      const issue = pool.issue(member)
      if (!issue) continue
      const ids = new Set([...pool.graph.many('issue', member, 'sessions'), ...issue.laneMemberIds])
      for (const sessionId of ids) {
        const session = pool.row('session', sessionId) as SessionMeta | typeof LOADING | undefined
        if (
          session !== undefined &&
          session !== LOADING &&
          !session.archived &&
          session.headless !== true
        )
          members.set(sessionId, session as unknown as SessionMeta)
      }
    }
    const files = clicked.issue.worktreePath
      ? store.fileTabs.filter((f) => f.worktreePath === clicked.issue.worktreePath).map((f) => f.id)
      : []
    const target = paneSession ?? pickPaneSession([...members.values()], store.paneA, files)
    trace(target, asIssueId(id))
    batch(() => {
      const changed = store.navigateWorkspace({
        selectedIssueId: asIssueId(root.issue.id),
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
    applySortPatches: (patches: { id: string; sortKey: string; pinned?: boolean }[]) =>
      Promise.all(patches.map(({ id, ...patch }) => runtime.getSnapshot().updateIssue(id, patch))),
    setIssueTucked: (id: string, tucked: boolean) =>
      runtime.getSnapshot().setIssueTucked(id, tucked),
    resolveMenuData: (id: string) => {
      // Only on menu open: enumerate resident issues, through the one reader.
      const all = [...pool.tables.issue.keys()].flatMap((key) => {
        const value = pool.sidebar.row(key)
        return value === undefined || value === LOADING ? [] : [navigationIssue(value.issue)]
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
