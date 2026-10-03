/** Diagnostic only. Both phone paths spend one publication and clock; reports
 * contain counts, positions and opaque IDs, never the compared row values. */
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  buildFlightDeckRows,
  confirmedWorkingAgentCountsByIssue,
  deckIssueState,
  type FlightDeckMode,
  type FlightDeckRow,
  isSessionWorking,
  issueContinuation,
  issueNote,
  missionDepartures,
  missionProgress,
  missionRootFor,
  missionSessions,
  presenceNote,
  sessionNeedsHuman,
  taskStateWord,
} from '@podium/client-core/viewmodels'
import { asIssueId } from '@podium/model/browser'
import { autorun, reaction } from 'mobx'
import type { MissionViewValues } from '../src/mission-view'
import type {
  MobileMissionData,
  MobileTasksData,
  MobileTasksOptions,
} from '../src/mobile-screens-schema'
import type { MobxPool } from '../src/pool'
import { LOADING } from '../src/worklist/rollup'
import { sessionComparable } from './oracle'
import {
  compareSidebarSnapshots,
  type SidebarCheckResult,
  type SidebarSnapshot,
} from './sidebar-check'

export interface MobileScreenCheck {
  /** Supplied by the actual phone modules, never a copied legacy oracle. */
  legacy: MobileLegacyReads
  tasks: MobileTasksOptions
  selectedId: string | null
  mode: FlightDeckMode
  requestedSessionId?: string
  worktreePaths?: string[]
}
export interface MobileLegacyReads {
  taskBoardSections(issues: IssueViewModel[], options: Omit<MobileTasksOptions, 'expanded'> & { expanded: ReadonlySet<string> }): MobileTasksData['board']
  taskBoardProgress(issues: readonly IssueViewModel[], sections: MobileTasksData['board'], working: ReadonlyMap<string, number>): MobileTasksData['progressByIssue']
  buildScreeningQueue(issues: IssueViewModel[]): IssueViewModel[]
  mostRelevantSession(sessions: readonly SessionView[]): SessionView | undefined
}
/** Keep MobX and the pool test arm's native list out of the phone test package. */
export function trackMobileScreenRead<T>(read: () => T): T {
  let value!: T
  let failure: { error: unknown } | undefined
  const stop = autorun(() => {
    try { value = read() } catch (error) { failure = { error } }
  })
  stop()
  if (failure) throw failure.error
  return value
}
export function observeMobileScreens(pool: MobxPool, input: MobileScreenCheck): () => void {
  return reaction(() => poolMobileScreensSnapshot(pool, input), () => {}, { fireImmediately: true })
}
const fields = (value: object, keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key) ?? null]))
const BOARD_FIELDS = [
  'seq',
  'title',
  'stage',
  'priority',
  'type',
  'parentId',
  'repoPath',
  'color',
  'linearIdentifier',
  'archived',
  'deletedAt',
  'pinned',
  'assignee',
  'labels',
  'estimateMin',
]
const MISSION_FIELDS = [
  ...BOARD_FIELDS,
  'description',
  'notes',
  'activityNotes',
  'asked',
  'needsHuman',
  'closedReason',
  'defaultAgent',
  'startedBySession',
  'coordinatorSessionId',
  'deps',
  'childCount',
  'childDoneCount',
  'memberSessionIds',
  'readAt',
  'unread',
  'tuckedAt',
]
const seat = (session: SessionView) => ({
  ...sessionComparable(session),
  ...fields(session, [
    'model',
    'observedModel',
    'effort',
    'spawnedBy',
    'resumable',
    'refIssueId',
    'refLetter',
    'machineId',
  ]),
})
const continuation = (value: MissionViewValues['continuation']) =>
  value
    ? {
        ...value,
        target: value.target
          ? { id: value.target.id, ...fields(value.target, BOARD_FIELDS) }
          : null,
      }
    : null
const flight = (row: FlightDeckRow) => ({
  issue: fields(row.issue, MISSION_FIELDS),
  depth: row.depth,
  sessions: row.sessions.map(seat),
  descendantIds: row.descendantIds,
  matched: row.matched,
  actionableCount: row.actionableCount,
  liveAgentCount: row.liveAgentCount,
  workingAgentCount: row.workingAgentCount,
  waitingAgentCount: row.waitingAgentCount,
  collapsedSummary: { ...row.collapsedSummary, crew: row.collapsedSummary.crew.map(seat) },
})
function snapshot(
  tasks: MobileTasksData,
  mission: MobileMissionData,
  deck: MissionViewValues,
  legacy: MobileLegacyReads,
  requested?: string,
): SidebarSnapshot {
  const automatic = legacy.mostRelevantSession(mission.missionSessions)
  const current =
    mission.missionSessions.find((session) => session.sessionId === requested) ?? automatic
  const header = mission.issues.find((issue) => issue.id === current?.issueId) ?? mission.root
  return {
    pending: 0,
    sections: [
      { key: 'tasks', fields: { proposals: tasks.proposals }, rows: [] },
      ...tasks.board.map((section) => ({
        key: `tasks:${section.stage}`,
        fields: {
          title: section.title,
          total: section.rows.filter((row) => row.depth === 0).length,
        },
        rows: section.rows.map((row) => ({
          id: row.issue.id,
          fields: {
            issue: fields(row.issue, BOARD_FIELDS),
            depth: row.depth,
            childCount: row.childCount,
            expanded: row.expanded,
            parent: row.issue.parentId
              ? (tasks.issues.find((issue) => issue.id === row.issue.parentId)?.title ?? null)
              : null,
            working: tasks.workingByIssue.get(row.issue.id) ?? 0,
            progress: tasks.progressByIssue.get(row.issue.id) ?? null,
            state: taskStateWord(
              row.issue,
              tasks.workingByIssue.get(row.issue.id) ?? 0,
              tasks.progressByIssue.get(row.issue.id) ?? null,
            ),
          },
        })),
      })),
      {
        key: 'mission',
        fields: {
          root: mission.root?.id ?? null,
          header: header ? { id: header.id, ...fields(header, MISSION_FIELDS) } : null,
          current: current?.sessionId ?? null,
          progress: mission.progress,
          attention: mission.missionSessions.filter(sessionNeedsHuman).length,
          live: mission.missionSessions.filter(
            (session) => !session.archived && session.status !== 'exited',
          ).length,
          working: mission.missionSessions.filter(isSessionWorking).length,
        },
        rows: mission.missionSessions.map((session) => ({
          id: session.sessionId,
          fields: seat(session),
        })),
      },
      {
        key: 'details',
        fields: {
          root: deck.root?.id ?? null,
          progress: deck.progress,
          continuation: continuation(deck.continuation),
          presence: deck.presence,
        },
        rows: deck.rows.map((row) => ({
          id: row.issue.id,
          fields: {
            ...flight(row),
            ...deck.rowPresentation.get(row.issue.id),
            author: row.issue.startedBySession
              ? (mission.sessions.find(
                  (session) => session.sessionId === row.issue.startedBySession,
                )?.displayRef ?? null)
              : null,
          },
        })),
      },
      {
        key: 'departures',
        fields: {},
        rows: deck.departures.map((value) => ({
          id: value.issue.id,
          fields: {
            issue: fields(value.issue, BOARD_FIELDS),
            originId: value.originId,
            state: value.state,
          },
        })),
      },
    ],
  }
}
/** The accepted deadline refresh from the existing mission check applies here
 * too: only the two cached flags refresh when a finite deferral expires. */
function deadlineIssues(issues: IssueViewModel[], now: number) {
  return issues.map((issue) => {
    const deadline = issue.deferUntil ? Date.parse(issue.deferUntil) : NaN
    if (!Number.isFinite(deadline)) return issue
    const deferred = deadline > now,
      ready = !issue.blocked && !deferred && issue.stage !== 'done'
    return issue.deferred === deferred && issue.ready === ready
      ? issue
      : { ...issue, deferred, ready }
  })
}
export function legacyMobileScreensSnapshot(
  issues: IssueViewModel[],
  sessions: SessionView[],
  input: MobileScreenCheck,
  now: number,
): SidebarSnapshot {
  const { taskBoardSections, taskBoardProgress, buildScreeningQueue } = input.legacy
  issues = deadlineIssues(issues, now)
  const board = taskBoardSections(issues, {
    ...input.tasks,
    expanded: new Set(input.tasks.expanded),
  })
  const workingByIssue = confirmedWorkingAgentCountsByIssue(issues, sessions, now)
  const root = input.selectedId ? missionRootFor(issues, asIssueId(input.selectedId)) : undefined
  const paths = input.worktreePaths ?? []
  const rows = root ? buildFlightDeckRows(issues, sessions, root.id, input.mode, paths) : []
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const progress = missionProgress(issues, sessions, root?.id)
  const rootRow = rows.find((row) => row.issue.id === root?.id)
  return snapshot(
    {
      issues,
      sessions,
      board,
      workingByIssue,
      progressByIssue: taskBoardProgress(issues, board, workingByIssue),
      proposals: buildScreeningQueue(issues).length,
    },
    {
      root,
      issues,
      sessions,
      missionSessions: root ? missionSessions(issues, sessions, root.id) : [],
      progress,
    },
    {
      root,
      rows,
      byId,
      sessions,
      progress,
      members: new Set(),
      titles: new Map(),
      archived: [],
      continuation: root ? issueContinuation(root, byId, sessions) : null,
      note: null,
      presence: rootRow ? presenceNote(rootRow.issue, rootRow.sessions, byId, sessions) : null,
      departures: root ? missionDepartures(issues, sessions, root.id, paths) : [],
      rowPresentation: new Map(
        rows.map((row) => [
          row.issue.id,
          {
            state: deckIssueState(row.issue, row.sessions, byId),
            note: issueNote(row.issue, byId, row.sessions),
            presence: presenceNote(row.issue, row.sessions, byId),
          },
        ]),
      ),
    },
    input.legacy,
    input.requestedSessionId,
  )
}
export function poolMobileScreensSnapshot(
  pool: MobxPool,
  input: MobileScreenCheck,
): SidebarSnapshot | typeof LOADING {
  const reader = pool.row('mobileScreenReader', 'reader')
  if (!reader || reader === LOADING) return LOADING
  const tasks = reader.tasks(input.tasks),
    mission = reader.mission(input.selectedId),
    deck = reader.deck(input.selectedId, input.mode)
  if (tasks === LOADING || mission === LOADING || deck === LOADING) return LOADING
  return snapshot(tasks, mission, deck, input.legacy, input.requestedSessionId)
}
export function checkMobileScreens(
  pool: MobxPool,
  issues: IssueViewModel[],
  sessions: SessionView[],
  input: MobileScreenCheck,
): SidebarCheckResult {
  const actual = poolMobileScreensSnapshot(pool, input)
  if (actual === LOADING) return { differences: 0, first: null, pending: 1, sections: 0, rows: 0 }
  return compareSidebarSnapshots(
    legacyMobileScreensSnapshot(issues, sessions, input, pool.clock.current),
    actual,
  )
}
