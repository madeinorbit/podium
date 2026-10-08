import type { IssueViewModel } from '@podium/client-core/replica'
import type { ModelOf } from './models'
import type { BoardFilter, IssuesOrdering } from '@podium/client-core/values'
import { orderIssues } from '@podium/client-core/values'
import { asIssueId, ISSUE_STATUS_LABELS, isFinished } from '@podium/model/browser'
import { lazy } from '@podium/mobx-helpers'
import { action, observable, observableRef } from 'mobx'
import type { BoardListRow, BoardQuery } from './issue-board-schema'
import { MOBILE_TASK_STAGES, type MobileTasksOptions } from './mobile-screens-schema'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

export type MobileTaskIssue = ModelOf['issue'] & Readonly<Pick<IssueViewModel, 'type' | 'priority'>>

export interface MobileTaskIds {
  readonly stage: (typeof MOBILE_TASK_STAGES)[number]
  readonly title: string
  readonly total: number
  readonly rows: readonly BoardListRow[]
}
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const requireRow = <T>(row: Loaded<T>): T | undefined => {
  if (row === LOADING) throw LOADING
  return row
}

/** The phone board's UI state and ID membership. Entity facts stay on the shared
 * models; placement borrows the desktop board's declared query/scalar caches. */
export class MobileTasksBoard {
  @observable accessor showDone: boolean
  @observableRef accessor expanded: readonly string[]
  @observableRef accessor filter: BoardFilter
  @observable accessor ordering: IssuesOrdering
  @observable accessor showAgentTasks: boolean

  constructor(
    readonly pool: MobxPool,
    options: MobileTasksOptions,
  ) {
    this.showDone = options.showDone
    this.expanded = options.expanded
    this.filter = options.filter
    this.ordering = options.ordering
    this.showAgentTasks = options.showAgentTasks
  }

  @action configure(options: MobileTasksOptions) {
    this.showDone = options.showDone
    this.expanded = options.expanded
    this.filter = options.filter
    this.ordering = options.ordering
    this.showAgentTasks = options.showAgentTasks
  }

  issue(id: string): MobileTaskIssue {
    return this.pool.issueObject(id) as MobileTaskIssue
  }

  private query(options: BoardQuery): readonly string[] {
    const value = requireRow(this.pool.row('issueBoardQuery', JSON.stringify(options)))
    if (!value) throw LOADING
    return value.ids
  }

  private position(id: string, ordering: IssuesOrdering = this.ordering) {
    return requireRow(this.pool.row('issueBoardPosition', JSON.stringify([id, ordering])))
  }

  private parent(id: string): string | undefined {
    return this.position(id)?.parentId
  }

  private screenable(id: string): boolean {
    const scope = this.pool.queries.issueScope(id)
    return Boolean(
      scope &&
        !scope.archived &&
        !scope.deleted &&
        !scope.draft &&
        !scope.agent &&
        this.position(id)?.stage === 'proposed',
    )
  }

  private audience(id: string): boolean {
    const scope = this.pool.queries.issueScope(id)
    if (!scope || (scope.draft && !scope.deleted)) return false
    if (this.showAgentTasks || scope.deleted || !scope.agent) return true
    const seen = new Set([id])
    let next = this.parent(id)
    while (next && !seen.has(next)) {
      seen.add(next)
      const ancestor = this.pool.queries.issueScope(next)
      if (!ancestor || (ancestor.draft && !ancestor.deleted)) return false
      if (ancestor.deleted || !ancestor.agent) return true
      next = this.parent(next)
    }
    return false
  }

  private underProposal(id: string, scope?: ReadonlySet<string>): boolean {
    const seen = new Set([id])
    let next = this.parent(id)
    while (next && !seen.has(next) && (!scope || scope.has(next))) {
      seen.add(next)
      if (this.position(next)?.stage === 'proposed') return true
      next = this.parent(next)
    }
    return false
  }

  private children(id: string, scope: ReadonlySet<string>): string[] {
    return [...this.pool.graph.many('issue', id, 'treeChildren')]
      .sort(byId)
      .filter((child) => child !== id && scope.has(child))
  }

  private ordered(ids: readonly string[]): string[] {
    const positions = ids.flatMap((id) => {
      const row = this.position(id)
      return row ? [row] : []
    })
    return orderIssues(positions, this.ordering).map((row) => row.id)
  }

  /** Membership and proposal promotion do not depend on expansion or session facts. */
  @lazy private get hierarchy() {
    const eligible = (id: string) =>
      this.audience(id) && (this.showDone || !isFinished(this.position(id) ?? {}))
    const matched = new Set(
      this.query({
        kind: 'board',
        filter: this.filter,
        showAgentTasks: this.showAgentTasks,
      }).filter((id) => eligible(id)),
    )
    const retained = new Set(matched)
    for (const id of matched) {
      const seen = new Set([id])
      let next = this.parent(id)
      while (next && !seen.has(next)) {
        seen.add(next)
        if (!eligible(next)) break
        retained.add(next)
        next = this.parent(next)
      }
    }
    const scoped = [...retained].sort(byId)
    const promoted = new Set(
      scoped.filter(
        (id) =>
          this.screenable(id) &&
          this.parent(id) &&
          matched.has(id) &&
          !this.underProposal(id, retained),
      ),
    )
    const ordinary = new Set(
      scoped.filter((id) => {
        const seen = new Set<string>()
        let next: string | undefined = id
        while (next && retained.has(next) && !seen.has(next)) {
          if (promoted.has(next)) return false
          seen.add(next)
          next = this.parent(next)
        }
        return true
      }),
    )
    const roots = [...ordinary].filter((id) => {
      const parent = this.parent(id)
      return !parent || parent === id || !ordinary.has(parent)
    })
    const reached = new Set<string>()
    const reach = (id: string) => {
      const stack = [id]
      while (stack.length) {
        const next = stack.pop()!
        if (reached.has(next)) continue
        reached.add(next)
        stack.push(...this.children(next, ordinary))
      }
    }
    for (const id of roots) reach(id)
    for (const id of ordinary)
      if (!reached.has(id)) {
        roots.push(id)
        reach(id)
      }
    return { retained, ordinary, roots, promoted }
  }

  @lazy get sections(): readonly MobileTaskIds[] | typeof LOADING {
    try {
      const { retained, ordinary, roots, promoted } = this.hierarchy
      const expanded = new Set(this.expanded)
      const emit = (
        id: string,
        depth: number,
        scope: ReadonlySet<string>,
        out: BoardListRow[],
        path: ReadonlySet<string>,
        listed?: Set<string>,
      ) => {
        if (path.has(id) || listed?.has(id)) return
        listed?.add(id)
        const kids = this.children(id, scope),
          open = kids.length > 0 && expanded.has(id)
        out.push({ id: asIssueId(id), depth, childCount: kids.length, expanded: open })
        if (open)
          for (const child of this.ordered(kids))
            emit(child, depth + 1, scope, out, new Set(path).add(id), listed)
      }
      const sections = MOBILE_TASK_STAGES.map((stage) => {
        const rows: BoardListRow[] = []
        for (const id of this.ordered(roots.filter((id) => this.position(id)?.stage === stage)))
          emit(id, 0, ordinary, rows, new Set())
        return { stage, title: ISSUE_STATUS_LABELS[stage], rows, total: 0 }
      })
      const listed = new Set(sections.flatMap((section) => section.rows.map((row) => row.id)))
      const proposals = sections.find((section) => section.stage === 'proposed')!
      const blocks: BoardListRow[][] = []
      for (const row of proposals.rows) {
        if (!row.depth || !blocks.length) blocks.push([row])
        else blocks[blocks.length - 1]!.push(row)
      }
      // The legacy phone promotes proposals in descending sequence order before
      // stable board ordering; equal created/updated dates keep that order.
      const promotionOrder = [...promoted].sort((a, b) => {
        const left = this.position(a, 'priority')!,
          right = this.position(b, 'priority')!
        return left.priority - right.priority || right.seq - left.seq
      })
      for (const id of promotionOrder) {
        const block: BoardListRow[] = []
        emit(id, 0, retained, block, new Set(), listed)
        if (block.length) blocks.push(block)
      }
      const blockById = new Map(blocks.map((block) => [block[0]!.id as string, block]))
      proposals.rows = this.ordered(blocks.map((block) => block[0]!.id)).flatMap(
        (id) => blockById.get(id)!,
      )
      for (const section of sections)
        section.total = section.rows.filter((row) => row.depth === 0).length
      return sections.filter((section) => section.rows.length)
    } catch (error) {
      if (error === LOADING) return LOADING
      throw error
    }
  }

  /** A separate declared question: board filters/folds never wake the banner. */
  @lazy get proposals(): number | typeof LOADING {
    try {
      let total = 0
      for (const id of this.query({
        kind: 'board',
        filter: { stage: 'proposed' },
        showAgentTasks: true,
      }))
        if (this.screenable(id) && !this.underProposal(id)) total++
      return total
    } catch (error) {
      if (error === LOADING) return LOADING
      throw error
    }
  }
}
