import { isFinished } from '@podium/client-graph/shared/predicates'
/** Diagnostic only: compare actual mission-view inputs from one publication.
 * Report locations, counts and opaque IDs; prose never leaves the comparator. */
import type { ReferenceState as Store } from './reference-state'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId } from '@podium/model/browser'

import { allIssueViewModels } from './reference/issue-view-models'
import {
  archivedSessionsForIssue, buildFlightDeckRows, deckIssueState, deriveHandoffNext,
  deriveHandoffNow, issueContinuation, issueDisplayTitle, issueNote, missionDepartures,
  missionIssueIds, missionProgress, missionRootFor, missionSessions, presenceNote, reposToViews,
  selectedMissionRoot, selectLatestPromptSession, type FlightDeckMode, type FlightDeckRow, type IssueNavigationModel,
} from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import { EMPTY_MISSION_HANDOFF, missionView, readMissionView, readMissionHandoff, readWorkspaceMission, type MissionViewValues, type MissionHandoffValues } from '@podium/client-graph/mission-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { ISSUE_CONTENT_FIELDS, sessionComparable } from './oracle'
import { compareSidebarSnapshots, type CheckSection, type SidebarCheckResult, type SidebarSnapshot, type SidebarDifference } from './sidebar-check'

const ISSUE_FIELDS = [...ISSUE_CONTENT_FIELDS, 'description', 'notes', 'activityNotes', 'notesUpdatedAt',
  'defaultAgent', 'startedBySession', 'coordinatorSessionId', 'deps', 'childCount', 'childDoneCount',
  'ready', 'deferred', 'memberSessionIds']
const issueFields = (issue: IssueNavigationModel) => Object.fromEntries(ISSUE_FIELDS.map(key => [key, Reflect.get(issue, key) ?? null]))
const legacyMaps = new WeakMap<readonly IssueNavigationModel[], Map<string, IssueNavigationModel>>()
function legacyMap(issues: readonly IssueNavigationModel[]) {
  let map = legacyMaps.get(issues)
  if (!map) { map = new Map(issues.map(issue => [issue.id, issue])); legacyMaps.set(issues, map) }
  return map
}
const deadlineExpectations = new WeakMap<readonly IssueNavigationModel[], { now: number; issues: readonly IssueNavigationModel[] }>()
/** POD-4286's accepted exception: the new screen refreshes at the deadline.
 * Legacy cached flags refresh only on a row change. Adjust those two flags,
 * and the presentation derived from them, for finite deferral deadlines only. */
function acceptedDeadlineIssues(issues: readonly IssueNavigationModel[], now: number): readonly IssueNavigationModel[] {
  const cached = deadlineExpectations.get(issues)
  if (cached?.now === now) return cached.issues
  let changed = false
  const expected = issues.map(issue => {
    const deadline = issue.deferUntil ? Date.parse(issue.deferUntil) : NaN
    if (!Number.isFinite(deadline)) return issue
    const deferred = deadline > now
    const ready = !issue.blocked && !deferred && !isFinished(issue)
    if (issue.deferred === deferred && issue.ready === ready) return issue
    changed = true
    return { ...issue, deferred, ready }
  })
  const result = changed ? expected : issues
  deadlineExpectations.set(issues, { now, issues: result })
  return result
}
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

function snapshot(values: Omit<MissionViewValues, 'archivedCount'>, archived: readonly SessionView[], handoff: MissionHandoffValues | typeof LOADING): SidebarSnapshot {
  const rows: CheckSection[] = [
    { key: 'mission', fields: { root: values.root?.id ?? null, members: [...values.members].sort(),
      progress: values.progress, continuation: continuationFields(values.continuation), note: noteFields(values.note), presence: values.presence }, rows: [] },
    { key: 'rows', fields: {}, rows: values.rows.map(row => ({ id: row.issue.id, fields: {
      ...rowFields(row), title: values.titles.get(row.issue.id),
      state: values.rowPresentation.get(row.issue.id)?.state,
      note: noteFields(values.rowPresentation.get(row.issue.id)?.note ?? null),
      presence: values.rowPresentation.get(row.issue.id)?.presence,
    } })) },
    { key: 'archived', fields: {}, rows: archived.map(session => ({ id: session.sessionId, fields: sessionFields(session) })) },
    { key: 'departures', fields: {}, rows: values.departures.map(value => ({ id: value.issue.id, fields: { issue: issueFields(value.issue), originId: value.originId, state: value.state } })) },
    { key: 'handoff', fields: handoff === LOADING ? {} : {
      crew: handoff.crew.map(sessionFields), current: handoff.current, next: handoff.next,
      retired: { count: handoff.retired.count, latestPrompt: handoff.retired.latestPrompt?.sessionId ?? null },
    }, pendingFields: handoff === LOADING ? ['crew', 'retired', 'current', 'next'] : [], rows: [] },
  ]
  return { sections: rows, pending: handoff === LOADING ? 1 : 0 }
}

export function legacyMissionViewSnapshot(issues: readonly IssueNavigationModel[], sessions: readonly SessionView[], selectedId: string | null,
  mode: FlightDeckMode = 'full', worktreePaths: string[] = []): SidebarSnapshot {
  const root = selectedMissionRoot(issues, sessions, selectedId ? asIssueId(selectedId) : null)
  const rows = root ? buildFlightDeckRows(issues, sessions, root.id, mode, worktreePaths) : []
  const byId = legacyMap(issues)
  const seen = new Set<string>(), archived: SessionView[] = []
  for (const row of rows) for (const session of archivedSessionsForIssue(row.issue, sessions as SessionView[], worktreePaths)) {
    if (!seen.has(session.sessionId)) { seen.add(session.sessionId); archived.push(session) }
  }
  return snapshot({ root, rows, issueIds: issues.map(issue => issue.id), sessions,
    members: root ? missionIssueIds(issues, root.id, sessions) : new Set(),
    titles: new Map(rows.map(row => [row.issue.id, issueDisplayTitle(row.issue, sessions, worktreePaths)])),
    progress: missionProgress(issues, sessions, root?.id),
    departures: missionDepartures(issues, sessions, root?.id, worktreePaths),
    continuation: root ? issueContinuation(root, byId, sessions) : null,
    note: root ? issueNote(root, byId, sessions) : null,
    presence: root ? presenceNote(root, rows[0]?.sessions ?? [], byId, sessions) : null,
    rowPresentation: new Map(rows.map(row => [row.issue.id, { state: deckIssueState(row.issue, row.sessions, byId),
      note: issueNote(row.issue, byId, row.sessions), presence: presenceNote(row.issue, row.sessions, byId) }])),
  }, archived, root ? legacyHandoff(issues, sessions, root.id) : EMPTY_MISSION_HANDOFF)
}

/** The legacy handoff in the pane's contract: the seated crew, and the
 * archived senders as a count and their latest prompt. */
function legacyHandoff(issues: readonly IssueNavigationModel[], sessions: readonly SessionView[], rootId: string): MissionHandoffValues {
  const all = missionSessions(issues, sessions, rootId, true), archived = all.filter(session => session.archived)
  return { crew: all.filter(session => !session.archived), retired: { count: archived.length, latestPrompt: selectLatestPromptSession(archived) },
    current: deriveHandoffNow(issues, sessions, rootId), next: deriveHandoffNext(issues, sessions, rootId) }
}

export function poolMissionViewSnapshot(pool: MobxPool, selectedId: string | null, mode: FlightDeckMode = 'full'): SidebarSnapshot | typeof LOADING {
  try {
  const reader = missionView(pool), values = readMissionView(reader, selectedId, mode)
  if (values === LOADING) return LOADING
  // The deck reads its count from the pane and the list only while shown;
  // compare the list the expanded section draws, and that the count agrees.
  const archived = values.root ? reader.archive(values.root.id, mode) : []
  if (archived === LOADING) return LOADING
  if (archived.length !== values.archivedCount) throw new Error(`Archived count ${values.archivedCount} disagrees with its list (${archived.length})`)
  return snapshot(values, archived, values.root ? readMissionHandoff(reader, values.root.id) : EMPTY_MISSION_HANDOFF)
  } catch (error) { if (error === LOADING) return LOADING; throw error }
}

export function checkMissionView(pool: MobxPool, issues: readonly IssueNavigationModel[], sessions: readonly SessionView[], selectedId: string | null,
  mode: FlightDeckMode = 'full', worktreePaths: string[] = [], onDifference?: (difference: SidebarDifference) => void): SidebarCheckResult {
  const actual = poolMissionViewSnapshot(pool, selectedId, mode)
  if (actual === LOADING) return { differences: 0, first: null, pending: 1, sections: 0, rows: 0 }
  const expectedIssues = acceptedDeadlineIssues(issues, pool.clock.current)
  return compareSidebarSnapshots(legacyMissionViewSnapshot(expectedIssues, sessions, selectedId, mode, worktreePaths), actual, onDifference)
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
  const root = selected ? selectedMissionRoot(issues, sessions, selectedId ? asIssueId(selectedId) : null) : undefined
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
