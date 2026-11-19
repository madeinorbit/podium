/** Stateless record oracle. No client-graph runtime reads participate in expected answers. */
import {
  buildFlightDeckRows,
  confirmedWorkingAgentCountsByIssue,
  type FlightDeckRow,
  filterBoardIssues,
  filterBoardScope,
  type IssueNavigationModel,
  isSessionWorking,
  issueNeedsHuman,
  isVacatedOrigin,
  missionDepartures,
  missionRootFor,
  missionSessions,
  missionTaskBucket,
  orderIssues,
  reposToViews,
  sessionAsksOnIssue,
  sessionNeedsHuman,
  sessionsForIssueNav,
  tallyMissionBuckets,
  taskProgressMap,
  taskStateWord,
} from '@podium/client-core/values'
import { asIssueId, dedupeSessionsByResume, isFinished } from '@podium/model'
import {
  coordinatedSeat,
  coordinatorLive,
  leafTasks,
  sessionWorkingFact,
} from '@podium/model/browser'
import { expect } from 'vitest'
import type { MobileScreenInput } from './mobile-screens-snapshot'
import { allIssueViewModels } from './reference/issue-view-models'
import type { ReferenceState } from './reference-state'
import type { SidebarSnapshot } from './sidebar-check'

const FIELDS = [
  'seq',
  'displayRef',
  'prefix',
  'title',
  'stage',
  'priority',
  'type',
  'parentId',
  'repoPath',
  'archived',
  'deletedAt',
  'pinned',
  'assignee',
  'labels',
  'estimateMin',
]
const fields = (issue: object, mission = false) =>
  Object.fromEntries(
    FIELDS.filter((key) => !mission || key !== 'pinned').map((key) => [
      key,
      Reflect.get(issue, key) ?? (key === 'labels' ? [] : null),
    ]),
  )
const STAGES = ['in_progress', 'review', 'planning', 'backlog', 'proposed', 'done']
type Issue = IssueNavigationModel

// Each reference publication is immutable during one compare. Reuse its flat
// derivation across the same corpus roots and modes, then discard it with that
// publication; rebuilding it for every opening adds no independent evidence.
const publications = new WeakMap<ReferenceState, Issue[]>()
const decks = new WeakMap<ReferenceState, Map<string, FlightDeckRow[]>>()
function referenceIssues(source: ReferenceState): Issue[] {
  let issues = publications.get(source)
  if (!issues) {
    issues = allIssueViewModels(
      source.replica,
      source.issueProjections,
      source.issueUserStates,
    ) as Issue[]
    publications.set(source, issues)
  }
  return issues
}

/** A hidden mission may still contain accepted visible work. Count that work
 * from its formal records rather than dropping the meter with its root. */
function referenceProgress(issues: Issue[], sessions: ReferenceState['sessions'], rootId?: string) {
  const byId = new Map(issues.map((issue) => [issue.id as string, issue]))
  const visible = (issue: Issue) => !issue.archived && !issue.deletedAt
  const children = new Map<string, string[]>()
  for (const issue of issues) {
    if (!issue.parentId || !visible(issue) || issue.stage === 'proposed') continue
    const siblings = children.get(issue.parentId) ?? []
    siblings.push(issue.id)
    children.set(issue.parentId, siblings)
  }
  const leaves =
    rootId && byId.has(rootId)
      ? leafTasks(rootId, { task: (id) => byId.get(id), children: (id) => children.get(id) ?? [] })
      : []
  return tallyMissionBuckets(leaves, (id) => {
    const issue = byId.get(id)!
    const own = sessions.filter((session) => session.issueId === id)
    if (!visible(issue) || isVacatedOrigin(issue, own, byId)) return null
    const members = sessionsForIssueNav(issue, sessions, [], { includeShells: true })
    return missionTaskBucket(
      issue,
      own.length > 0 ||
        Boolean(issue.memberSessionIds?.length) ||
        sessions.some((session) => session.refIssueId === id),
      [...own, ...members].some((session) => !session.archived && sessionWorkingFact(session)),
    )
  })
}

/** Delegate requests stay with their live coordinator; only delegate exceptions
 * reach a coordinated ancestor. Derive that role policy from source records. */
function referenceDeck(
  source: ReferenceState,
  issues: Issue[],
  sessions: ReferenceState['sessions'],
  rootId: string,
  mode: MobileScreenInput['mode'],
  paths: string[],
) {
  let roots = decks.get(source)
  if (!roots) {
    roots = new Map()
    decks.set(source, roots)
  }
  let full = roots.get(rootId)
  if (!full) {
    const rows = buildFlightDeckRows(issues, sessions, rootId, 'full', paths)
    const byId = new Map(issues.map((issue) => [issue.id as string, issue]))
    const bySession = new Map(
      source.sessions.map((session) => [session.sessionId as string, session]),
    )
    const byRow = new Map(rows.map((row) => [row.issue.id as string, row]))
    const coordinated = new Set(
      rows
        .filter((row) => coordinatorLive(bySession.get(row.issue.coordinatorSessionId ?? '')))
        .map((row) => row.issue.id as string),
    )
    const interactions = new Map<string, number>()
    for (const row of source.pendingInteractions ?? [])
      if (row.status === 'asked')
        interactions.set(row.sessionId, (interactions.get(row.sessionId) ?? 0) + 1)
    full = rows.map((row) => {
      const ids = new Set<string>([row.issue.id, ...row.descendantIds])
      const leads = [...coordinated].filter((id) => ids.has(id))
      let actionableCount = 0,
        waitingAgentCount = 0,
        workingAgentCount = 0
      for (const id of ids) {
        const child = byRow.get(id)
        if (!child) continue
        const delegated = leads.some(
          (lead) => lead !== id && byRow.get(lead)?.descendantIds.includes(id),
        )
        const roleOf = (session: ReferenceState['sessions'][number]) =>
          delegated
            ? ('delegate' as const)
            : coordinated.has(id)
              ? session.sessionId === child.issue.coordinatorSessionId
                ? ('coordinator' as const)
                : ('delegate' as const)
              : null
        const verdict = (session: ReferenceState['sessions'][number]) =>
          coordinatedSeat(
            session,
            roleOf(session) ?? 'coordinator',
            { count: interactions.get(session.sessionId) ?? 0 },
            !isFinished(byId.get(session.issueId ?? '') ?? {}),
          )
        const asks = (session: ReferenceState['sessions'][number]) =>
          roleOf(session) === null
            ? sessionAsksOnIssue(child.issue, session)
            : verdict(session).asks
        const waiting = child.sessions.filter(asks).length
        actionableCount += Number(
          delegated ? waiting > 0 : issueNeedsHuman(child.issue, child.sessions, byId, asks),
        )
        waitingAgentCount += waiting
        workingAgentCount += child.sessions.filter((session) =>
          roleOf(session) === null
            ? isSessionWorking(session)
            : !session.archived && session.status !== 'exited' && verdict(session).working,
        ).length
      }
      return { ...row, actionableCount, waitingAgentCount, workingAgentCount }
    })
    roots.set(rootId, full)
  }
  if (mode === 'full') return full
  const counts = new Map(full.map((row) => [row.issue.id as string, row]))
  return buildFlightDeckRows(issues, sessions, rootId, mode, paths).map((row) => {
    const expected = counts.get(row.issue.id)
    return expected
      ? {
          ...row,
          actionableCount: expected.actionableCount,
          waitingAgentCount: expected.waitingAgentCount,
          workingAgentCount: expected.workingAgentCount,
        }
      : row
  })
}

/** Board matches retain eligible ancestors; human proposals lead their own blocks. */
function boardRows(issues: Issue[], options: NonNullable<MobileScreenInput['tasks']>) {
  const byId = new Map(issues.map((issue) => [issue.id as string, issue]))
  const ancestors = (id: string) => {
    const result: string[] = [],
      seen = new Set([id])
    for (
      let next = byId.get(id)?.parentId;
      next && !seen.has(next);
      next = byId.get(next)?.parentId
    ) {
      result.push(next)
      seen.add(next)
    }
    return result
  }
  const scope = filterBoardScope(issues, options.showAgentTasks)
  const includesDone =
    options.showDone ||
    options.filter.status === 'closed' ||
    ['done', 'cancelled', 'duplicate', 'superseded'].includes(options.filter.stage ?? '')
  const eligible = new Set(
    scope.filter((issue) => includesDone || !isFinished(issue)).map((issue) => issue.id as string),
  )
  const matched = new Set(
    filterBoardIssues(scope, options.filter)
      .filter((issue) => eligible.has(issue.id))
      .map((issue) => issue.id as string),
  )
  const retained = new Set(matched)
  for (const id of matched)
    for (const parent of ancestors(id)) {
      if (!eligible.has(parent)) break
      retained.add(parent)
    }
  const screenable = (issue: Issue) =>
    !issue.archived && !issue.deletedAt && issue.stage === 'proposed' && issue.audience !== 'agent'
  const promoted = new Set(
    [...matched].filter((id) => {
      const issue = byId.get(id)
      if (!issue || !issue.parentId || !screenable(issue)) return false
      for (const parent of ancestors(id)) {
        if (!retained.has(parent)) break
        if (byId.get(parent)?.stage === 'proposed') return false
      }
      return true
    }),
  )
  const ordinary = new Set(
    [...retained].filter(
      (id) =>
        !promoted.has(id) &&
        !ancestors(id).some((parent) => {
          if (!retained.has(parent)) return false
          return promoted.has(parent)
        }),
    ),
  )
  const children = (id: string, ordinaryTree: boolean) =>
    issues.filter(
      (issue) =>
        issue.parentId === id &&
        issue.id !== id &&
        (ordinaryTree ? ordinary : retained).has(issue.id),
    )
  const natural = [...ordinary].filter((id) => {
    const parent = byId.get(id)?.parentId
    return !parent || parent === id || !ordinary.has(parent)
  })
  const roots = [...natural],
    covered = new Set<string>()
  const cover = (id: string) => {
    if (covered.has(id)) return
    covered.add(id)
    for (const child of children(id, true)) cover(child.id)
  }
  for (const id of roots) cover(id)
  for (const id of [...ordinary].sort())
    if (!covered.has(id)) {
      roots.push(id)
      cover(id)
    }
  const ordered = (ids: string[]) =>
    orderIssues(ids.map((id) => byId.get(id)!).filter(Boolean), options.ordering)
  const sections = STAGES.map((stage) => {
    const own = roots.filter((id) => byId.get(id)?.stage === stage).sort()
    const proposals =
      stage === 'proposed'
        ? [...promoted].sort(
            (a, b) =>
              byId.get(a)!.priority - byId.get(b)!.priority || byId.get(b)!.seq - byId.get(a)!.seq,
          )
        : []
    const rows: { issue: Issue; depth: number; childCount: number; expanded: boolean }[] = []
    const emit = (issue: Issue, depth: number, path: ReadonlySet<string>) => {
      if (path.has(issue.id)) return
      const nested = orderIssues(children(issue.id, ordinary.has(issue.id)), options.ordering)
      const expanded = nested.length > 0 && options.expanded.includes(issue.id)
      rows.push({ issue, depth, childCount: nested.length, expanded })
      if (expanded) for (const child of nested) emit(child, depth + 1, new Set([...path, issue.id]))
    }
    for (const issue of ordered([...own, ...proposals])) emit(issue, 0, new Set())
    return { stage, rows }
  }).filter((section) => section.rows.length)
  return {
    sections,
    proposals: issues.filter(
      (issue) =>
        screenable(issue) && !ancestors(issue.id).some((id) => byId.get(id)?.stage === 'proposed'),
    ).length,
  }
}

/** Same questions as the phone, answered from a complete record publication. */
export function expectMobileScreens(
  actual: SidebarSnapshot,
  source: ReferenceState,
  input: MobileScreenInput,
  label: string,
) {
  const issues = referenceIssues(source)
  const sessions = source.sessions.filter((session) => !session.headless)
  const paths = reposToViews(source.repos).flatMap((repo) =>
    repo.worktrees.map((worktree) => worktree.path),
  )
  const section = (key: string) => {
    const value = actual.sections.find((section) => section.key === key)
    if (!value) throw new Error(`${label}: missing ${key}`)
    return value
  }
  expect(actual.pending, label).toBe(0)
  const root = input.selectedId ? missionRootFor(issues, asIssueId(input.selectedId)) : undefined
  const rawOrder = dedupeSessionsByResume(
    [...source.replica.rows('sessions')].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
  )
  const rank = new Map(rawOrder.map((session, index) => [session.sessionId as string, index]))
  const crew = root
    ? missionSessions(issues, sessions, root.id).sort(
        (a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0),
      )
    : []
  const current =
    crew.find((session) => session.sessionId === input.requestedSessionId) ??
    input.selectSession(crew)
  const members = new Map(issues.map((issue) => [issue.id as string, issue]))
  const header = (current?.issueId ? members.get(current.issueId) : undefined) ?? root
  const headerFields = header ? fields(header) : null
  if (headerFields) delete headerFields.pinned
  const mission = section('mission')
  expect(
    mission.rows.map((row) => row.id),
    `${label}: crew order`,
  ).toEqual(crew.map((session) => session.sessionId))
  expect(mission.fields, `${label}: mission counts`).toMatchObject({
    root: root?.id ?? null,
    current: current?.sessionId ?? null,
    header: header ? { id: header.id, ...headerFields } : null,
    progress: referenceProgress(issues, sessions, root?.id),
    attention: crew.filter(sessionNeedsHuman).length,
    live: crew.filter((session) => !session.archived && session.status !== 'exited').length,
    working: crew.filter(isSessionWorking).length,
  })
  const rows = root ? referenceDeck(source, issues, sessions, root.id, input.mode, paths) : []
  const details = section('details')
  expect(
    details.rows.map((row) => row.id),
    `${label}: deck order`,
  ).toEqual(rows.map((row) => row.issue.id))
  for (const [index, row] of rows.entries())
    expect(details.rows[index]?.fields, `${label}: deck ${row.issue.id}`).toMatchObject({
      issue: fields(row.issue, true),
      depth: row.depth,
      descendantIds: row.descendantIds,
      matched: row.matched,
      actionableCount: row.actionableCount,
      liveAgentCount: row.liveAgentCount,
      workingAgentCount: row.workingAgentCount,
      waitingAgentCount: row.waitingAgentCount,
    })
  expect(
    section('departures').rows.map((row) => row.id),
    `${label}: departures`,
  ).toEqual(missionDepartures(issues, sessions, root?.id, paths).map((value) => value.issue.id))
  const board = input.tasks ? boardRows(issues, input.tasks) : { sections: [], proposals: 0 }
  expect(section('tasks').fields.proposals, `${label}: proposals`).toBe(board.proposals)
  expect(
    actual.sections
      .filter((section) => section.key.startsWith('tasks:'))
      .map((section) => section.key),
    `${label}: task lanes`,
  ).toEqual(board.sections.map((section) => `tasks:${section.stage}`))
  const working = confirmedWorkingAgentCountsByIssue(issues, sessions, source.coarseNow)
  // The card meter counts the live formal tree; archived, deleted and draft
  // branches have left that tree and cannot contribute descendant work.
  const progress = taskProgressMap(
    issues.filter((issue) => !issue.archived && !issue.deletedAt && !issue.isDraftVessel),
    issues.map((issue) => issue.id),
    working,
  )
  for (const expected of board.sections) {
    const drawn = section(`tasks:${expected.stage}`)
    expect(
      drawn.rows.map((row) => row.id),
      `${label}: ${expected.stage} order`,
    ).toEqual(expected.rows.map((row) => row.issue.id))
    expect(drawn.fields.total, `${label}: ${expected.stage} roots`).toBe(
      expected.rows.filter((row) => row.depth === 0).length,
    )
    for (const [index, row] of expected.rows.entries())
      expect(drawn.rows[index]?.fields, `${label}: task ${row.issue.id}`).toMatchObject({
        issue: fields(row.issue),
        depth: row.depth,
        childCount: row.childCount,
        expanded: row.expanded,
        parent: row.issue.parentId ? (members.get(row.issue.parentId)?.title ?? null) : null,
        working: working.get(row.issue.id) ?? 0,
        progress: progress.get(row.issue.id) ?? null,
        state: taskStateWord(row.issue, working.get(row.issue.id) ?? 0, progress.get(row.issue.id)),
      })
  }
}
