import { mobileIssueValues, mobileWorktreeValues } from '@podium/client-graph/worklist/mobile-row'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import type { WorklistWorktree } from '@podium/client-graph/worklist/worktree'
import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
/** Pool-only synthetic outputs frozen by the last green pilot parity run. */
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { MobileRowValues } from '@podium/client-graph/worklist/mobile-row'
import type { MobileWorkRef, MobileWorkState } from '@podium/client-graph/worklist/mobile'
import type { CheckRow, SidebarSnapshot } from '../../../diagnostics/sidebar-check'
import { sidebarComparable, sessionComparable } from '../../../diagnostics/oracle'
import { mobileRowPaint, MobileSearchSections, MobileNativeSections, type MobileWorkSection } from '../../../../../apps/mobile/src/lib/work-sections'

function comparable(value: MobileRowValues): Record<string, unknown> {
  return { ...value, sidebar: value.sidebar ? sidebarComparable(value.sidebar) : null,
    sessions: value.sessions.map(sessionComparable) }
}

function poolRow(pool: MobxPool, ref: MobileWorkRef): CheckRow {
  const row = mobileWorkView(pool).mobileRow(ref)
  const value = row === LOADING || row === undefined ? row : mobileComparable(row)
  if (value === LOADING) return { id: ref.id, pending: true, fields: { loading: true } }
  if (value === undefined) return { id: ref.id, fields: { absent: true } }
  // Include the actual native formatter in the preserved output.
  const paint = mobileRowPaint(value, pool.clock.current)
  return { id: ref.id, fields: { ...comparable(value),
    statusLine: paint.statusLine, stamp: paint.stamp } }
}

export function poolMobileSnapshot(pool: MobxPool, state: MobileWorkState = {}): SidebarSnapshot {
  const answer = mobileWorkView(pool).mobileSections()
  // A diagnostic can compare several layouts while a live reader holds the
  // default one. Reading a snapshot must not replace that reader's layout.
  const source = (key: string, ordering: boolean) => {
    const section = answer.section(key)
    return {
      key, label: section.label, kind: section.kind,
      total: ordering ? section.allIds.length : section.total,
      data: ordering ? section.allIds : section.liveIds,
      snoozedIds: section.snoozedIds, closedIds: section.closedIds,
      foldKey: section.foldKey, collapsed: false,
    }
  }
  const native = new MobileSearchSections().update(pool, answer.sectionKeys.map(key => source(key, false)), '')
  const collapsed = new Set(native.filter(section => state.collapsed?.[section.foldKey] === true).map(section => section.key))
  const split = { issueCount: answer.issueCount, pinnedCount: answer.pinnedCount,
    attentionCount: answer.attentionCount, pending: answer.pending,
    sections: new MobileNativeSections().update(native, collapsed, state.searching === true),
    orderingSections: new MobileSearchSections(true).update(pool, answer.orderingSectionKeys.map(key => source(key, true)), '') }
  let pending = split.pending
  const cache = new Map<string, CheckRow>()
  const row = (ref: MobileWorkRef): CheckRow => {
    const key = `${ref.kind}:${ref.id}`
    let value = cache.get(key)
    if (value === undefined) { value = poolRow(pool, ref); cache.set(key, value); if (value.pending) pending += 1 }
    return { ...value, id: ref.listKey }
  }
  const project = (section: MobileWorkSection, ordering: boolean) => {
    const { data, ...fields } = section
    const { key, ...header } = fields
    return { key: `${ordering ? 'ordering:' : ''}${key}`, fields: header, rows: data.map(row) }
  }
  const sections = [
    { key: 'counts', fields: { issueCount: split.issueCount, pinnedCount: split.pinnedCount, attentionCount: split.attentionCount }, rows: [] },
    ...split.sections.map(section => project(section, false)), ...split.orderingSections.map(section => project(section, true)),
    { key: 'all-rows', fields: {}, rows: split.orderingSections.flatMap(section => [...section.data,
      ...[...section.snoozedIds, ...section.closedIds].map(id => ({ id, kind: 'issue' as const, listKey: id }))]).map(row) },
  ]
  return { pending, sections }
}


export function mobileComparable(row: WorklistIssue | WorklistWorktree): MobileRowValues {
  if ('issue' in row) return mobileIssueValues(sidebarComparable(row) as unknown as Parameters<typeof mobileIssueValues>[0], row.waitingCount, row.visibleActivityAt)
  return mobileWorktreeValues(row.id, row.worktree.repoName, row.worktree.branch, row.sessions as never,
    row.activityAt, session => row.worklist.pool.sessionObject(session.sessionId).executing,
    session => row.worklist.pool.sessionObject(session.sessionId).open,
    session => row.worklist.pool.sessionObject(session.sessionId).stateSinceMs)
}
