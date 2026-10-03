/** Synthetic fixture and private count-only replay comparisons. */
import type { Store } from '@podium/client-core/engine'
import { allIssueViewModels, type IssueViewModel } from '@podium/client-core/replica'
import {
  allTabIds,
  cwdInWorktree,
  emptyWorkspace,
  focusedPane,
  type IssueNavigationModel,
  issueForCwd,
  reposToViews,
  resolveActiveWorktree,
  selectedMissionRoot,
  shippingPanelModel,
} from '@podium/client-core/viewmodels'
import type { MobxPool } from '../src/pool'
import { SHELL_SCHEMA, SHELL_SUMMARIES } from '../src/shell-schema'
import { shellViews } from '../src/shell-views'
import { LOADING } from '../src/worklist/rollup'
import { type CheckRow, compareSidebarSnapshots, type SidebarSnapshot } from './sidebar-check'

const fields = (value: object, keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key) ?? null]))
const row = (id: string, value: object): CheckRow => ({ id, fields: { value } })
const missionExpanded = (value: Pick<IssueNavigationModel, 'type' | 'childCount'> | undefined) =>
  Boolean(value && (value.type === 'epic' || value.childCount >= 6))
function colorChain(issues: readonly IssueViewModel[], selectedId: string | null) {
  let current = issues.find(
    (issue) => issue.id === selectedId && !issue.archived && !issue.deletedAt,
  )
  const values: object[] = [],
    seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    values.push(fields(current, ['id', 'color', 'parentId']))
    seen.add(current.id)
    current = issues.find((issue) => issue.id === current!.parentId)
  }
  return values
}
function closeFields(
  layout: Store['workspaces'][string] | undefined,
  key: string,
  files: Store['fileTabs'],
) {
  const value = layout ?? emptyWorkspace(key)
  return {
    key,
    layout: value,
    activeTabId: focusedPane(value).activeTabId,
    openTabIds: allTabIds(value),
    fileIds: files.map((file) => file.id),
  }
}
function shippingFields(
  orders: Store['shipOrders'],
  issues: readonly IssueViewModel[],
  repoId: string | null,
  lanes: Store['shipLanes'],
) {
  const model = shippingPanelModel(orders, issues, repoId, lanes)
  const values = (rows: typeof model.needsYou) =>
    rows.map((row) => ({
      id: row.order.id,
      issueId: row.issue?.id ?? null,
      queueRank: row.queueRank ?? null,
    }))
  return {
    unfinishedCount: model.unfinishedCount,
    decisionCount: model.decisionCount,
    needsYou: values(model.needsYou),
    inProgress: values(model.inProgress),
    waiting: model.waiting.map((lane) => ({
      destination: lane.destination,
      rows: values(lane.rows),
    })),
    recentlyShipped: values(model.recentlyShipped),
  }
}
export function legacyShellSnapshot(
  state: Store,
  suppliedIssues?: readonly IssueViewModel[],
): SidebarSnapshot {
  const issues =
    suppliedIssues ??
    allIssueViewModels(state.replica, state.issueProjections, state.issueUserStates)
  const { paneA, fileTabs, sessions, repos } = state
  const active = resolveActiveWorktree({ paneA, fileTabs, sessions })
  let scope: { repoId: string | null; repoPath: string } | null = null
  if (active) {
    for (const repo of reposToViews(repos)) {
      const worktree = repo.worktrees
        .filter(
          (tree) =>
            (!active.machineId || !tree.machineId || tree.machineId === active.machineId) &&
            cwdInWorktree(active.cwd, tree.path),
        )
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (worktree) {
        scope = { repoId: repo.repoId ?? worktree.repoId ?? null, repoPath: worktree.repoPath }
        break
      }
    }
    if (!scope) {
      const id =
        active.issueId ??
        sessions.find((session) => session.sessionId === active.sessionId)?.issueId
      const issue = id
        ? issues.find((issue) => issue.id === id)
        : issueForCwd([...issues], active.cwd)
      if (issue) scope = { repoId: issue.repoId ?? null, repoPath: issue.repoPath }
    }
  }
  const containing = active ? issueForCwd([...issues], active.cwd) : null
  const gitIssue =
    (active?.issueId ? issues.find((issue) => issue.id === active.issueId) : undefined) ??
    containing
  const key = state.workspaceKey()
  const missionRoot = selectedMissionRoot(issues, sessions, state.selectedIssueId)
  return {
    pending: 0,
    sections: [
      { key: 'window', fields: fields(state, SHELL_SCHEMA.shellWindow.fields), rows: [] },
      { key: 'approvals', fields: {}, rows: state.approvals.map((value) => row(value.id, value)) },
      { key: 'files', fields: {}, rows: state.fileTabs.map((value) => row(value.id, value)) },
      { key: 'close', fields: closeFields(state.workspaces[key], key, state.fileTabs), rows: [] },
      {
        key: 'chrome',
        fields: {
          repoCount: repos.length,
          worktreeCount: repos.reduce((sum, repo) => sum + repo.worktrees.length, 0),
          sessionCount: sessions.length,
          colors: colorChain(issues, state.selectedIssueId),
          missionRootId: missionRoot?.id ?? null,
          missionExpanded: missionExpanded(missionRoot),
        },
        rows: [],
      },
      {
        key: 'dock',
        fields: {
          active,
          scope,
          gitIssue: gitIssue ? fields(gitIssue, ['id', 'branch', 'gitState']) : null,
          mailIssueId:
            sessions.find((session) => session.sessionId === active?.sessionId)?.issueId ??
            containing?.id ??
            null,
        },
        rows: [],
      },
      {
        key: 'shipping',
        fields: shippingFields(state.shipOrders, issues, scope?.repoId ?? null, state.shipLanes),
        rows: [],
      },
      { key: 'orders', fields: {}, rows: state.shipOrders.map((value) => row(value.id, value)) },
      { key: 'lanes', fields: {}, rows: state.shipLanes.map((value) => row(value.id, value)) },
      { key: 'machines', fields: {}, rows: state.machines.map((value) => row(value.id, value)) },
      {
        key: 'sessions',
        fields: {},
        rows: sessions.map((value) => row(value.sessionId, fields(value, SHELL_SUMMARIES.session))),
      },
      {
        key: 'issues',
        fields: {},
        rows: [...issues]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((value) =>
            row(value.id, fields(value, [...SHELL_SUMMARIES.issue, 'prefix', 'displayRef'])),
          ),
      },
    ],
  }
}
export function poolShellSnapshot(pool: MobxPool): SidebarSnapshot {
  const views = shellViews(pool),
    state = views.window(),
    approvals = views.approvals(),
    files = views.files(),
    close = views.close(),
    chrome = views.chrome(),
    dock = views.dock(),
    shipping = views.shipping(),
    sessions = views.sessions(),
    issues = views.issues(),
    lanes = views.lanes()
  if (
    !state ||
    state === LOADING ||
    approvals === LOADING ||
    files === LOADING ||
    close === LOADING ||
    chrome === LOADING ||
    dock === LOADING ||
    shipping === LOADING ||
    sessions === LOADING ||
    issues === LOADING ||
    lanes === LOADING
  )
    return { pending: 1, sections: [] }
  return {
    pending: 0,
    sections: [
      { key: 'window', fields: fields(state, SHELL_SCHEMA.shellWindow.fields), rows: [] },
      {
        key: 'approvals',
        fields: {},
        rows: (approvals ?? []).map((value) => row(value.id, value)),
      },
      { key: 'files', fields: {}, rows: (files ?? []).map((value) => row(value.id, value)) },
      {
        key: 'close',
        fields: close ? closeFields(close.layout, close.workspaceKey, close.fileTabs) : {},
        rows: [],
      },
      {
        key: 'chrome',
        fields: chrome
          ? {
              repoCount: chrome.repoCount,
              worktreeCount: chrome.worktreeCount,
              sessionCount: chrome.sessionCount,
              colors: chrome.colors.map((value) => fields(value, ['id', 'color', 'parentId'])),
              missionRootId: chrome.missionRoot?.id ?? null,
              missionExpanded: missionExpanded(chrome.missionRoot),
            }
          : {},
        rows: [],
      },
      {
        key: 'dock',
        fields: dock
          ? {
              active: dock.active,
              scope: dock.scope,
              gitIssue: dock.gitIssue ? fields(dock.gitIssue, ['id', 'branch', 'gitState']) : null,
              mailIssueId: dock.mailIssueId ?? null,
            }
          : {},
        rows: [],
      },
      {
        key: 'shipping',
        fields: dock
          ? {
              ...shippingFields(
                dock.shipOrders,
                dock.issues,
                dock.scope?.repoId ?? null,
                dock.shipLanes,
              ),
              ...shipping,
            }
          : {},
        rows: [],
      },
      {
        key: 'orders',
        fields: {},
        rows: (dock?.shipOrders ?? []).map((value) => row(value.id, value)),
      },
      { key: 'lanes', fields: {}, rows: (lanes ?? []).map((value) => row(value.id, value)) },
      { key: 'machines', fields: {}, rows: views.machines().map((value) => row(value.id, value)) },
      {
        key: 'sessions',
        fields: {},
        rows: (sessions ?? []).map((value) =>
          row(value.sessionId, fields(value, SHELL_SUMMARIES.session)),
        ),
      },
      {
        key: 'issues',
        fields: {},
        rows: [...(issues ?? [])]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((value) =>
            row(value.id, fields(value, [...SHELL_SUMMARIES.issue, 'prefix', 'displayRef'])),
          ),
      },
    ],
  }
}
export function compareShellSnapshots(expected: SidebarSnapshot, actual: SidebarSnapshot) {
  const result = compareSidebarSnapshots(expected, actual)
  return {
    differences: result.differences,
    pending: result.pending,
    positions: result.rows + result.sections,
    first: result.first
      ? {
          sectionIndex: result.first.sectionIndex,
          rowIndex: result.first.rowIndex,
          field: result.first.field,
        }
      : null,
  }
}
export function checkShell(pool: MobxPool, state: Store, issues?: readonly IssueViewModel[]) {
  return compareShellSnapshots(legacyShellSnapshot(state, issues), poolShellSnapshot(pool))
}
