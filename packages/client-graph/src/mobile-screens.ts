import { companion, keyedComputed, lazy } from '@podium/mobx-helpers'
import type { IssueModel, SessionModel } from './models'
import { missions } from './mission'
import { isFinished } from './shared/predicates'
/** Mobile screen reads on the app-owned pool. No feed, replica, mutation owner,
 * world enumeration, peek reader, or independently maintained relationships. */
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  confirmedWorkingAgentCount,
  type FlightDeckMode,
  type IssueRow,
  issueAbandoned,
  orderIssues,
  type TaskProgress,
} from '@podium/client-core/values'
import { ISSUE_STATUS_LABELS } from '@podium/model/browser'
import {
  compareShallow, computed, type IComputedValue,
} from 'mobx'
import { type BoardQuery, ISSUE_BOARD_ENTITIES, ISSUE_BOARD_SOURCE_KEY } from './issue-board-schema'
import { createIssueBoardSource } from './issue-board-source'
import { MissionViewReader, type MissionViewValues, readMissionView } from './mission-view'
import {
  EMPTY_MOBILE_MISSION,
  MOBILE_SCREEN_ENTITIES,
  MOBILE_SCREEN_SOURCE_KEY,
  MOBILE_TASK_STAGES,
  type MobileMissionData,
  type MobileTasksData,
  type MobileTaskSection,
  type MobileTasksOptions,
} from './mobile-screens-schema'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

/** Mobile selects structural roots, including an archived task or an empty
 * draft explicitly opened by its id. Web's sidebar visibility is separate. */
class MobileMissionReader extends MissionViewReader {
  override selectedRoot(id: string | null) {
    const rootId = this.rootFor(id)
    if (rootId === LOADING) return LOADING
    if (rootId) return this.issue(rootId)
    // A known cold row spends the shared load window. An unknown ID is
    // outside today's complete principal replica (POD-4286's contract).
    if (id && this.pool.row('issue', id) === LOADING) return LOADING
    return undefined
  }
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const requireRow = <T>(row: Loaded<T>): T | undefined => {
  if (row === LOADING) throw LOADING
  return row
}

function settled<T>(read: () => T): T | typeof LOADING {
  try { return read() } catch (error) {
    if (error === LOADING) return LOADING
    throw error
  }
}

/** Stabilize a fixed screen shape one field at a time. Collections compare
 * borrowed row identities, and scalar records (such as progress) one level.
 * Nested model values are never recursively compared on publication. */
function screenSnapshot<T extends object>(
  data: IComputedValue<T | typeof LOADING>,
  keys: readonly (keyof T)[],
  overrides: Partial<{ [K in keyof T]: IComputedValue<T[K] | typeof LOADING> }> = {},
  identities: readonly (keyof T)[] = [],
): IComputedValue<T | typeof LOADING> {
  const fields = keys.map(key => [key, overrides[key] ?? computed(() => {
    const value = data.get()
    return value === LOADING ? LOADING : value[key]
  }, { equals: identities.includes(key) ? Object.is : compareShallow })] as const)
  return computed(() => {
    const entries = fields.map(([key, field]) => [key, field.get()] as const)
    if (entries.some(([, value]) => value === LOADING)) return LOADING
    return Object.fromEntries(entries) as T
  }, { equals: compareShallow })
}

export function createMobileScreenReader(pool: MobxPool) {
  const mission = new MobileMissionReader(pool)
  // Factories live only while their screen is observed. Each field computed
  // borrows row identities or compares scalar values; publication never walks
  // into an issue, session, deck row or document.
  const cache = keyedComputed((key: string) => `MobileScreen@${key}`,
    (_key: string, create: () => IComputedValue<unknown>) => create())
  const taskRows = keyedComputed('MobileScreen.taskRow', (key: string): IssueRow<IssueViewModel> => {
    const [id, depth, childCount, expanded] = JSON.parse(key) as [string, number, number, boolean]
    const issue = requireRow(pool.row('issueBoardRow', id))
    if (!issue) throw LOADING
    return { issue, depth, childCount, expanded }
  })
  const taskProgress = keyedComputed('MobileScreen.taskProgress', (key: string) => {
    const card = requireRow(pool.row('issueBoardCard', key))
    if (!card) throw LOADING
    return card.progress
  }, { equals: compareShallow })
  const stats = { tasks: 0, mission: 0, deck: 0 }
  let disposed = false
  function memo<T>(key: string, create: () => IComputedValue<T | typeof LOADING>): T | typeof LOADING {
    return disposed ? LOADING : cache(key, create).get() as T | typeof LOADING
  }
  function query(options: BoardQuery) {
    const result = requireRow(pool.row('issueBoardQuery', JSON.stringify(options)))
    if (!result) throw LOADING
    return result.ids
  }
  function tasks(options: MobileTasksOptions): MobileTasksData | typeof LOADING {
    return memo(`tasks:${JSON.stringify(options)}`, () => {
      const data = computed(() => settled(() => readTasks(options)))
      const sections = MOBILE_TASK_STAGES.map(stage => {
        const rows = computed(() => {
          const value = data.get()
          return value === LOADING ? LOADING : value.board.find(section => section.stage === stage)?.rows ?? []
        }, { equals: compareShallow })
        return computed((): MobileTaskSection | typeof LOADING => {
          const value = rows.get()
          if (value === LOADING) return LOADING
          return { stage, title: ISSUE_STATUS_LABELS[stage], rows: value }
        })
      })
      const board = computed(() => {
        const result = sections.map(section => section.get())
        if (result.some(section => section === LOADING)) return LOADING
        return (result as MobileTaskSection[]).filter(section => section.rows.length)
      }, { equals: compareShallow })
      return screenSnapshot(data, ['issues', 'sessions', 'board', 'workingByIssue', 'progressByIssue', 'proposals'], { board })
    })
  }
  function readTasks(options: MobileTasksOptions): MobileTasksData {
    stats.tasks++
    // The shared source owns the resident index and declared cold questions.
    // This map is this mounted query's borrowed presentation, never an index.
    const models = new Map<string, IssueViewModel>()
    const issue = (id: string) => {
      if (models.has(id)) return models.get(id)
      const value = requireRow(pool.row('issueBoardRow', id))
      if (value) models.set(id, value)
      return value
    }
    const parent = (id: string) =>
      pool.graph.one('issue', id, 'treeParent') ?? issue(id)?.parentId
    const audience = (id: string): boolean => {
      const row = issue(id)
      if (!row || (row.isDraftVessel && !row.deletedAt)) return false
      if (options.showAgentTasks || row.deletedAt || row.audience !== 'agent') return true
      const seen = new Set([id])
      let next = parent(id)
      while (next && !seen.has(next)) {
        seen.add(next)
        const ancestor = issue(next)
        if (!ancestor || (ancestor.isDraftVessel && !ancestor.deletedAt)) return false
        if (ancestor.deletedAt || ancestor.audience !== 'agent') return true
        next = parent(next)
      }
      return false
    }
    const eligible = (id: string) =>
      audience(id) && (options.showDone || !isFinished(issue(id) ?? {}))
    const matched = new Set(
      query({
        kind: 'board',
        filter: options.filter,
        showAgentTasks: options.showAgentTasks,
      }).filter((id) => eligible(id)),
    )
    const retained = new Set(matched)
    for (const id of matched) {
      const seen = new Set([id])
      let next = parent(id)
      while (next && !seen.has(next)) {
        seen.add(next)
        if (!eligible(next)) break
        retained.add(next)
        next = parent(next)
      }
    }
    const screenable = (row: IssueViewModel) =>
      row.stage === 'proposed' &&
      !row.archived &&
      !row.deletedAt &&
      !row.isDraftVessel &&
      row.audience !== 'agent'
    const underProposal = (id: string, scope?: ReadonlySet<string>): boolean => {
      const seen = new Set([id])
      let next = parent(id)
      while (next && !seen.has(next) && (!scope || scope.has(next))) {
        seen.add(next)
        if (issue(next)?.stage === 'proposed') return true
        next = parent(next)
      }
      return false
    }
    const scoped = [...retained].sort(byId).flatMap((id) => {
      const row = issue(id)
      return row ? [row] : []
    })
    const promoted = scoped
      .filter(
        (row) =>
          screenable(row) &&
          row.parentId &&
          matched.has(row.id) &&
          !underProposal(row.id, retained),
      )
      .sort((a, b) => a.priority - b.priority || b.seq - a.seq)
    const promotedIds = new Set<string>(promoted.map((row) => row.id))
    const ordinary = new Set<string>(
      scoped
        .filter((row) => {
          const seen = new Set<string>()
          let id: string | undefined = row.id
          while (id && retained.has(id) && !seen.has(id)) {
            if (promotedIds.has(id)) return false
            seen.add(id)
            id = parent(id) ?? undefined
          }
          return true
        })
        .map((row) => row.id),
    )
    const children = (id: string, scope: ReadonlySet<string>) =>
      [...pool.graph.many('issue', id, 'treeChildren')]
        .sort(byId)
        .filter((child) => child !== id && scope.has(child))
        .flatMap((child) => {
          const row = issue(child)
          return row ? [row] : []
        })
    const expanded = new Set(options.expanded)
    const emit = (
      row: IssueViewModel,
      depth: number,
      scope: ReadonlySet<string>,
      out: IssueRow<IssueViewModel>[],
      path: ReadonlySet<string>,
      listed?: Set<string>,
    ) => {
      if (path.has(row.id) || listed?.has(row.id)) return
      listed?.add(row.id)
      const kids = children(row.id, scope),
        open = kids.length > 0 && expanded.has(row.id)
      out.push(taskRows(JSON.stringify([row.id, depth, kids.length, open])))
      if (open)
        for (const child of orderIssues(kids, options.ordering))
          emit(child, depth + 1, scope, out, new Set(path).add(row.id), listed)
    }
    const roots = [...ordinary].sort(byId).filter((id) => {
      const p = parent(id)
      return !p || p === id || !ordinary.has(p)
    })
    // The legacy layout promotes a cycle's first unreached member too.
    const reached = new Set<string>()
    const reach = (id: string) => {
      const pending = [id]
      while (pending.length) {
        const next = pending.pop()!
        if (reached.has(next)) continue
        reached.add(next)
        pending.push(...children(next, ordinary).map((row) => row.id))
      }
    }
    for (const id of roots) reach(id)
    for (const id of [...ordinary].sort(byId))
      if (!reached.has(id)) {
        roots.push(id)
        reach(id)
      }
    const sections = MOBILE_TASK_STAGES.map((stage) => {
      const rows: IssueRow<IssueViewModel>[] = []
      const candidates = roots.flatMap((id) => {
        const row = issue(id)
        return row?.stage === stage ? [row] : []
      })
      for (const row of orderIssues(candidates, options.ordering))
        emit(row, 0, ordinary, rows, new Set())
      return { stage, title: ISSUE_STATUS_LABELS[stage], rows }
    })
    const listed = new Set(sections.flatMap((section) => section.rows.map((row) => row.issue.id)))
    const proposals = sections.find((section) => section.stage === 'proposed')!
    const blocks: IssueRow<IssueViewModel>[][] = []
    for (const row of proposals.rows) {
      if (!row.depth || !blocks.length) blocks.push([row])
      else blocks[blocks.length - 1]!.push(row)
    }
    for (const row of promoted) {
      const block: IssueRow<IssueViewModel>[] = []
      emit(row, 0, retained, block, new Set(), listed)
      if (block.length) blocks.push(block)
    }
    const blockById = new Map(blocks.map((block) => [block[0]!.issue.id, block]))
    proposals.rows = orderIssues(
      blocks.map((block) => block[0]!.issue),
      options.ordering,
    ).flatMap((row) => blockById.get(row.id)!)
    const board = sections.filter((section) => section.rows.length)
    const workingByIssue = new Map<string, number>(),
      progressByIssue = new Map<string, TaskProgress | null>()
    const sessions = new Map<string, SessionView>()
    for (const row of board.flatMap((section) => section.rows)) {
      const card = requireRow(
        pool.row(
          'issueBoardCard',
          JSON.stringify({
            id: row.issue.id,
            now: pool.clock.trackedNow(),
            agents: options.showAgentTasks,
          }),
        ),
      )
      if (!card) throw LOADING
      workingByIssue.set(row.issue.id, confirmedWorkingAgentCount(card.fleet, pool.clock.trackedNow()))
      progressByIssue.set(row.issue.id, taskProgress(JSON.stringify({
        id: row.issue.id, now: pool.clock.trackedNow(), agents: options.showAgentTasks,
      })))
      for (const seat of card.sessions) sessions.set(seat.sessionId, seat)
    }
    // The banner is independent of board filters and agent-task visibility.
    // A declared proposed query supplies IDs; ancestry uses scalar summaries.
    let proposalCount = 0
    for (const id of query({
      kind: 'board',
      filter: { stage: 'proposed' },
      showAgentTasks: true,
    })) {
      const facts = requireRow(pool.row('issue', id, 'summary-fields')) as
        | IssueViewModel
        | undefined
      if (!facts || !screenable(facts)) continue
      const seen = new Set([id])
      let next = pool.graph.one('issue', id, 'treeParent') ?? facts.parentId,
        blocked = false
      while (next && !seen.has(next)) {
        seen.add(next)
        const ancestor = requireRow(pool.row('issue', next, 'summary-fields')) as
          | IssueViewModel
          | undefined
        if (!ancestor) break
        if (ancestor.stage === 'proposed') {
          blocked = true
          break
        }
        next = pool.graph.one('issue', next, 'treeParent') ?? ancestor.parentId
      }
      if (!blocked) proposalCount++
    }
    return {
      issues: [...models.values()].sort((a, b) => byId(a.id, b.id)),
      sessions: [...sessions.values()].sort(mission.sessionOrder),
      board,
      workingByIssue,
      progressByIssue,
      proposals: proposalCount,
    }
  }
  /** Phone-only roster and sheet references are independent lazy questions.
   * A displayed phase/label change cannot rewalk all mission attachments. */
  class PhoneMission {
    constructor(readonly issue: IssueModel) {}
    @lazy get members() { return requireRow(missions(pool).members(this.issue.id))! }
    @lazy get attached(): readonly SessionModel[] {
      const seats = new Map<string, SessionModel>()
      for (const member of this.members) {
        const attached = mission.attached(member)
        if (attached === LOADING) throw LOADING
        for (const seat of attached) seats.set(seat.sessionId, pool.sessionObject(seat.sessionId))
      }
      return [...seats.values()].sort(mission.sessionOrder)
    }
    @lazy get authors(): readonly SessionModel[] {
      const authors = new Map<string, SessionModel>()
      for (const member of this.members) {
        const id = pool.graph.one('issue', member, 'startedBy')
        if (!id || pool.graph.isCollapsed('session', id)) continue
        const session = requireRow(mission.session(id))
        if (session) authors.set(id, pool.sessionObject(id))
      }
      return [...authors.values()]
    }
    @lazy get sessions(): SessionModel[] {
      return [...new Map([...this.attached, ...this.authors].map(session => [session.sessionId, session])).values()].sort(mission.sessionOrder)
    }
    @lazy get crew(): SessionModel[] { return this.attached.filter(session => !session.archived) }
    @lazy get headerIssueIds(): ReadonlySet<string> {
      const ids = new Set<string>([this.issue.id])
      // The phone can pin any current crew session as its header, including
      // one on an archived member. Other hidden members stay on summaries.
      for (const session of this.crew) if (session.issueId) ids.add(session.issueId)
      return ids
    }
    @lazy get issues(): IssueViewModel[] {
      const issues = new Map<string, IssueViewModel>()
      for (const member of this.members) {
        const row = this.headerIssueIds.has(member) || mission.facts(member).visible
          ? requireRow(mission.issue(member))
          : requireRow(pool.row('issueBoardRow', member))
        if (row) issues.set(member, row)
      }
      // Authorship and sheet notes can refer outside the drawn mission.
      for (const row of [...issues.values()]) for (const dep of row.deps ?? []) {
        if (!issues.has(dep.id)) {
          const target = requireRow(pool.row('issueBoardRow', dep.id))
          if (target) issues.set(dep.id, target)
        }
      }
      return [...issues.values()].sort((a, b) => byId(a.id, b.id))
    }
  }
  const phoneMission = companion((issue: IssueModel) => new PhoneMission(issue))
  function deck(id: string | null, mode: FlightDeckMode): MissionViewValues | typeof LOADING {
    return memo(`deck:${id}:${mode}`, () => screenSnapshot(
      computed(() => settled(() => readDeck(id, mode))),
      ['root', 'rows', 'members', 'issueIds', 'deck', 'sessions', 'archivedCount', 'titles',
        'progress', 'departures', 'continuation', 'note', 'presence', 'rowPresentation'],
      {}, ['root', 'deck'],
    ))
  }
  function readDeck(id: string | null, mode: FlightDeckMode): MissionViewValues {
    stats.deck++
    const values = readMissionView(mission, id, mode)
    if (values === LOADING) throw LOADING
    let progress = values.progress
    if (values.root && (!mission.facts(values.root.id).visible)) {
      // Mobile can explicitly open a hidden root. The shared visible-root
      // meter's fallback must not resurrect it as a unit; accepted formal
      // children still count. Walk only this root's declared relation.
      const stack = [...pool.graph.many('issue', values.root.id, 'children')]
      const seen = new Set<string>([values.root.id])
      let accepted = false
      while (stack.length) {
        const childId = stack.pop()!
        if (seen.has(childId)) continue
        seen.add(childId)
        const child = requireRow(pool.row('issueBoardRow', childId))
        if (!child || !mission.facts(child.id).visible) continue
        if (child.stage !== 'proposed' && !issueAbandoned(child)) {
          accepted = true
          break
        }
        stack.push(...pool.graph.many('issue', childId, 'children'))
      }
      if (!accepted) progress = EMPTY_MOBILE_MISSION.progress
    }
    const presence = values.rows.some((row) => row.issue.id === values.root?.id)
      ? values.presence
      : null
    // The phone deck draws the mission's whole crew, archived included. The
    // shared pane carries seated senders only (its heartbeats never walk
    // history), so the phone adds every attached sender of the pane's issues,
    // as the pane once did itself.
    const sessions = values.deck ? [...values.deck.allSessions] : []
    return { ...values, progress, presence, sessions }
  }
  function readMission(id: string | null): MobileMissionData | typeof LOADING {
    return memo(`mission:${id}`, () => screenSnapshot(
      computed(() => settled(() => readMissionData(id))),
      ['root', 'issues', 'sessions', 'missionSessions', 'progress'],
      {}, ['root'],
    ))
  }
  function readMissionData(id: string | null): MobileMissionData {
    stats.mission++
    const values = deck(id, 'full')
    if (values === LOADING) throw LOADING
    if (!values.root) return EMPTY_MOBILE_MISSION
    const card = phoneMission(mission.facts(values.root.id))
    return {
      root: values.root,
      issues: card.issues,
      sessions: card.sessions as SessionView[],
      missionSessions: card.crew as SessionView[],
      progress: values.progress,
    }
  }
  return {
    stats,
    tasks,
    mission: readMission,
    deck,
    dispose() {
      disposed = true
      cache.clear()
      taskRows.clear()
      taskProgress.clear()
      mission.dispose()
    },
  }
}

export async function attachMobileScreens(
  pool: MobxPool,
  owner?: Parameters<typeof createIssueBoardSource>[1],
) {
  await pool.sources.ensure(ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_ENTITIES, () =>
    createIssueBoardSource(pool, owner),
  )
  return pool.sources.ensure(MOBILE_SCREEN_SOURCE_KEY, MOBILE_SCREEN_ENTITIES, () => {
    const reader = createMobileScreenReader(pool)
    return {
      read: (entity: string) => (entity === 'mobileScreenReader' ? reader : undefined),
      dispose: () => reader.dispose(),
    }
  })
}
