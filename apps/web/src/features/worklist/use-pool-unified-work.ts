import { beginSwitch } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { allTabIds, pickPaneSession, workspaceKeyFor } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/loading'
import { omitGone } from '@podium/client-graph/lookup'
import { missions } from '@podium/client-graph/mission'
import { missionView, readMissionActionInputs } from '@podium/client-graph/mission-view'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { allowImperativeRead } from '@podium/mobx-helpers'
import { asIssueId, asSessionId, type IssueId, type SessionId } from '@podium/model/browser'
import { useMemo, useRef } from 'react'
import { useOperatorFocus } from '@/app/operator-focus'
import { readIssueMenuOrigins } from '@/features/issues/issue-menu-readers'
import type { UnifiedIssueRowMenuData } from './UnifiedIssueRow'

/** Addressed mission target seam shared with the dock's task panel. It reads the raw
 * parent relation so an archived ancestor stops the walk, as in navigation. */
export function poolMissionRoot(
  pool: MobxPool,
  id: string | null,
): SliceIssue | typeof LOADING | undefined {
  if (!id) return undefined
  let current = omitGone(pool.row('issue', id)) as SliceIssue | typeof LOADING | undefined
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
    const summary = omitGone(pool.row('issue', parentId, 'summary')) as
      | SliceIssue
      | typeof LOADING
      | undefined
    if (summary === LOADING) return LOADING
    if (summary?.archived || summary?.deletedAt) break
    const parent = omitGone(pool.row('issue', parentId)) as SliceIssue | typeof LOADING | undefined
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
    const issue = omitGone(pool.row('issue', member)) as SliceIssue | typeof LOADING | undefined
    if (issue === LOADING) return LOADING
    if (!issue) return false
    // Formal closure is rooted at the original mission only. A child of a
    // provenance member does not join unless it has its own sender route.
    const parents = new Set<string>([member])
    let parent = pool.graph.one('issue', member, 'parent')
    while (parent && !parents.has(parent)) {
      if (parent === rootId) return true
      parents.add(parent)
      const ancestor = omitGone(pool.row('issue', parent))
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
    const sender = omitGone(pool.row('session', starter, 'summary'))
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
    ? [...retained]
        .filter((id) => pool.tables.session.has(id))
        .sort(
          (a, b) =>
            (pool.queries.residentInsertionOrder('session', a) ?? Infinity) -
            (pool.queries.residentInsertionOrder('session', b) ?? Infinity),
        )
    : pool.tables.session.keys()
  for (const id of candidates) {
    const session = omitGone(pool.row('session', id)) as SessionView | typeof LOADING | undefined
    if (session === undefined || session === LOADING || !session.issueId) continue
    const members = byIssue.get(session.issueId)
    if (members) members.push(session)
    else byIssue.set(session.issueId, [session])
  }
  return byIssue
}

export type ArchiveIssueTree = { rootId: string; ids: readonly string[]; queued: boolean }

function poolArchiveBatch(
  pool: MobxPool,
  rootIds: readonly string[],
): ArchiveIssueTree[] | typeof LOADING {
  const trees: ArchiveIssueTree[] = []
  const seen = new Set<string>()
  for (const rootId of rootIds) {
    const ids: string[] = []
    const stack = [rootId]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      // The relation index includes cold children. Their declared summaries
      // provide archive state without warming the entire subtree.
      const row = omitGone(pool.row('issue', id, 'summary-fields'))
      if (row === LOADING) return LOADING
      if (!row) throw new Error('Could not load all tasks to archive')
      // The server stops its cascade at an archived or deleted child too.
      if (row.archived || row.deletedAt) continue
      ids.push(id)
      stack.push(...pool.graph.many('issue', id, 'treeChildren'))
    }
    if (ids.length) trees.push({ rootId, ids, queued: false })
  }
  return trees
}

/** Pool reads are gesture-local. Writes and batching remain the app's actions. */
export function createPoolWorkActions(
  pool: MobxPool,
  runtime: Pick<ReturnType<typeof useStoreHandle>, 'access' | 'outbox' | 'ui'>,
  focus: (id: string) => void,
) {
  let lastIssueNavigation: string | null = null
  const batch = (fn: () => void) =>
    (runtime.access as unknown as { batchGesture: (fn: () => void) => void }).batchGesture(fn)
  const trace = (target: SessionId | null, issueId: IssueId | null) => {
    if (target && target !== runtime.ui.paneA && !target.startsWith('file:'))
      beginSwitch({ sessionId: asSessionId(target), issueId })
  }
  const selectIssue = (id: string, paneSession?: SessionId): void => {
    const clicked = sidebarView(pool).row(id)
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
    const orderedMembers = [...issueIds]
      .filter((member) => pool.tables.issue.has(member))
      .sort(
        (a, b) =>
          (pool.queries.residentInsertionOrder('issue', a) ?? Infinity) -
          (pool.queries.residentInsertionOrder('issue', b) ?? Infinity),
      )
    for (const member of orderedMembers) {
      // The app's issue membership summary comes from session.issueId and
      // excludes dock shells. Cwd-only seats can draw a row but do not become
      // workspace pane candidates for an issue.
      for (const session of sessions.get(member) ?? []) {
        if (!session.archived && session.headless !== true && session.agentKind !== 'shell')
          members.set(session.sessionId, session)
      }
    }
    const layout = runtime.ui.workspaces?.[workspaceKeyFor({ missionRootId: rootId })]
    const restoreLayout = layout !== undefined && allTabIds(layout).length > 0
    // POD-2034: with no remembered pane, the clicked task's coordinator wins,
    // then the mission root's, before falling back to the most recent agent.
    const coordinatorOf = (issueId: string) => {
      const issue = omitGone(pool.row('issue', issueId)) as SliceIssue | typeof LOADING | undefined
      return issue === undefined || issue === LOADING ? null : issue.coordinatorSessionId
    }
    const target =
      paneSession ??
      (restoreLayout
        ? null
        : pickPaneSession(
            [...members.values()],
            null,
            [],
            [coordinatorOf(id), coordinatorOf(rootId)],
          ))
    // A task click restores its whole layout. Opening a fallback session here
    // would replace its saved artifact selection or move focus between panes.
    const remembered = layout?.panes[layout.focusedPaneId]?.activeTabId
    trace(target ?? (remembered ? asSessionId(remembered) : null), asIssueId(id))
    batch(() => {
      const changed = runtime.ui.navigateWorkspace({
        selectedIssueId: asIssueId(rootId),
        ...(clicked.issue.worktreePath ? { selectedWorktree: clicked.issue.worktreePath } : {}),
        tabId: target,
        firstPane: true,
      })
      const commandKey = JSON.stringify([id, paneSession, clicked.issue.updatedAt])
      if (!changed && lastIssueNavigation === commandKey) return
      lastIssueNavigation = commandKey
      void store.markIssueRead(id)
      if (clicked.returnedFromDefer) void store.deferIssue(id, null)
      if (paneSession) void store.markSessionRead(paneSession)
    })
    focus(id)
  }
  return {
    selectIssue: (id: string, paneSession?: SessionId) =>
      allowImperativeRead(() => selectIssue(id, paneSession)),
    selectPanelForIssue: (id: string, sessionId: SessionId) =>
      allowImperativeRead(() => selectIssue(id, sessionId)),
    openIssuePage: (id: IssueId) => {
      const store = runtime.access
      runtime.ui.setOpenIssueId(id)
      runtime.ui.setView('issues')
    },
    renameIssue: (id: string, title: string) => {
      void runtime.access.updateIssue(id, { title })
    },
    archiveIssue: (id: string) => runtime.access.archiveIssue(id),
    captureArchiveBatch: (rootIds: readonly string[]) =>
      allowImperativeRead(() => poolArchiveBatch(pool, rootIds)),
    subscribeArchiveChanges: (notify: () => void) => runtime.outbox.subscribe(notify),
    archiveBatchPending: (trees: readonly ArchiveIssueTree[]) =>
      trees.length > 0 &&
      (trees.some((tree) => !tree.queued) ||
        runtime.outbox.pending().some(
          // An archive is a plain-field edit of the issue record (POD-6405).
          (entry) =>
            entry.kind === 'recordEdit' &&
            (entry.input as { kind?: unknown }).kind === 'issueProjection' &&
            (entry.input as { patch?: { archived?: unknown } }).patch?.archived === true &&
            trees.some((tree) => tree.rootId === (entry.input as { id: string }).id),
        )),
    unarchiveBatch: (trees: readonly ArchiveIssueTree[]) =>
      Promise.all(
        trees.flatMap((tree) =>
          tree.ids.map((id) => runtime.access.updateIssue(id, { archived: false })),
        ),
      ),
    deleteIssue: (id: string) => runtime.access.deleteIssue(id),
    // A drag across the Pinned edge also pins or unpins: my pin record
    // (POD-6692), beside the issue's own order key.
    applySortPatches: (patches: { id: string; sortKey: string; pinned?: boolean }[]) =>
      Promise.all(
        patches.flatMap(({ id, sortKey, pinned }) => [
          runtime.access.updateIssue(id, { sortKey }),
          ...(pinned === undefined ? [] : [runtime.access.setPinned('issue', id, pinned)]),
        ]),
      ),
    undeferIssue: (id: string) => runtime.access.undeferIssue(id),
    setIssueTucked: (id: string, tucked: boolean) => runtime.access.setIssueTucked(id, tucked),
    resolveMenuData: (id: string): UnifiedIssueRowMenuData =>
      allowImperativeRead(() => {
        const inputs = readMissionActionInputs(missionView(pool), [id])
        if (inputs === LOADING) return { single: [], all: [], poolInputs: LOADING }
        // The menu displays child/cascade totals and one handoff sender, never
        // the sidebar's hidden attachment roster or its child IDs.
        const single = inputs.issues
        // Placement needs only the direct origin's label. Catalog choices are
        // requested by the menu after their submenu becomes visible.
        const all = readIssueMenuOrigins(pool, single)
        return { single, all, poolInputs: inputs }
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
