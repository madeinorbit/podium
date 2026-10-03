/** The oracle alone reads the legacy mobile derivation. Product pool rows
 * and bands never import this module or the mobile section function. */
import {
  deriveFleetPresence, formatClock, isDraftAgentVessel, issueDisplayTitle, missionProgress,
  rowAwaitsTuck, rowHasWorkingSession, rowMotionTiming, rowPendingDecision,
  rowStatusLine, rowUnreadEmphasized, rowWaitingCount, type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import { relativeTime } from '@podium/client-core/focus'
import { isIssueDeferred, issueReturnedFromDefer } from '@podium/model'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { MobileRowValues } from '@podium/client-graph/worklist/mobile-row'
import type { MobileWorkRef, MobileWorkSection, MobileWorkState } from '@podium/client-graph/worklist/mobile'
import { compareSidebarSnapshots, type CheckRow, type SidebarDifference, type SidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import { sidebarComparable, legacySidebarRow, sessionComparable } from '@podium/client-graph/diagnostics/oracle'
import { buildWorkSections, foldWorkSections, workRowListKey, workRowId, type WorkSection } from '../../../../../apps/mobile/src/lib/work-sections'
import type { LegacyDerivation } from './oracle'

function stamp(timing: MobileRowValues['timing'], now: number): string | null {
  if (timing.phase === 'done') return timing.totalMs !== undefined ? `∑ ${formatClock(timing.totalMs)}` : null
  if (!Number.isFinite(timing.sinceMs) || timing.sinceMs <= 0) return null
  if (timing.phase === 'working') return formatClock(Math.max(0, now - timing.sinceMs) + (timing.baseMs ?? 0))
  if (timing.phase === 'waiting') return relativeTime(new Date(timing.sinceMs).toISOString(), now)
  return null
}

function comparable(value: MobileRowValues): Record<string, unknown> {
  return { ...value, sidebar: value.sidebar ? sidebarComparable(value.sidebar) : null,
    sessions: value.sessions.map(sessionComparable) }
}

function legacyRow(row: UnifiedWorkRow, derivation: LegacyDerivation, now: number): CheckRow {
  const issue = row.kind === 'issue' ? row.issue : undefined
  const sessions = row.kind === 'issue' ? row.sessions : row.worktree.sessions
  const aggregate = row.kind === 'issue' ? row.aggregateSessions ?? sessions : sessions
  const fleet = deriveFleetPresence(aggregate)
  const draftOnly = issue ? isDraftAgentVessel(issue, sessions) : false
  const draftQuiet = draftOnly && !sessions[0]?.busy && (sessions[0]?.agentState?.phase ?? 'unknown') === 'unknown'
  const waitingCount = rowWaitingCount(row)
  const decision = row.kind === 'issue' ? rowPendingDecision(row) : null
  const originId = issue?.deps.find(dep => dep.type === 'discovered-from')?.id
  const originSeq = originId ? derivation.models.find(model => model.id === originId)?.seq ?? null : null
  const id = workRowId(row)
  const timing = rowMotionTiming(row)
  const fields = {
    id, kind: row.kind,
    label: issue ? issueDisplayTitle(issue, derivation.sessions, derivation.allWorktreePaths)
      : row.kind === 'worktree' ? `${row.worktree.repoName ?? ''}${row.worktree.branch ? ` · ${row.worktree.branch}` : ''}` : '',
    progress: row.kind === 'issue' ? row.missionRollup?.progress ?? missionProgress(derivation.models, derivation.sessions, row.issue.id) : null,
    originSeq, timing, working: rowHasWorkingSession(row), waitingCount, decision,
    unread: rowUnreadEmphasized(row) && !draftQuiet, draftOnly, draftQuiet, color: issue?.color ?? null,
    internal: issue?.audience === 'agent', pinned: issue?.pinned === true,
    snoozed: issue ? isIssueDeferred(issue, now) : false, unsnoozed: issue ? issueReturnedFromDefer(issue, now) : false,
    tuckable: row.kind === 'issue' ? rowAwaitsTuck(row, null, false, now) : false,
    fleet: { total: fleet.present.length, parkedCount: fleet.parkedCount, nativeCount: fleet.nativeCount, tiles: fleet.tiles },
    branch: issue?.branch ?? (row.kind === 'worktree' ? row.worktree.branch : null) ?? null,
    gitState: issue?.gitState, suppressAhead: decision === 'merge',
    attentionAction: waitingCount > 0 && issue ? decision ? 'Review' : 'Answer' : null,
    navigation: issue && !draftOnly ? { kind: 'issue', id: issue.id }
      : sessions[0] ? { kind: 'session', id: sessions[0].sessionId } : null,
    sidebar: row.kind === 'issue' ? legacySidebarRow(row, derivation, now) : null,
    sessions: sessions.map(sessionComparable), activityAt: row.activityAt,
    statusLine: rowStatusLine(row, now, 0), stamp: stamp(timing, now),
  }
  return { id, fields }
}

function poolRow(pool: MobxPool, ref: MobileWorkRef): CheckRow {
  const value = pool.mobileWork.row(ref)
  if (value === LOADING) return { id: ref.id, pending: true, fields: { loading: true } }
  if (value === undefined) return { id: ref.id, fields: { absent: true } }
  const sidebar = value.sidebar
  // Run the unchanged formatter on pool inputs. Mobile does not override
  // task/decision copy with the web row's continuation-first presentation.
  const row = sidebar ? { kind: 'issue', issue: sidebar.issue, sessions: sidebar.sessions,
    aggregateSessions: sidebar.aggregateSessions, activityAt: value.activityAt,
    missionRollup: { progress: sidebar.progress, fromChildren: sidebar.statusFromChildren },
    continuation: sidebar.continuation ? `${sidebar.continuation.kind} · ${sidebar.continuation.ref}` : undefined,
  } : { kind: 'worktree', worktree: { sessions: value.sessions }, activityAt: value.activityAt }
  return { id: ref.id, fields: { ...comparable(value),
    statusLine: sidebar?.awaitingFirstPrompt ? 'awaiting first prompt' : rowStatusLine(row as unknown as UnifiedWorkRow, pool.clock.current, 0),
    stamp: stamp(value.timing, pool.clock.current) } }
}

export function legacyMobileSnapshot(derivation: LegacyDerivation, state: MobileWorkState = {}): SidebarSnapshot {
  const split = buildWorkSections(derivation.slice.pinned, derivation.slice.groups)
  const collapsed = new Set(split.sections.filter(section => state.collapsed?.[`podium:sidebar:work-group-fold:${section.key}`]).map(section => section.key))
  const displayed = foldWorkSections(split.sections, collapsed, state.searching === true)
  const project = (section: WorkSection, ordering: boolean) => ({ key: `${ordering ? 'ordering:' : ''}${section.key}`,
    fields: { label: section.label, kind: section.kind, total: section.total,
      snoozedIds: section.snoozedRows.map(row => row.issue.id), closedIds: section.closedRows.map(row => row.issue.id),
      foldKey: `podium:sidebar:work-group-fold:${section.key}`, collapsed: !ordering && !state.searching && collapsed.has(section.key) },
    rows: section.data.map(row => ({ ...legacyRow(row, derivation, derivation.slice.now), id: workRowListKey(row) })),
  })
  return { pending: 0, sections: [
    { key: 'counts', fields: { issueCount: split.issueCount, pinnedCount: split.pinnedCount, attentionCount: split.attentionCount }, rows: [] },
    ...displayed.map(section => project(section, false)), ...split.orderingSections.map(section => project(section, true)),
    { key: 'all-rows', fields: {}, rows: split.orderingSections.flatMap(section => [...section.data, ...section.snoozedRows, ...section.closedRows]).map(row => legacyRow(row, derivation, derivation.slice.now)) },
  ] }
}

export function poolMobileSnapshot(pool: MobxPool, state: MobileWorkState = {}): SidebarSnapshot {
  const split = pool.mobileWork.sections(state)
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

export function checkMobile(pool: MobxPool, derivation: LegacyDerivation, state: MobileWorkState = {}, onDifference?: (difference: SidebarDifference) => void) {
  return compareSidebarSnapshots(legacyMobileSnapshot(derivation, state), poolMobileSnapshot(pool, state), onDifference)
}
