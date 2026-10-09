import { omitGone } from '@podium/client-graph/lookup'
import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
/** Pool-only regression output frozen by the accepted phone parity controls. */
import type { SessionView } from '@podium/client-core/session-values'
import {
  type FlightDeckMode,
  type FlightDeckRow,
  isSessionWorking,
  sessionNeedsHuman,
  taskStateWord,
} from '@podium/client-core/values'
import { autorun, reaction } from 'mobx'
import type { IssueViewModel } from '@podium/client-core/replica'
import { MissionScreen, missionRootId } from '@podium/client-graph/mission-screen'
import { type MissionRowPresentation, requireLoaded, settled } from '@podium/client-graph/mission-view'
import type { MobileTasksOptions } from '@podium/client-graph/mobile-screens-schema'
import { EMPTY_MOBILE_TASKS, readMobileTaskSnapshot, type MobileTasksData } from './mobile-task-snapshot'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { sessionComparable } from './oracle'
import {
  type SidebarSnapshot,
} from './sidebar-check'

export interface MobileScreenInput {
  selectSession(sessions: readonly SessionView[]): SessionView | undefined
  /** Tasks do not depend on mission selection; null skips a repeated check. */
  tasks: MobileTasksOptions | null
  selectedId: string | null
  mode: FlightDeckMode
  requestedSessionId?: string
}
/** Keep MobX and the pool test arm's native list out of the phone test package. */
export function trackMobileScreenRead<T>(read: () => T): T {
  let value!: T
  let failure: { error: unknown } | undefined
  const stop = autorun(() => {
    try {
      value = read()
    } catch (error) {
      failure = { error }
    }
  })
  stop()
  if (failure) throw failure.error
  return value
}
export function observeMobileScreens(pool: MobxPool, input: MobileScreenInput): () => void {
  return reaction(
    () => poolMobileScreensSnapshot(pool, input),
    () => {},
    { fireImmediately: true },
  )
}
const fields = (value: object, keys: readonly string[]) =>
  Object.fromEntries(
    keys.map((key) => [key, Reflect.get(value, key) ?? (key === 'labels' ? [] : null)]),
  )
const BOARD_FIELDS = [
  'seq',
  'displayRef',
  'prefix',
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
const continuation = (value: MissionScreen['continuation']) =>
  value
    ? {
        ...value,
        target: value.target
          ? { id: value.target.id, ...fields(value.target, BOARD_FIELDS) }
          : null,
      }
    : null
const flight = (row: FlightDeckRow, mode: FlightDeckMode) => ({
  issue: fields(row.issue, MISSION_FIELDS),
  depth: row.depth,
  sessions: row.sessions.map(seat),
  descendantIds: row.descendantIds,
  matched: mode === 'full' || row.matched,
  actionableCount: row.actionableCount,
  liveAgentCount: row.liveAgentCount,
  workingAgentCount: row.workingAgentCount,
  waitingAgentCount: row.waitingAgentCount,
  collapsedSummary: { ...row.collapsedSummary, crew: row.collapsedSummary.crew.map(seat) },
})
/** What the phone's mission routes read from one opening. */
interface PhoneMission {
  root: IssueViewModel | undefined
  missionSessions: SessionView[]
  progress: MissionScreen['progress']
  header(issueId: string | undefined): IssueViewModel | undefined
  author(row: FlightDeckRow): string | null
}
interface PhoneDeck {
  root: IssueViewModel | undefined
  progress: MissionScreen['progress']
  continuation: MissionScreen['continuation']
  presence: MissionScreen['presence']
  rows: readonly FlightDeckRow[]
  rowPresentation: ReadonlyMap<string, MissionRowPresentation>
  departures: MissionScreen['departures']
}
const NO_PROGRESS = { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }
const NO_MISSION: PhoneMission = { root: undefined, missionSessions: [], progress: NO_PROGRESS, header: () => undefined, author: () => null }
const NO_DECK: PhoneDeck = { root: undefined, progress: NO_PROGRESS, continuation: null, presence: null, rows: [], rowPresentation: new Map(), departures: [] }
const openings = new WeakMap<MobxPool, Map<string, MissionScreen>>()
/** One opening per mission root, as the phone route's root component creates it. */
function opening(pool: MobxPool, rootId: string): MissionScreen {
  attachMissionTestPreferences(pool)
  let byRoot = openings.get(pool)
  if (!byRoot) openings.set(pool, (byRoot = new Map()))
  let screen = byRoot.get(rootId)
  if (!screen) byRoot.set(rootId, (screen = new MissionScreen(pool, rootId)))
  return screen
}
function phoneMission(pool: MobxPool, selectedId: string | null, mode: FlightDeckMode): [PhoneMission, PhoneDeck] | typeof LOADING {
  const rootId = missionRootId(pool, selectedId, true)
  if (rootId === LOADING) return LOADING
  if (!rootId) return [NO_MISSION, NO_DECK]
  const screen = opening(pool, rootId), reader = screen.reader, deck = reader.deck(rootId, mode)
  if (!screen.ready || [deck.topology, deck.progress, deck.archivedCount, deck.headerReady, settled(() => deck.rowIds())].includes(LOADING)) return LOADING
  const root = requireLoaded(reader.issue(rootId)) as IssueViewModel | undefined
  const rows = deck.rows()
  return [{
    root,
    missionSessions: screen.crew as unknown as SessionView[],
    progress: screen.progress,
    header(issueId) {
      const issue = issueId && screen.members.has(issueId) ? reader.issue(issueId) : undefined
      return issue && issue !== LOADING ? (issue as IssueViewModel) : root
    },
    author: (row) => screen.proposalAuthor(deck.model(row.issue.id)),
  }, {
    root,
    progress: screen.progress,
    continuation: deck.continuation,
    presence: rows.some((row) => row.id === rootId) ? deck.presence : null,
    rows,
    rowPresentation: new Map(rows.map((row) => [row.id, deck.model(row.id).presentation])),
    departures: deck.departures,
  }]
}

function snapshot(
  tasks: MobileTasksData,
  mission: PhoneMission,
  deck: PhoneDeck,
  selectSession: MobileScreenInput['selectSession'],
  requested?: string,
  mode: FlightDeckMode = 'full',
): SidebarSnapshot {
  const automatic = selectSession(mission.missionSessions)
  const current =
    mission.missionSessions.find((session) => session.sessionId === requested) ?? automatic
  const header = mission.header(current?.issueId)
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
            ...flight(row, mode),
            ...deck.rowPresentation.get(row.issue.id),
            author: row.issue.startedBySession ? mission.author(row) : null,
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
export function poolMobileScreensSnapshot(
  pool: MobxPool,
  input: MobileScreenInput,
): SidebarSnapshot | typeof LOADING {
  const reader = omitGone(pool.row('mobileScreenReader', 'reader'))
  if (!reader || reader === LOADING) return LOADING
  const tasks = input.tasks ? readMobileTaskSnapshot(pool, input.tasks) : EMPTY_MOBILE_TASKS
  try {
    const opened = phoneMission(pool, input.selectedId, input.mode)
    if (tasks === LOADING || opened === LOADING) return LOADING
    return snapshot(tasks, opened[0], opened[1], input.selectSession, input.requestedSessionId, input.mode)
  } catch (error) {
    if (error === LOADING) return LOADING
    throw error
  }
}
