import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
/** Pool-only synthetic outputs frozen by the last green pilot parity run. */
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { MobileRowValues } from '@podium/client-graph/worklist/mobile-row'
import type { MobileWorkRef, MobileWorkSection, MobileWorkState } from '@podium/client-graph/worklist/mobile'
import type { CheckRow, SidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import { sidebarComparable, sessionComparable } from '@podium/client-graph/diagnostics/oracle'
import { mobileRowPaint } from '../../../../../apps/mobile/src/lib/work-sections'

function comparable(value: MobileRowValues): Record<string, unknown> {
  return { ...value, sidebar: value.sidebar ? sidebarComparable(value.sidebar) : null,
    sessions: value.sessions.map(sessionComparable) }
}

function poolRow(pool: MobxPool, ref: MobileWorkRef): CheckRow {
  const value = mobileWorkView(pool).row(ref)
  if (value === LOADING) return { id: ref.id, pending: true, fields: { loading: true } }
  if (value === undefined) return { id: ref.id, fields: { absent: true } }
  // Include the actual native formatter in the preserved output.
  const paint = mobileRowPaint(value, pool.clock.current)
  return { id: ref.id, fields: { ...comparable(value),
    statusLine: paint.statusLine, stamp: paint.stamp } }
}

export function poolMobileSnapshot(pool: MobxPool, state: MobileWorkState = {}): SidebarSnapshot {
  const split = mobileWorkView(pool).sections(state)
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

