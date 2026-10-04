/** Diagnostic-only differential. It never observes, hydrates or mutates the pool.
 * Both sides use one store publication, one clock and one caller-owned layout.
 * Reports contain locations and IDs, never titles, questions or row values.
 */
import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import { partitionStaleSessions, rowStatusLine } from '@podium/client-core/values'
import { compareStructural } from 'mobx'
import type { MobxPool } from '../src/pool'
import type { SliceLocals } from '../src/shared/slice-types'
import { compareRank } from '../src/shared/row-view'
import { LOADING } from '../src/worklist/rollup'
import type { SidebarSections, SidebarState } from '../src/worklist/sidebar'
import { legacyDerivationFromStore, visibleIssueRows, type LegacyDerivation } from './legacy'
import { legacySidebarRow, legacySidebarSections, poolStatusLine, sidebarComparable, sessionComparable } from './oracle'

export interface CheckRow {
  readonly id: string
  /** Only payload comparisons wait for this row's batched loads. */
  readonly pending?: boolean
  /** An incomplete worktree roster can change membership and sort order.
   * Defer this ID in both sequences; all other IDs retain their relative order. */
  readonly placementPending?: boolean
  readonly fields: Readonly<Record<string, unknown>>
}
export interface CheckSection {
  readonly key: string
  readonly fields: Readonly<Record<string, unknown>>
  /** Header facts whose inputs are explicitly awaiting a batched load. */
  readonly pendingFields?: readonly string[]
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
  if (compareStructural(expected, actual)) return null
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

/** Compare known membership in display order, and payloads once settled.
 * A global pending count never suppresses a mismatch. Provisional roster IDs
 * rejoin the complete structural comparison as soon as their loads settle. */
export function compareSidebarSnapshots(expected: SidebarSnapshot, actual: SidebarSnapshot, onDifference?: (difference: SidebarDifference) => void): SidebarCheckResult {
  let differences = 0, first: SidebarDifference | null = null
  const flag = (difference: SidebarDifference): void => { differences += 1; first ??= difference; onDifference?.(difference) }
  for (let sectionIndex = 0; sectionIndex < Math.max(expected.sections.length, actual.sections.length); sectionIndex += 1) {
    const e = expected.sections[sectionIndex], a = actual.sections[sectionIndex]
    const location = { section: e?.key ?? a?.key ?? '', sectionIndex, rowIndex: null, expectedId: e?.key ?? null, actualId: a?.key ?? null }
    if (!e || !a || e.key !== a.key) { flag({ ...location, field: 'section' }); continue }
    const pendingFields = new Set([...(e.pendingFields ?? []), ...(a.pendingFields ?? [])])
    const settledFields = (fields: CheckSection['fields']) => Object.fromEntries(Object.entries(fields).filter(([key]) => !pendingFields.has(key)))
    const field = differingField(settledFields(e.fields), settledFields(a.fields))
    if (field !== null) flag({ ...location, field })
    const provisional = new Set([...e.rows, ...a.rows].filter(row => row.placementPending).map(row => row.id))
    const expectedRows = e.rows.map((row, index) => ({ row, index })).filter(({ row }) => !provisional.has(row.id))
    const actualRows = a.rows.map((row, index) => ({ row, index })).filter(({ row }) => !provisional.has(row.id))
    for (let index = 0; index < Math.max(expectedRows.length, actualRows.length); index += 1) {
      const expectedRow = expectedRows[index], actualRow = actualRows[index]
      const er = expectedRow?.row, ar = actualRow?.row
      const rowIndex = expectedRow?.index ?? actualRow!.index
      const rowLocation = { ...location, rowIndex, expectedId: er?.id ?? null, actualId: ar?.id ?? null }
      if (!er || !ar || er.id !== ar.id) { flag({ ...rowLocation, field: 'id' }); continue }
      if (er.pending || ar.pending) continue
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
      const worktreeRows = worktreeIds.map(worktree)
      // The empty-project affordance depends on whether any work survives.
      // Issue membership is known from placement summaries; a provisional
      // worktree-only lane cannot decide this fact until its roster settles.
      const pendingFields = !rowIds.length && !snoozedIds.length && !closedIds.length
        && worktreeRows.length > 0 && worktreeRows.every(row => row.placementPending) ? ['startFirstTask'] : []
      return [
        { key: `${band.key}:open`, fields, pendingFields, rows: [...rowIds.map(issue), ...worktreeRows] },
        { key: `${band.key}:snoozed`, fields: {}, rows: snoozedIds.map(issue) },
        { key: `${band.key}:closed`, fields: {}, rows: closedIds.map(issue) },
      ]
    }),
  ]
}

export function legacySidebarSnapshot(derivation: LegacyDerivation, locals: SliceLocals, state: SidebarState = {}): SidebarSnapshot {
  const rows = visibleIssueRows(derivation, locals)
  const byId = new Map<string, (typeof rows)[number]>(rows.map(row => [row.issue.id, row]))
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
      value = { id, pending: row === LOADING, fields: row === LOADING ? { loading: true } : row === undefined ? { absent: true } : {
        ...sidebarComparable(row), statusLine: poolStatusLine(row, pool.issue(id)?.activityAt ?? 0, pool.clock.current, (seat) => pool.row('session', seat)),
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
    return { id: path, pending: row.pending > 0, placementPending: row.pending > 0, fields: { sessions: row.sessions.map(sessionComparable), visible: row.visible.map(sessionComparable), stale: row.stale.map(sessionComparable),
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

export function checkSidebar(pool: MobxPool, store: Store<PodiumClientApi>, state: SidebarState = {}, onDifference?: (difference: SidebarDifference) => void): SidebarCheckResult {
  const locals: SliceLocals = { selectedIssueId: store.selectedIssueId ?? null, coarseNow: pool.clock.current, selectedIssueWasFolded: pool.foldLatch.get() }
  return compareSidebarSnapshots(legacySidebarSnapshot(legacyDerivationFromStore(store, locals.coarseNow), locals, state), poolSidebarSnapshot(pool, state), onDifference)
}
