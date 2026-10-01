/** Diagnostic-only differential. It never observes, hydrates or mutates the pool.
 * Both sides use one store publication, one clock and one caller-owned layout.
 * Reports contain locations and IDs, never titles, questions or row values.
 */
import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import { partitionStaleSessions, rowStatusLine } from '@podium/client-core/viewmodels'
import { comparer } from 'mobx'
import type { MobxPool } from '../src/pool'
import type { SliceLocals } from '../src/shared/slice-types'
import { compareRank } from '../src/shared/row-view'
import { LOADING } from '../src/worklist/rollup'
import type { SidebarSections, SidebarState } from '../src/worklist/sidebar'
import { legacyDerivationFromStore, visibleIssueRows, type LegacyDerivation } from './legacy'
import { legacySidebarRow, legacySidebarSections, poolStatusLine, sidebarComparable, sessionComparable } from './oracle'

export interface CheckRow {
  readonly id: string
  readonly fields: Readonly<Record<string, unknown>>
}
export interface CheckSection {
  readonly key: string
  readonly fields: Readonly<Record<string, unknown>>
  readonly rows: readonly CheckRow[]
}
export interface SidebarSnapshot {
  readonly sections: readonly CheckSection[]
  readonly pending: number
}
export interface SidebarDifference {
  readonly section: string
  readonly sectionIndex: number
  readonly rowIndex: number | null
  readonly expectedId: string | null
  readonly actualId: string | null
  readonly field: string
}
export interface SidebarCheckResult {
  readonly differences: number
  readonly first: SidebarDifference | null
  readonly pending: number
  readonly sections: number
  readonly rows: number
}

/** Finds the first leaf, including absent keys and extra array elements. */
function differingField(expected: unknown, actual: unknown, path = ''): string | null {
  if (comparer.structural(expected, actual)) return null
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object') {
    const e = expected as Record<string, unknown>, a = actual as Record<string, unknown>
    for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
      const next = Array.isArray(expected) ? `${path}[${key}]` : path ? `${path}.${key}` : key
      if (!Object.hasOwn(e, key) || !Object.hasOwn(a, key)) return next
      const field = differingField(e[key], a[key], next)
      if (field !== null) return field
    }
  }
  return path || 'value'
}

/** Compare in display order. An extra pool row is as much a failure as a missing row. */
export function compareSidebarSnapshots(expected: SidebarSnapshot, actual: SidebarSnapshot): SidebarCheckResult {
  let differences = 0, first: SidebarDifference | null = null
  const flag = (difference: SidebarDifference): void => { differences += 1; first ??= difference }
  for (let sectionIndex = 0; sectionIndex < Math.max(expected.sections.length, actual.sections.length); sectionIndex += 1) {
    const e = expected.sections[sectionIndex], a = actual.sections[sectionIndex]
    const location = { section: e?.key ?? a?.key ?? '', sectionIndex, rowIndex: null, expectedId: e?.key ?? null, actualId: a?.key ?? null }
    if (!e || !a || e.key !== a.key) { flag({ ...location, field: 'section' }); continue }
    const field = differingField(e.fields, a.fields)
    if (field !== null) flag({ ...location, field })
    for (let rowIndex = 0; rowIndex < Math.max(e.rows.length, a.rows.length); rowIndex += 1) {
      const er = e.rows[rowIndex], ar = a.rows[rowIndex]
      const rowLocation = { ...location, rowIndex, expectedId: er?.id ?? null, actualId: ar?.id ?? null }
      if (!er || !ar || er.id !== ar.id) { flag({ ...rowLocation, field: 'id' }); continue }
      const rowField = differingField(er.fields, ar.fields)
      if (rowField !== null) flag({ ...rowLocation, field: rowField })
    }
  }
  return { differences, first, pending: expected.pending + actual.pending, sections: expected.sections.length,
    rows: expected.sections.reduce((count, section) => count + section.rows.length, 0) }
}

function sectionSnapshot(sections: SidebarSections, issue: (id: string) => CheckRow, worktree: (id: string) => CheckRow): CheckSection[] {
  return [
    { key: 'pinned', fields: { collapsed: sections.pinnedCollapsed, foldKey: sections.pinnedFoldKey }, rows: sections.pinnedIds.map(issue) },
    ...sections.bands.flatMap(band => {
      const { rowIds, worktreeIds, snoozedIds, closedIds, ...fields } = band
      return [
        { key: `${band.key}:open`, fields, rows: [...rowIds.map(issue), ...worktreeIds.map(worktree)] },
        { key: `${band.key}:snoozed`, fields: {}, rows: snoozedIds.map(issue) },
        { key: `${band.key}:closed`, fields: {}, rows: closedIds.map(issue) },
      ]
    }),
  ]
}

export function legacySidebarSnapshot(derivation: LegacyDerivation, locals: SliceLocals, state: SidebarState = {}): SidebarSnapshot {
  const rows = visibleIssueRows(derivation, locals)
  const byId = new Map(rows.map(row => [row.issue.id, row]))
  const issues = new Map<string, CheckRow>()
  const issue = (id: string): CheckRow => {
    let value = issues.get(id)
    if (!value) {
      const row = byId.get(id)
      value = { id, fields: row ? { ...legacySidebarRow(row, derivation, locals.coarseNow),
        statusLine: row.continuation ?? rowStatusLine(row, locals.coarseNow, 0) } : { absent: true } }
      issues.set(id, value)
    }
    return value
  }
  const worktree = (path: string): CheckRow => {
    const row = derivation.slice.work.find(row => row.kind === 'worktree' && row.worktree.path === path)
    if (!row || row.kind !== 'worktree') return { id: path, fields: { absent: true } }
    const partition = partitionStaleSessions(row.worktree.sessions, locals.coarseNow)
    const ownerIds = new Set(row.worktree.sessions.flatMap(session => session.issueId ? [session.issueId] : []))
    return { id: path, fields: {
      sessions: row.worktree.sessions.map(sessionComparable), visible: partition.visible.map(sessionComparable), stale: partition.stale.map(sessionComparable),
      activityAt: row.activityAt, branch: row.worktree.branch ?? null, repoName: row.worktree.repoName,
      active: locals.selectedIssueId === null && state.selectedWorktree === path,
      owners: [...ownerIds].map(id => ownerComparable(derivation.models.find(model => model.id === id))),
    } }
  }
  const sections = legacySidebarSections(derivation, state, locals.selectedIssueId, locals.selectedIssueWasFolded === true, locals.coarseNow)
  return { sections: [...sectionSnapshot(sections, issue, worktree), { key: 'all-visible', fields: {}, rows: rows.map(row => issue(row.issue.id)) }], pending: 0 }
}

function ownerComparable(issue: unknown): unknown {
  if (!issue) return null
  const row = issue as Record<string, unknown>
  return Object.fromEntries(['id', 'seq', 'displayRef', 'archived', 'deletedAt'].map(key => [key, row[key] ?? null]))
}

export function poolSidebarSnapshot(pool: MobxPool, state: SidebarState = {}): SidebarSnapshot {
  let pending = 0
  const issues = new Map<string, CheckRow>()
  const issue = (id: string): CheckRow => {
    let value = issues.get(id)
    if (!value) {
      const row = pool.sidebar.row(id)
      if (row === LOADING) pending += 1
      value = { id, fields: row === LOADING ? { loading: true } : row === undefined ? { absent: true } : {
        ...sidebarComparable(row), statusLine: poolStatusLine(row, pool.issue(id)?.activityAt ?? 0, pool.clock.current),
      } }
      issues.set(id, value)
    }
    return value
  }
  const worktree = (path: string): CheckRow => {
    const row = pool.sidebar.worktree(path, state)
    if (!row) return { id: path, fields: { absent: true } }
    pending += row.pending
    const ownerIds = new Set(row.sessions.flatMap(session => session.issueId ? [session.issueId] : []))
    return { id: path, fields: { sessions: row.sessions.map(sessionComparable), visible: row.visible.map(sessionComparable), stale: row.stale.map(sessionComparable),
      activityAt: row.activityAt, branch: row.worktree.branch ?? null, repoName: row.worktree.repoName, active: row.active,
      owners: [...ownerIds].map(id => ownerComparable(row.issues.find(owner => owner.id === id))),
    } }
  }
  const sections = sectionSnapshot(pool.sidebar.sections(state), issue, worktree)
  const layout = pool.groups.layout
  const ids = [...layout.pinnedIds, ...layout.groups.flatMap(group => [...group.rowIds, ...group.closedIds])]
  const ranks = new Map(ids.map(id => [id, pool.groups.rankOf(id)!]))
  ids.sort((a, b) => compareRank(ranks.get(a)!, ranks.get(b)!))
  sections.push({ key: 'all-visible', fields: {}, rows: ids.map(issue) })
  return { sections, pending }
}

export function checkSidebar(pool: MobxPool, store: Store<PodiumClientApi>, state: SidebarState = {}): SidebarCheckResult {
  const locals: SliceLocals = { selectedIssueId: store.selectedIssueId ?? null, coarseNow: pool.clock.current, selectedIssueWasFolded: pool.foldLatch.get() }
  return compareSidebarSnapshots(legacySidebarSnapshot(legacyDerivationFromStore(store, locals.coarseNow), locals, state), poolSidebarSnapshot(pool, state))
}
