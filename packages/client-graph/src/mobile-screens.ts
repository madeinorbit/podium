import { keyedComputed } from '@podium/mobx-helpers'
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
  compareStructural,
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

export function createMobileScreenReader(pool: MobxPool) {
  const mission = new MobileMissionReader(pool)
  // TODO(POD-5575): fresh phone screen summaries need structural equality.
  const cache = keyedComputed((key: string) => `MobileScreen@${key}`, (_key: string, read: () => unknown) => {
    try { return read() } catch (error) {
      if (error === LOADING) return LOADING
      throw error
    }
  }, { equals: compareStructural })
  const stats = { tasks: 0, mission: 0, deck: 0 }
  let disposed = false
  function memo<T>(key: string, read: () => T): T | typeof LOADING {
    return disposed ? LOADING : cache(key, read) as T | typeof LOADING
  }
  function query(options: BoardQuery) {
    const result = requireRow(pool.row('issueBoardQuery', JSON.stringify(options)))
    if (!result) throw LOADING
    return result.ids
  }
  function tasks(options: MobileTasksOptions): MobileTasksData | typeof LOADING {
    return memo(`tasks:${JSON.stringify(options)}`, () => {
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
        out.push({ issue: row, depth, childCount: kids.length, expanded: open })
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
              now: pool.clock.current,
              agents: options.showAgentTasks,
            }),
          ),
        )
        if (!card) throw LOADING
        workingByIssue.set(row.issue.id, confirmedWorkingAgentCount(card.fleet, pool.clock.current))
        progressByIssue.set(row.issue.id, card.progress)
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
    })
  }
  function deck(id: string | null, mode: FlightDeckMode): MissionViewValues | typeof LOADING {
    return memo(`deck:${id}:${mode}`, () => {
      stats.deck++
      const values = readMissionView(mission, id, mode)
      if (values === LOADING) throw LOADING
      let progress = values.progress
      if (values.root && (values.root.archived || values.root.deletedAt)) {
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
          if (!child || child.archived || child.deletedAt) continue
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
      const crew = new Map(values.sessions.map((seat) => [seat.sessionId as string, seat]))
      for (const id of values.issueIds) {
        const attached = mission.attached(id)
        if (attached === LOADING) throw LOADING
        for (const seat of attached) crew.set(seat.sessionId, seat)
      }
      const sessions = [...crew.values()].sort(mission.sessionOrder)
      return { ...values, progress, presence, sessions }
    })
  }
  function readMission(id: string | null): MobileMissionData | typeof LOADING {
    return memo(`mission:${id}`, () => {
      stats.mission++
      const values = deck(id, 'full')
      if (values === LOADING) throw LOADING
      if (!values.root) return EMPTY_MOBILE_MISSION
      const issues = new Map(values.issueIds.flatMap(id => { const row = mission.issue(id); if (row === LOADING) throw LOADING; return row ? [[id, row] as const] : [] })),
        sessions = new Map(values.sessions.map((seat) => [seat.sessionId as string, seat]))
      const crew = new Map<string, SessionView>()
      for (const member of values.members) {
        if (!issues.has(member)) {
          const row = requireRow(pool.row('issueBoardRow', member))
          if (row) issues.set(member, row)
        }
        const attached = mission.attached(member)
        if (attached === LOADING) throw LOADING
        for (const seat of attached) {
          sessions.set(seat.sessionId, seat)
          if (!seat.archived) crew.set(seat.sessionId, seat)
        }
      }
      // Authorship and child-sheet notes can refer outside the drawn roster.
      for (const row of [...issues.values()]) {
        for (const dep of row.deps ?? [])
          if (!issues.has(dep.id)) {
            const target = requireRow(pool.row('issueBoardRow', dep.id))
            if (target) issues.set(dep.id, target)
          }
        if (
          row.startedBySession &&
          !sessions.has(row.startedBySession) &&
          !pool.graph.isCollapsed('session', row.startedBySession)
        ) {
          const author = requireRow(mission.session(row.startedBySession))
          if (author) sessions.set(author.sessionId, author)
        }
      }
      return {
        root: values.root,
        issues: [...issues.values()].sort((a, b) => byId(a.id, b.id)),
        sessions: [...sessions.values()].sort(mission.sessionOrder),
        missionSessions: [...crew.values()].sort(mission.sessionOrder),
        progress: values.progress,
      }
    })
  }
  return {
    stats,
    tasks,
    mission: readMission,
    deck,
    dispose() {
      disposed = true
      cache.clear()
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
