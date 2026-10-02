/** Diagnostic only: compare actual mission-view inputs from one publication.
 * Report locations, counts and opaque IDs; prose never leaves the comparator. */
import type { Store } from '@podium/client-core/engine'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { SessionView } from '@podium/client-core/session-values'
import { allIssueViewModels } from '@podium/client-core/replica'
import {
  archivedSessionsForIssue, buildFlightDeckRows, deckIssueState, deriveHandoffNext,
  deriveHandoffNow, issueContinuation, issueDisplayTitle, issueNote, missionDepartures,
  missionIssueIds, missionProgress, missionRootFor, missionSessions, presenceNote, reposToViews,
  selectedMissionRoot, type FlightDeckMode, type FlightDeckRow, type IssueNavigationModel,
} from '@podium/client-core/viewmodels'
import type { MobxPool } from '../src/pool'
import { missionView, readMissionView, readMissionHandoff, readWorkspaceMission, type MissionViewValues, type MissionHandoffValues } from '../src/mission-view'
import { LOADING } from '../src/worklist/rollup'
import { ISSUE_CONTENT_FIELDS, sessionComparable } from './oracle'
import { compareSidebarSnapshots, type CheckSection, type SidebarCheckResult, type SidebarSnapshot } from './sidebar-check'

const ISSUE_FIELDS = [...ISSUE_CONTENT_FIELDS, 'description', 'notes', 'activityNotes', 'notesUpdatedAt',
  'defaultAgent', 'startedBySession', 'coordinatorSessionId', 'deps', 'childCount', 'childDoneCount',
  'ready', 'deferred', 'memberSessionIds']
const issueFields = (issue: IssueNavigationModel) => Object.fromEntries(ISSUE_FIELDS.map(key => [key, Reflect.get(issue, key) ?? null]))
const noteFields = (note: ReturnType<typeof issueNote>) => note
const continuationFields = (value: ReturnType<typeof issueContinuation>) => value ? { ...value, target: value.target?.id ?? null } : null
const sessionFields = (session: SessionView) => ({ ...sessionComparable(session), model: session.model, effort: session.effort,
  spawnedBy: session.spawnedBy, resumable: session.resumable, refIssueId: session.refIssueId, refLetter: session.refLetter })
const rowFields = (row: FlightDeckRow) => ({
  issue: issueFields(row.issue), depth: row.depth, sessions: row.sessions.map(sessionFields),
  descendantIds: row.descendantIds, matched: row.matched, actionableCount: row.actionableCount,
  liveAgentCount: row.liveAgentCount, workingAgentCount: row.workingAgentCount, waitingAgentCount: row.waitingAgentCount,
  collapsedSummary: { ...row.collapsedSummary, crew: row.collapsedSummary.crew.map(sessionFields) },
})

function snapshot(values: MissionViewValues, handoff: MissionHandoffValues | typeof LOADING): SidebarSnapshot {
  const rows: CheckSection[] = [
    { key: 'mission', fields: { root: values.root?.id ?? null, members: [...values.members].sort(),
      progress: values.progress, continuation: continuationFields(values.continuation), note: noteFields(values.note), presence: values.presence }, rows: [] },
    { key: 'rows', fields: {}, rows: values.rows.map(row => ({ id: row.issue.id, fields: {
      ...rowFields(row), title: values.titles.get(row.issue.id),
      state: values.rowPresentation.get(row.issue.id)?.state,
      note: noteFields(values.rowPresentation.get(row.issue.id)?.note ?? null),
      presence: values.rowPresentation.get(row.issue.id)?.presence,
    } })) },
    { key: 'archived', fields: {}, rows: values.archived.map(session => ({ id: session.sessionId, fields: sessionFields(session) })) },
    { key: 'departures', fields: {}, rows: values.departures.map(value => ({ id: value.issue.id, fields: { issue: issueFields(value.issue), originId: value.originId, state: value.state } })) },
    { key: 'handoff', fields: handoff === LOADING ? {} : {
      crew: handoff.crew.map(sessionFields), current: handoff.current, next: handoff.next,
    }, pendingFields: handoff === LOADING ? ['crew', 'current', 'next'] : [], rows: [] },
  ]
  return { sections: rows, pending: handoff === LOADING ? 1 : 0 }
}

export function legacyMissionViewSnapshot(issues: readonly IssueNavigationModel[], sessions: readonly SessionView[], selectedId: string | null,
  mode: FlightDeckMode = 'full', worktreePaths: string[] = []): SidebarSnapshot {
  const root = selectedMissionRoot(issues, sessions, selectedId)
  const rows = root ? buildFlightDeckRows(issues, sessions, root.id, mode, worktreePaths) : []
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const seen = new Set<string>(), archived: SessionView[] = []
  for (const row of rows) for (const session of archivedSessionsForIssue(row.issue, sessions, worktreePaths)) {
    if (!seen.has(session.sessionId)) { seen.add(session.sessionId); archived.push(session) }
  }
  return snapshot({ root, rows, byId, sessions, archived,
    members: root ? missionIssueIds(issues, root.id, sessions) : new Set(),
    titles: new Map(rows.map(row => [row.issue.id, issueDisplayTitle(row.issue, sessions, worktreePaths)])),
    progress: missionProgress(issues, sessions, root?.id),
    departures: missionDepartures(issues, sessions, root?.id, worktreePaths),
    continuation: root ? issueContinuation(root, byId, sessions) : null,
    note: root ? issueNote(root, byId, sessions) : null,
    presence: root ? presenceNote(root, rows[0]?.sessions ?? [], byId, sessions) : null,
    rowPresentation: new Map(rows.map(row => [row.issue.id, { state: deckIssueState(row.issue, row.sessions, byId),
      note: issueNote(row.issue, byId, row.sessions), presence: presenceNote(row.issue, row.sessions, byId) }])),
  }, root ? { crew: missionSessions(issues, sessions, root.id, true), current: deriveHandoffNow(issues, sessions, root.id),
    next: deriveHandoffNext(issues, sessions, root.id) } : { crew: [], current: [], next: [] })
}

export function poolMissionViewSnapshot(pool: MobxPool, selectedId: string | null, mode: FlightDeckMode = 'full'): SidebarSnapshot | typeof LOADING {
  const reader = missionView(pool), values = readMissionView(reader, selectedId, mode)
  if (values === LOADING) return LOADING
  return snapshot(values, values.root ? readMissionHandoff(reader, values.root.id) : { crew: [], current: [], next: [] })
}

export function checkMissionView(pool: MobxPool, issues: readonly IssueNavigationModel[], sessions: readonly SessionView[], selectedId: string | null,
  mode: FlightDeckMode = 'full', worktreePaths: string[] = []): SidebarCheckResult {
  const actual = poolMissionViewSnapshot(pool, selectedId, mode)
  if (actual === LOADING) return { differences: 0, first: null, pending: 1, sections: 0, rows: 0 }
  return compareSidebarSnapshots(legacyMissionViewSnapshot(issues, sessions, selectedId, mode, worktreePaths), actual)
}

/** Store-facing entry matches POD-4954. Both sides share overlays and clock. */
export function checkMissionViewFromStore(pool: MobxPool, store: Store<PodiumClientApi>, selectedId = store.selectedIssueId, mode: FlightDeckMode = 'full'): SidebarCheckResult {
  const models = allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates)
  const worktreePaths = reposToViews(store.repos).flatMap(repo => repo.worktrees.map(worktree => worktree.path))
  return checkMissionView(pool, models, store.sessions, selectedId, mode, worktreePaths)
}

/** Enclosing workspace selection, including a focused task within the mission. */
export function checkWorkspaceMission(pool: MobxPool, issues: readonly IssueNavigationModel[], sessions: readonly SessionView[], selectedId: string | null, focusedId: string | null): SidebarCheckResult {
  const actual = readWorkspaceMission(missionView(pool), selectedId, focusedId)
  if (actual === LOADING) return { differences: 0, first: null, pending: 1, sections: 0, rows: 0 }
  const selected = issues.find(issue => issue.id === selectedId && !issue.archived && !issue.deletedAt)
  const root = selected ? selectedMissionRoot(issues, sessions, selectedId) : undefined
  // An empty draft is selected in Workspace but has no mission drawn yet.
  const rawRootId = selected ? missionRootFor(issues, selected.id)?.id : undefined
  const rawRoot = issues.find(issue => issue.id === rawRootId)
  const ids = rawRoot ? missionIssueIds(issues, rawRoot.id, sessions) : new Set<string>()
  const focused = focusedId && ids.has(focusedId) ? issues.find(issue => issue.id === focusedId) : undefined
  const fields = (missionRoot: IssueNavigationModel | undefined, memberIds: ReadonlySet<string>, memberIssues: readonly IssueNavigationModel[], issue: IssueNavigationModel | undefined,
    missionOnScreen: IssueNavigationModel | undefined, hasAnyTask: boolean): SidebarSnapshot => ({ pending: 0, sections: [{ key: 'workspace', rows: [], fields: {
      missionRoot: missionRoot?.id, missionIds: [...memberIds].sort(), missionIssues: memberIssues.map(issue => issue.id),
      issue: issue?.id, missionOnScreen: missionOnScreen?.id, hasAnyTask,
    } }] })
  return compareSidebarSnapshots(fields(rawRoot, ids, issues.filter(issue => ids.has(issue.id)), focused ?? rawRoot, root ?? undefined, issues.some(issue => !issue.deletedAt)),
    fields(actual.missionRoot, actual.missionIds, actual.missionIssues, actual.issue, actual.missionOnScreen, actual.hasAnyTask))
}
