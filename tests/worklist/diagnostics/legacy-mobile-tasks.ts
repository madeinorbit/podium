/** Frozen pre-migration phone Tasks reader. Test oracle and before-memory control only. */
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  confirmedWorkingAgentCount,
  orderIssues,
  type IssueRow,
  type TaskProgress,
} from '@podium/client-core/values'
import { ISSUE_STATUS_LABELS } from '@podium/model/browser'
import { keyedComputed } from '@podium/mobx-helpers'
import { compareShallow, computed, type IComputedValue } from 'mobx'
import type { BoardQuery } from '../../../packages/client-graph/src/issue-board-schema'
import {
  MOBILE_TASK_STAGES,
  type MobileTasksOptions,
} from '../../../packages/client-graph/src/mobile-screens-schema'
import { readLegacyBoardCard } from './legacy-board-card'
import type { MobileTasksData, MobileTaskSection } from './mobile-task-snapshot'
import type { MobxPool } from '../../../packages/client-graph/src/pool'
import { isFinished } from '../../../packages/client-graph/src/shared/predicates'
import { LOADING, type Loaded } from '../../../packages/client-graph/src/worklist/rollup'
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const requireRow = <T>(row: Loaded<T>): T | undefined => {
  if (row === LOADING) throw LOADING
  return row
}
const settled = <T>(read: () => T): T | typeof LOADING => {
  try {
    return read()
  } catch (error) {
    if (error === LOADING) return LOADING
    throw error
  }
}
function screenSnapshot<T extends object>(
  data: IComputedValue<T | typeof LOADING>,
  keys: readonly (keyof T)[],
  overrides: Partial<{ [K in keyof T]: IComputedValue<T[K] | typeof LOADING> }> = {},
  identities: readonly (keyof T)[] = [],
): IComputedValue<T | typeof LOADING> {
  const fields = keys.map(
    (key) =>
      [
        key,
        overrides[key] ??
          computed(
            () => {
              const value = data.get()
              return value === LOADING ? LOADING : value[key]
            },
            { equals: identities.includes(key) ? Object.is : compareShallow },
          ),
      ] as const,
  )
  return computed(
    () => {
      const entries = fields.map(([key, field]) => [key, field.get()] as const)
      if (entries.some(([, value]) => value === LOADING)) return LOADING
      return Object.fromEntries(entries) as T
    },
    { equals: compareShallow },
  )
}

export function createLegacyMobileTasks(pool: MobxPool) {
  const cache = keyedComputed(
    'LegacyMobileTasks',
    (_key: string, create: () => IComputedValue<unknown>) => create(),
  )
  const taskRows = keyedComputed(
    'MobileScreen.taskRow',
    (key: string): IssueRow<IssueViewModel> => {
      const [id, depth, childCount, expanded] = JSON.parse(key) as [string, number, number, boolean]
      const issue = requireRow(pool.row('issueBoardRow', id))
      if (!issue) throw LOADING
      return { issue, depth, childCount, expanded }
    },
  )
  const taskProgress = keyedComputed(
    'MobileScreen.taskProgress',
    (key: string) => {
      const card = requireRow(readLegacyBoardCard(pool, JSON.parse(key) as { id: string; agents: boolean }))
      if (!card) throw LOADING
      return card.progress
    },
    { equals: compareShallow },
  )
  const stats = { tasks: 0 }
  let disposed = false
  function memo<T>(
    key: string,
    create: () => IComputedValue<T | typeof LOADING>,
  ): T | typeof LOADING {
    return disposed ? LOADING : (cache(key, create).get() as T | typeof LOADING)
  }
  function query(options: BoardQuery) {
    const result = requireRow(pool.row('issueBoardQuery', JSON.stringify(options)))
    if (!result) throw LOADING
    return result.ids
  }
  function tasks(options: MobileTasksOptions): MobileTasksData | typeof LOADING {
    return memo(`tasks:${JSON.stringify(options)}`, () => {
      const data = computed(() => settled(() => readTasks(options)))
      const sections = MOBILE_TASK_STAGES.map((stage) => {
        const rows = computed(
          () => {
            const value = data.get()
            return value === LOADING
              ? LOADING
              : (value.board.find((section) => section.stage === stage)?.rows ?? [])
          },
          { equals: compareShallow },
        )
        return computed((): MobileTaskSection | typeof LOADING => {
          const value = rows.get()
          if (value === LOADING) return LOADING
          return { stage, title: ISSUE_STATUS_LABELS[stage], rows: value }
        })
      })
      const board = computed(
        () => {
          const result = sections.map((section) => section.get())
          if (result.some((section) => section === LOADING)) return LOADING
          return (result as MobileTaskSection[]).filter((section) => section.rows.length)
        },
        { equals: compareShallow },
      )
      return screenSnapshot(
        data,
        ['issues', 'sessions', 'board', 'workingByIssue', 'progressByIssue', 'proposals'],
        { board },
      )
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
    const parent = (id: string) => pool.graph.one('issue', id, 'treeParent') ?? issue(id)?.parentId
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
        readLegacyBoardCard(pool, { id: row.issue.id, agents: options.showAgentTasks }),
      )
      if (!card) throw LOADING
      workingByIssue.set(
        row.issue.id,
        confirmedWorkingAgentCount(card.fleet, pool.clock.trackedNow()),
      )
      progressByIssue.set(
        row.issue.id,
        taskProgress(
          JSON.stringify({
            id: row.issue.id,
            now: pool.clock.trackedNow(),
            agents: options.showAgentTasks,
          }),
        ),
      )
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
      sessions: [...sessions.values()].sort(
        (a, b) =>
          Date.parse(a.createdAt) - Date.parse(b.createdAt) || byId(a.sessionId, b.sessionId),
      ),
      board,
      workingByIssue,
      progressByIssue,
      proposals: proposalCount,
    }
  }
  return {
    tasks,
    dispose() {
      disposed = true
      cache.clear()
      taskRows.clear()
      taskProgress.clear()
    },
  }
}
