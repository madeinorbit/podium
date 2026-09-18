/** Isolated proof: no application entry imports this directory. */
import type { SessionMeta } from '@podium/model'
import type { IssueNavigationModel } from '../../src/viewmodels/slices/issues'
import { missionRollup } from '../../src/viewmodels/mission'
import { nestStartedByIssues } from '../../src/viewmodels/slices/worklist/rows'
import { sortUnifiedWorkRows, unifiedRowBand } from '../../src/viewmodels/slices/worklist/row-order'
import type { UnifiedIssueRow } from '../../src/viewmodels/slices/worklist/row-types'
export const NOW = Date.parse('2026-09-18T12:00:00Z')
export const GROUP = 200
export type Session = SessionMeta
export type Issue = IssueNavigationModel
export const counters = () => ({ summary: 0, sessionVisits: 0, childVisits: 0, mission: 0, nesting: 0, rank: 0, nativeOutputChanges: 0 })
export type Counts = ReturnType<typeof counters>
export function fixture(scale: 'live' | 'growth' = 'live') {
  // A3 live/growth cardinalities and wire shapes, enriched with families and phases.
  const m = scale === 'live' ? 1 : 2
  const issues = Array.from({ length: 4867 * m }, (_, n) => ({
    id: `i${n}`, seq: n + 1, repoPath: `/repo-${n % (500 * m)}`, title: `Issue ${n}`,
    stage: n % 5 === 4 ? 'done' : 'in_progress', parentId: n % 5 ? `i${n - n % 5}` : undefined,
    createdAt: '2026-09-18T10:00:00Z', updatedAt: '2026-09-18T10:00:00Z',
    readAt: '2026-09-18T11:00:00Z', pinned: n === 10,
    deferUntil: n === 0 ? new Date(NOW + 60_000).toISOString() : undefined,
    origin: 'human', audience: 'human', draft: false, archived: false,
    labels: [], deps: [], dependents: [], comments: [], blockedByNotes: [],
    childCount: n % 5 ? 0 : 4, childDoneCount: n % 5 ? 0 : 1,
    priority: 2, type: 'task', ready: true, blocked: false, deferred: false, needsHuman: false,
  } as unknown as Issue))
  const sessions = Array.from({ length: 4304 * m }, (_, n) => ({
    sessionId: `s${n}`, issueId: `i${n}`, agentKind: 'codex', cwd: `/repo-${n % (500 * m)}`,
    title: `Session ${n}`, status: 'live', controllerId: `c${n}`, geometry: { cols: 80, rows: 24 },
    epoch: 1, clientCount: 1, createdAt: '2026-09-18T10:00:00Z', lastActiveAt: '2026-09-18T10:00:00Z',
    origin: { kind: 'spawn' }, archived: false, readAt: '2026-09-18T11:00:00Z', unread: false,
    agentState: { phase: ['working', 'needs_user', 'done'][n % 3], since: '2026-09-18T10:00:00Z' },
  } as unknown as Session))
  return { issues, sessions }
}
export type Fixture = ReturnType<typeof fixture>
export function summaryJS(issue: Issue, sessions: Session[], children: Issue[], c: Counts) {
  c.summary++
  const phases: Record<string, number> = {}
  let latest = '', childDone = 0
  for (const s of sessions) {
    c.sessionVisits++
    const phase = s.agentState?.phase ?? 'unknown'
    phases[phase] = (phases[phase] ?? 0) + 1
    if (s.lastActiveAt > latest) latest = s.lastActiveAt
  }
  for (const child of children) { c.childVisits++; childDone += Number(child.stage === 'done') }
  return { phases, latest, unread: latest > (issue.readAt ?? ''), childDone }
}
export function worklistJS(issues: Issue[], sessions: Session[], now: number, c: Counts) {
  // Exact existing arbitrary rules, separately counted from native relational work.
  const rows: UnifiedIssueRow[] = issues.map(issue => {
    c.mission++
    const mine = sessions.filter(s => { c.sessionVisits++; return s.issueId === issue.id })
    return { kind: 'issue', issue, sessions: mine,
      activityAt: mine.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt)), 0),
      missionRollup: missionRollup(issues, sessions, issue.id) }
  })
  c.nesting++
  return sortUnifiedWorkRows(nestStartedByIssues(rows, sessions, [], issues), now)
}
export function band(issue: Issue, now: number, c: Counts) {
  c.rank++
  return unifiedRowBand({ kind: 'issue', issue, sessions: [], activityAt: 0 }, now)
}
