/** Stateless record oracle. No client-graph runtime reads participate in expected answers. */

import type { SessionView } from '@podium/client-core/session-values'
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
  sessionAtWork,
  sessionNeedsHuman,
  sessionsForIssueNav,
  tallyMissionBuckets,
  taskProgressMap,
  taskStateWord,
} from '@podium/client-core/values'
import { defaultSeat } from '@podium/client-graph/mission-seat'
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
const boardFacts = new WeakMap<
  ReferenceState,
  {
    working: ReturnType<typeof confirmedWorkingAgentCountsByIssue>
    progress: ReturnType<typeof taskProgressMap>
  }
>()
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

// Source-only indices live for exactly one immutable publication. They do
// not borrow pool models, and every expected row still comes from the oracle.
const sourceFacts = new WeakMap<ReferenceState, ReturnType<typeof buildSourceFacts>>()
function buildSourceFacts(source: ReferenceState) {
  const issues = referenceIssues(source)
  const sessions = source.sessions.filter((session) => !session.headless)
  const members = new Map(issues.map((issue) => [issue.id as string, issue]))
  const paths = reposToViews(source.repos).flatMap((repo) =>
    repo.worktrees.map((tree) => tree.path),
  )
  const rawOrder = dedupeSessionsByResume(
    [...source.replica.rows('sessions')].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
  )
  const rank = new Map(rawOrder.map((session, index) => [session.sessionId as string, index]))
  return {
    issues,
    sessions,
    members,
    paths,
    rank,
    crews: new Map<string, ReturnType<typeof missionSessions>>(),
    progress: new Map<string, ReturnType<typeof tallyMissionBuckets>>(),
    departures: new Map<string, ReturnType<typeof missionDepartures>>(),
  }
}
function factsFor(source: ReferenceState) {
  let facts = sourceFacts.get(source)
  if (!facts) {
    facts = buildSourceFacts(source)
    sourceFacts.set(source, facts)
  }
  return facts
}

/** A hidden mission may still contain accepted visible work. Count that work
 * from its formal records rather than dropping the meter with its root. */
function referenceProgress(source: ReferenceState, rootId?: string) {
  const facts = factsFor(source)
  const cached = facts.progress.get(rootId ?? '')
  if (cached) return cached
  const { issues, sessions, members: byId } = facts
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
  const progress = tallyMissionBuckets(leaves, (id) => {
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
  facts.progress.set(rootId ?? '', progress)
  return progress
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
      issues
        .filter((issue) => coordinatorLive(bySession.get(issue.coordinatorSessionId ?? '')))
        .map((issue) => issue.id as string),
    )
    const interactions = new Map<string, number>()
    for (const row of source.pendingInteractions ?? [])
      if (row.status === 'asked')
        interactions.set(row.sessionId, (interactions.get(row.sessionId) ?? 0) + 1)
    // The drawn rows can omit a grafted branch even though its descendants
    // still contribute to a fold's totals. Counts read the complete visible
    // record scope, independently of which rows the deck drew.
    const crewById = new Map<string, ReferenceState['sessions']>()
    const crew = (issue: Issue) => {
      let members = crewById.get(issue.id)
      if (!members) {
        members = sessionsForIssueNav(issue, sessions, paths, { includeShells: true })
        crewById.set(issue.id, members)
      }
      return members
    }
    const ancestors = new Map<string, string[]>()
    for (const parent of rows)
      for (const childId of parent.descendantIds) {
        const chain = ancestors.get(childId) ?? []
        chain.push(parent.issue.id)
        ancestors.set(childId, chain)
      }
    full = rows.map((row) => {
      const ids = new Set<string>([row.issue.id, ...row.descendantIds])
      let actionableCount = 0,
        waitingAgentCount = 0,
        workingAgentCount = 0
      for (const id of ids) {
        const issue = byId.get(id)
        if (!issue || issue.archived || issue.deletedAt) continue
        const child = byRow.get(id) ?? { issue, sessions: crew(issue) }
        const delegated = (ancestors.get(id) ?? []).some(
          (lead) => ids.has(lead) && coordinated.has(lead),
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
  // Matching is an OWN-row decision. A live coordinator receives ordinary
  // delegate asks, while delegate exceptions still reach the human. The old
  // pure deck helper predates that policy and cannot select the narrowed view.
  const matches = new Set<string>()
  // A coordinator may be headless and absent from the phone's drawn crew.
  // Its live role still governs every visible delegate on the task.
  const bySession = new Map(source.sessions.map((session) => [session.sessionId, session]))
  const byIssue = new Map(issues.map((issue) => [issue.id as string, issue]))
  const pending = new Map<string, number>()
  for (const interaction of source.pendingInteractions ?? [])
    if (interaction.status === 'asked')
      pending.set(interaction.sessionId, (pending.get(interaction.sessionId) ?? 0) + 1)
  for (const row of full) {
    const coordinatorId = row.issue.coordinatorSessionId
    const coordinated = coordinatorLive(coordinatorId ? bySession.get(coordinatorId) : undefined)
    const verdict = (session: ReferenceState['sessions'][number]) =>
      coordinatedSeat(
        session,
        session.sessionId === row.issue.coordinatorSessionId ? 'coordinator' : 'delegate',
        { count: pending.get(session.sessionId) ?? 0 },
        !isFinished(byIssue.get(session.issueId ?? '') ?? {}),
      )
    const matched =
      mode === 'needs-you'
        ? issueNeedsHuman(
            row.issue,
            row.sessions,
            undefined,
            coordinated ? (session) => verdict(session).asks : undefined,
          )
        : row.sessions.some((session) =>
            coordinated
              ? !session.archived && session.status !== 'exited' && verdict(session).working
              : sessionAtWork(session),
          )
    if (matched) matches.add(row.issue.id)
  }
  // Preserve context along the drawn tree, including grafted provenance edges.
  const retained = new Set<string>([rootId])
  const ancestors: string[] = []
  for (const row of full) {
    ancestors.length = row.depth
    ancestors.push(row.issue.id)
    if (matches.has(row.issue.id)) for (const id of ancestors) retained.add(id)
  }
  return full
    .filter((row) => retained.has(row.issue.id))
    .map((row) => ({ ...row, matched: matches.has(row.issue.id) }))
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
  const scope = filterBoardScope(issues, options.showAgentTasks ?? false)
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
  // Index this immutable record publication once. Re-scanning every issue
  // for every node makes the independent board oracle quadratic at 4x.
  const byParent = new Map<string, Issue[]>()
  for (const issue of issues) {
    if (!issue.parentId || issue.parentId === issue.id) continue
    const siblings = byParent.get(issue.parentId) ?? []
    siblings.push(issue)
    byParent.set(issue.parentId, siblings)
  }
  const children = (id: string, ordinaryTree: boolean) =>
    (byParent.get(id) ?? []).filter((issue) => (ordinaryTree ? ordinary : retained).has(issue.id))
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
    orderIssues(ids.map((id) => byId.get(id)!).filter(Boolean), options.ordering ?? 'priority')
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
      const nested = orderIssues(
        children(issue.id, ordinary.has(issue.id)),
        options.ordering ?? 'priority',
      )
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
  const facts = factsFor(source)
  const { issues, sessions, paths, members, rank } = facts
  const section = (key: string) => {
    const value = actual.sections.find((section) => section.key === key)
    if (!value) throw new Error(`${label}: missing ${key}`)
    return value
  }
  expect(actual.pending, label).toBe(0)
  const root = input.selectedId ? missionRootFor(issues, asIssueId(input.selectedId)) : undefined
  let crew = facts.crews.get(root?.id ?? '')
  if (!crew) {
    crew = root
      ? missionSessions(issues, sessions, root.id).sort(
          (a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0),
        )
      : []
    facts.crews.set(root?.id ?? '', crew)
  }
  // The phone opens a mission on the shared default seat (dev/tf 75d210056f):
  // coordinator, lone member, then most recently active, over open sessions.
  // The oracle hands the same rule its own source records, each answering
  // `open` as the session model does (present, not archived, not exited).
  const seat = defaultSeat(
    crew.map((session) => ({
      ...session,
      open: !session.archived && session.status !== 'exited',
    })) as unknown as SessionView[],
    root?.coordinatorSessionId,
  )
  const automatic = crew.find((session) => session.sessionId === seat?.sessionId)
  const current =
    crew.find((session) => session.sessionId === input.requestedSessionId) ?? automatic
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
    progress: referenceProgress(source, root?.id),
    attention: crew.filter(sessionNeedsHuman).length,
    live: crew.filter((session) => !session.archived && session.status !== 'exited').length,
    working: crew.filter(isSessionWorking).length,
  })
  const rows = root ? referenceDeck(source, issues, sessions, root.id, input.mode, paths) : []
  const details = section('details')
  const actualIds = new Set(details.rows.map((row) => row.id))
  const omitted = rows
    .filter((row) => !actualIds.has(row.issue.id))
    .map((row) => ({
      id: row.issue.id,
      stage: row.issue.stage,
      matched: row.matched,
      needsHuman: row.issue.needsHuman,
      dependents: row.issue.dependents,
      coordinator: row.issue.coordinatorSessionId,
      crew: row.sessions.map((session) => ({
        id: session.sessionId,
        home: session.issueId,
        phase: session.agentState?.phase,
        status: session.status,
        archived: session.archived,
        offer: Boolean(session.offer),
      })),
    }))
  expect(
    details.rows.map((row) => row.id),
    `${label}: deck order${omitted.length ? `; omitted ${JSON.stringify(omitted)}` : ''}`,
  ).toEqual(rows.map((row) => row.issue.id))
  for (const [index, row] of rows.entries()) {
    const drawn = details.rows[index]?.fields
    const mismatch = drawn?.actionableCount !== row.actionableCount
    const byId = mismatch ? new Map(issues.map((issue) => [issue.id as string, issue])) : null
    const contributors = mismatch
      ? [row.issue.id, ...row.descendantIds].flatMap((id) => {
          const issue = byId!.get(id)
          if (!issue || issue.archived || issue.deletedAt) return []
          const child = rows.find((candidate) => candidate.issue.id === id) ?? {
            issue,
            sessions: sessionsForIssueNav(issue, sessions, paths, { includeShells: true }),
          }
          return [
            {
              id,
              stage: child.issue.stage,
              needsHuman: child.issue.needsHuman,
              coordinator: child.issue.coordinatorSessionId,
              dependents: child.issue.dependents,
              defaultAttention: issueNeedsHuman(child.issue, child.sessions),
              indexedAttention: issueNeedsHuman(child.issue, child.sessions, byId!),
              crew: child.sessions.map((session) => ({
                id: session.sessionId,
                issueId: session.issueId,
                phase: session.agentState?.phase,
                status: session.status,
                archived: session.archived,
              })),
            },
          ]
        })
      : []
    expect(
      drawn,
      `${label}: deck ${row.issue.id}${mismatch ? `; contributors ${JSON.stringify(contributors)}` : ''}`,
    ).toMatchObject({
      issue: fields(row.issue, true),
      depth: row.depth,
      descendantIds: row.descendantIds,
      matched: row.matched,
      actionableCount: row.actionableCount,
      liveAgentCount: row.liveAgentCount,
      workingAgentCount: row.workingAgentCount,
      waitingAgentCount: row.waitingAgentCount,
    })
  }
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
  let totals = boardFacts.get(source)
  if (board.sections.length > 0 && !totals) {
    const working = confirmedWorkingAgentCountsByIssue(issues, sessions, source.coarseNow)
    // These pure record counts belong to the publication, independent of the
    // selected mission or board options. Mission-only comparisons need none.
    totals = {
      working,
      progress: taskProgressMap(
        issues.filter((issue) => !issue.archived && !issue.deletedAt && !issue.isDraftVessel),
        issues.map((issue) => issue.id),
        working,
      ),
    }
    boardFacts.set(source, totals)
  }
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
        working: totals?.working.get(row.issue.id) ?? 0,
        progress: totals?.progress.get(row.issue.id) ?? null,
        state: taskStateWord(
          row.issue,
          totals?.working.get(row.issue.id) ?? 0,
          totals?.progress.get(row.issue.id),
        ),
      })
  }
}
