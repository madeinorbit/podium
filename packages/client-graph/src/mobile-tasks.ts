import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { ISSUES_DISPLAY_KEY } from '@podium/client-core/ui-state'
import type { BoardFilter, IssueNavigationModel, IssuesOrdering } from '@podium/client-core/values'
import {
  clearChip,
  filterChips,
  issueNeedsHuman,
  orderIssues,
  readSharedIssuesDisplay,
} from '@podium/client-core/values'
import { companion, lazy } from '@podium/mobx-helpers'
import { asIssueId, ISSUE_STATUS_LABELS, isFinished } from '@podium/model/browser'
import { action, compareShallow, compareStructural, observable, observableRef } from 'mobx'
import type { BoardListRow, BoardQuery } from './issue-board-schema'
import { omitGone } from './lookup'
import { MOBILE_TASK_STAGES, type MobileTasksOptions } from './mobile-screens-schema'
import { ProposalQueue } from './mobile-triage'
import type { IssueModel, ModelOf } from './models'
import type { MobxPool } from './pool'
import { firstResidentChildMatch } from './resident-child-match'
import { RowWindow } from './row-window'
import { LOADING, type Loaded } from './worklist/rollup'
import { worklistView } from './worklist/view-model'

export type MobileTaskIssue = ModelOf['issue'] &
  Readonly<Pick<IssueViewModel, 'type' | 'priority' | 'stage' | 'closedReason'>>

export interface MobileTaskIds {
  readonly stage: (typeof MOBILE_TASK_STAGES)[number]
  readonly title: string
  readonly total: number
  readonly rows: readonly BoardListRow[]
}
type Stage = MobileTaskIds['stage']

export { ROW_WINDOW_SIZE as MOBILE_TASK_WINDOW_SIZE } from './row-window'
export type TaskRowMark = 'needs' | 'working' | 'resting' | 'done'

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const requireRow = <T>(row: Loaded<T>): T | undefined => {
  if (row === LOADING) throw LOADING
  return row
}
const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'cancelled',
  'duplicate',
  'superseded',
])
/** A filter that asks for closed work shows done work whatever the toggle says. */
export const filterShowsDone = (filter: BoardFilter): boolean =>
  filter.status === 'closed' || (filter.stage !== undefined && CLOSED_STATUSES.has(filter.stage))

/** The phone board's rules about one issue. Facts about the issue itself stay
 * on its shared model; these answers depend on the board's options and on
 * where the issue sits in the board's tree. A missing placement row throws
 * LOADING, which the board's lists turn into their LOADING answer. */
class BoardTask {
  constructor(
    readonly issue: IssueModel,
    private readonly board: MobileTasksBoard,
  ) {}

  get id(): string {
    return this.issue.id
  }

  // --- Placement (the board's cold-safe position row)

  @lazy get parentId(): string | undefined {
    return this.board.position(this.id)?.parentId ?? undefined
  }

  @lazy get stage(): string | undefined {
    return this.board.position(this.id)?.stage
  }

  @lazy get finished(): boolean {
    return isFinished(this.board.position(this.id) ?? {})
  }

  /** Ancestors nearest first, ending before a parent cycle closes. */
  @lazy({ equals: compareShallow }) get ancestors(): readonly string[] {
    const ids: string[] = []
    const seen = new Set([this.id])
    for (let next = this.parentId; next && !seen.has(next); next = this.board.task(next).parentId) {
      seen.add(next)
      ids.push(next)
    }
    return ids
  }

  /** The task has a conversation to open: an unarchived session on its
   *  roster. A tap on a seated task opens the chat, any other its details
   *  (POD-2432). */
  @lazy get seated(): boolean {
    return this.board.pool.graph.subsetSize('issue', this.id, 'missionSessions', 'unarchived') > 0
  }

  /** The board glyph follows the same attention rule as Work and the deck. */
  @lazy get mark(): TaskRowMark {
    if (this.finished) return 'done'
    const sessions = [
      ...this.board.pool.graph.subset('issue', this.id, 'missionSessions', 'unarchived'),
    ].flatMap((id) => {
      const session = requireRow(omitGone(this.board.pool.row('session', id, 'summary-fields')))
      return session ? [session as unknown as SessionView] : []
    })
    if (issueNeedsHuman(this.issue as unknown as IssueNavigationModel, sessions)) return 'needs'
    return this.stage === 'in_progress' ? 'working' : 'resting'
  }

  /** The desktop Work row's accepted-leaf count, shared with the flight deck. */
  get progress() {
    return worklistView(this.board.pool).row(this.issue).progress
  }

  // --- Audience and proposals (board options never reach these)

  /** Who the issue is for: not shown at all, a person's task, or agent work. */
  @lazy get audienceKind(): 'none' | 'human' | 'agent' {
    const scope = this.board.pool.queries.issueScope(this.id)
    if (!scope || (scope.draft && !scope.deleted)) return 'none'
    return scope.deleted || !scope.agent ? 'human' : 'agent'
  }

  /** A proposal waiting for the operator's decision. */
  @lazy get screenable(): boolean {
    const scope = this.board.pool.queries.issueScope(this.id)
    return Boolean(
      scope &&
        !scope.archived &&
        !scope.deleted &&
        !scope.draft &&
        !scope.agent &&
        this.stage === 'proposed',
    )
  }

  // --- Membership under the board's options

  /** Agent work shows when the option asks for it, or under a person's task. */
  @lazy get audience(): boolean {
    const kind = this.audienceKind
    if (kind === 'none') return false
    if (kind === 'human' || this.board.showAgentTasks) return true
    for (const id of this.ancestors) {
      const ancestor = this.board.task(id).audienceKind
      if (ancestor !== 'agent') return ancestor === 'human'
    }
    return false
  }

  @lazy get eligible(): boolean {
    return this.audience && (this.board.includesDone || !this.finished)
  }

  @lazy get matched(): boolean {
    return this.board.matched.has(this.id)
  }

  @lazy get retained(): boolean {
    return this.board.retained.has(this.id)
  }

  /** A matched proposal with a parent, not inside another shown proposal: it
   * leads its own block in the proposals lane instead of hiding under the epic. */
  @lazy get promoted(): boolean {
    if (!this.screenable || !this.parentId || !this.matched) return false
    for (const id of this.ancestors) {
      const ancestor = this.board.task(id)
      if (!ancestor.retained) break
      if (ancestor.stage === 'proposed') return false
    }
    return true
  }

  /** Shown in the ordinary tree: shown, and no promoted proposal at or above it. */
  @lazy get ordinary(): boolean {
    if (!this.retained || this.promoted) return false
    for (const id of this.ancestors) {
      const ancestor = this.board.task(id)
      if (!ancestor.retained) break
      if (ancestor.promoted) return false
    }
    return true
  }

  /** Heads the ordinary tree: its parent is absent, itself or not in the tree. */
  @lazy get naturalRoot(): boolean {
    const parent = this.parentId
    return this.ordinary && (!parent || parent === this.id || !this.board.task(parent).ordinary)
  }

  /** Reached from a natural root; only members of a parent cycle are not. */
  @lazy get reached(): boolean {
    return this.naturalRoot || this.ancestors.some((id) => this.board.task(id).naturalRoot)
  }

  // --- Row placement

  /** The children drawn under it, by ID: ordinary ones in the ordinary tree,
   * every shown one inside a promoted proposal's block. */
  @lazy({ equals: compareShallow }) get childIds(): readonly string[] {
    const ordinary = this.ordinary
    return [...this.board.pool.graph.many('issue', this.id, 'treeChildren')]
      .sort(byId)
      .filter((id) => {
        if (id === this.id) return false
        const child = this.board.task(id)
        return ordinary ? child.ordinary : child.retained
      })
  }

  @lazy({ equals: compareShallow }) get orderedChildIds(): readonly string[] {
    return this.board.ordered(this.childIds)
  }

  @lazy get expanded(): boolean {
    return this.childIds.length > 0 && this.board.expanded.includes(this.id)
  }

  /** A collapsed search result names the matching child using Work's resident walk. */
  @lazy get childHit(): string | null {
    if (!this.board.searching || this.expanded) return null
    return firstResidentChildMatch(
      this.board.pool,
      this.id,
      (issue) => this.board.task(issue.id).matched,
    )
  }

  @lazy get depth(): number {
    if (this.promoted || this.board.roots.has(this.id)) return 0
    const parent = this.parentId
    return parent ? this.board.task(parent).depth + 1 : 0
  }

  @lazy({ equals: compareShallow }) get row(): BoardListRow {
    return {
      id: asIssueId(this.id),
      depth: this.depth,
      childCount: this.childIds.length,
      expanded: this.expanded,
    }
  }
}

/** One lane of the board: its own tasks and the rows drawn for them. */
class BoardLane {
  readonly window = new RowWindow(
    () => this.rows,
    (row) => row.id,
  )

  constructor(
    readonly stage: Stage,
    private readonly board: MobileTasksBoard,
  ) {}

  /** The lane's own tasks in board order; the proposals lane also holds every
   * promoted proposal. */
  @lazy({ equals: compareShallow }) get rootIds(): readonly string[] {
    const roots = this.board.ordered(
      this.board.rootIds.filter((id) => this.board.task(id).stage === this.stage),
    )
    if (this.stage !== 'proposed' || !this.board.promotedIds.length) return roots
    // The old phone promoted proposals in descending sequence order before the
    // stable board order, so equal created/updated dates keep that order.
    const promoted = [...this.board.promotedIds].sort((a, b) => {
      const left = this.board.position(a)!,
        right = this.board.position(b)!
      return left.priority - right.priority || right.seq - left.seq
    })
    return this.board.ordered([...roots, ...promoted])
  }

  @lazy({ equals: compareShallow }) get rows(): readonly BoardListRow[] {
    const rows: BoardListRow[] = []
    const path = new Set<string>()
    const emit = (id: string) => {
      if (path.has(id)) return
      const task = this.board.task(id)
      rows.push(task.row)
      if (!task.expanded) return
      path.add(id)
      for (const child of task.orderedChildIds) emit(child)
      path.delete(id)
    }
    for (const id of this.rootIds) emit(id)
    return rows
  }

  @lazy({ equals: compareShallow }) get value(): MobileTaskIds {
    return {
      stage: this.stage,
      title: ISSUE_STATUS_LABELS[this.stage],
      total: this.rootIds.length,
      rows: this.rows,
    }
  }
}

/** The phone Tasks view model: the board's options, its ID lists and the
 * proposal count. Entity facts stay on the shared models; placement borrows
 * the desktop board's declared query and position rows. */
export class MobileTasksBoard {
  // --- Options (the view's own state)

  /** The Show-done toggle. */
  @observable accessor showDone: boolean
  /** Parents showing their children. Local to this view, as the desktop board
   * holds it, not replicated ui-state: expanding an epic is a look, not a
   * preference, and the desk and the phone look at different things. */
  @observableRef accessor expanded: readonly string[]
  /** The filter sheet's choices. */
  @observableRef accessor filter: BoardFilter
  /** The search field's text. */
  @observable accessor query = ''
  // Explicit options configure standalone boards. The app board omits these
  // so its display follows the existing pooled preference, even before focus.
  @observable private accessor orderingOverride: IssuesOrdering | undefined
  @observable private accessor showAgentTasksOverride: boolean | undefined

  constructor(
    readonly pool: MobxPool,
    options: MobileTasksOptions,
  ) {
    this.showDone = options.showDone
    this.expanded = options.expanded
    this.filter = options.filter
    this.orderingOverride = options.ordering
    this.showAgentTasksOverride = options.showAgentTasks
  }

  @action configure(options: MobileTasksOptions) {
    this.showDone = options.showDone
    this.expanded = options.expanded
    this.filter = options.filter
    this.query = ''
    this.orderingOverride = options.ordering
    this.showAgentTasksOverride = options.showAgentTasks
  }

  @action toggleShowDone() {
    this.showDone = !this.showDone
  }

  @action toggleExpanded(id: string) {
    this.expanded = this.expanded.includes(id)
      ? this.expanded.filter((open) => open !== id)
      : [...this.expanded, id]
  }

  @action search(text: string) {
    this.query = text
  }

  @action setFilter(filter: BoardFilter) {
    this.filter = filter
  }

  @action clearFilter(key: keyof BoardFilter) {
    this.filter = clearChip(this.filter, key)
  }

  @lazy private get display() {
    const row = requireRow(omitGone(this.pool.row('preference', ISSUES_DISPLAY_KEY)))
    return readSharedIssuesDisplay(row?.value ?? null)
  }

  @lazy get ordering(): IssuesOrdering {
    return this.orderingOverride ?? this.display.ordering
  }

  @lazy get showAgentTasks(): boolean {
    return this.showAgentTasksOverride ?? this.display.showAgentTasks
  }

  /** The filter the lists use: the sheet's choices plus the search text. */
  @lazy({ equals: compareStructural }) get searchFilter(): BoardFilter {
    return this.query.trim() ? { ...this.filter, text: this.query } : this.filter
  }

  /** Search results stay visible without rewriting the user's saved folds. */
  @lazy get searching(): boolean {
    return Boolean(this.searchFilter.text?.trim())
  }

  /** Search holds groups open; header taps must not change saved preferences. */
  isFolded(saved: boolean): boolean {
    return saved && !this.searching
  }

  @action toggleFold(toggleSaved: () => void): void {
    if (!this.searching) toggleSaved()
  }

  @lazy({ equals: compareStructural }) get chips() {
    return filterChips(this.filter)
  }

  /** Done work shows when toggled on, or when the filter asks for closed work. */
  @lazy get includesDone(): boolean {
    return this.showDone || filterShowsDone(this.searchFilter)
  }

  // --- Records

  issue(id: string): MobileTaskIssue {
    return this.pool.issueObject(id) as MobileTaskIssue
  }

  /** This board's rules about one issue. */
  readonly rules = companion((issue: IssueModel) => new BoardTask(issue, this))

  task(id: string): BoardTask {
    return this.rules(this.pool.issueObject(id))
  }

  position(id: string, ordering: IssuesOrdering = 'priority') {
    return requireRow(omitGone(this.pool.row('issueBoardPosition', JSON.stringify([id, ordering]))))
  }

  private boardQuery(options: BoardQuery): readonly string[] {
    const value = requireRow(omitGone(this.pool.row('issueBoardQuery', JSON.stringify(options))))
    if (!value) throw LOADING
    return value.ids
  }

  /** IDs in the board's chosen order; an ID without a position row drops out. */
  ordered(ids: readonly string[]): string[] {
    const positions = ids.flatMap((id) => {
      const row = this.position(id, this.ordering)
      return row ? [row] : []
    })
    return orderIssues(positions, this.ordering).map((row) => row.id)
  }

  // --- Membership lists (none depends on folds or session facts)

  /** The filter's matches that this board shows. */
  @lazy({ equals: compareShallow }) get matchedIds(): readonly string[] {
    return this.boardQuery({
      kind: 'board',
      filter: this.searchFilter,
      showAgentTasks: this.showAgentTasks,
    }).filter((id) => this.task(id).eligible)
  }

  /** The matches and the shown ancestors that carry them, by ID. */
  @lazy({ equals: compareShallow }) get retainedIds(): readonly string[] {
    const ids = new Set(this.matchedIds)
    for (const id of this.matchedIds)
      for (const ancestor of this.task(id).ancestors) {
        if (!this.task(ancestor).eligible) break
        ids.add(ancestor)
      }
    return [...ids].sort(byId)
  }

  @lazy({ equals: compareShallow }) get promotedIds(): readonly string[] {
    return this.retainedIds.filter((id) => this.task(id).promoted)
  }

  /** The heads of the ordinary tree. A parent cycle has no natural head: its
   * first unreached member by ID heads it, and everything under that member
   * counts as reached. */
  @lazy({ equals: compareShallow }) get rootIds(): readonly string[] {
    const roots: string[] = []
    const cyclic: string[] = []
    for (const id of this.retainedIds) {
      const task = this.task(id)
      if (task.naturalRoot) roots.push(id)
      else if (task.ordinary && !task.reached) cyclic.push(id)
    }
    const covered = new Set<string>()
    for (const id of cyclic) {
      if (covered.has(id)) continue
      roots.push(id)
      for (const stack = [id]; stack.length; ) {
        const next = stack.pop()!
        if (covered.has(next)) continue
        covered.add(next)
        stack.push(...this.task(next).childIds)
      }
    }
    return roots
  }

  // Membership sets for the per-issue rules, derived from the lists above.
  @lazy get matched(): ReadonlySet<string> {
    return new Set(this.matchedIds)
  }
  @lazy get retained(): ReadonlySet<string> {
    return new Set(this.retainedIds)
  }
  @lazy get roots(): ReadonlySet<string> {
    return new Set(this.rootIds)
  }

  // --- What the screen draws

  readonly lanes: readonly BoardLane[] = MOBILE_TASK_STAGES.map(
    (stage) => new BoardLane(stage, this),
  )

  @lazy({ equals: compareShallow }) get sections(): readonly MobileTaskIds[] | typeof LOADING {
    try {
      return this.lanes.filter((lane) => lane.rows.length).map((lane) => lane.value)
    } catch (error) {
      if (error === LOADING) return LOADING
      throw error
    }
  }

  /**
   * The groups the phone draws: the non-empty lanes, plus a Proposed group
   * whenever proposals wait for screening, even if the board's filter hides
   * every one of them. Its total is the screening queue's count, not the
   * lane's: the group is the way into the screening deck.
   */
  @lazy({ equals: compareShallow }) get groups(): readonly MobileTaskIds[] | typeof LOADING {
    const sections = this.sections
    const proposals = this.proposals
    if (sections === LOADING || proposals === LOADING) return LOADING
    const lane = sections.find((section) => section.stage === 'proposed')
    // Nothing to screen: the lane (if any) keeps its own count.
    if (proposals === 0) return sections
    const group: MobileTaskIds = {
      stage: 'proposed',
      title: ISSUE_STATUS_LABELS.proposed,
      total: proposals,
      rows: lane?.rows ?? [],
    }
    const rest = sections.filter((section) => section !== lane)
    const at = rest.findIndex(
      (section) =>
        MOBILE_TASK_STAGES.indexOf(section.stage) > MOBILE_TASK_STAGES.indexOf('proposed'),
    )
    return at < 0 ? [...rest, group] : [...rest.slice(0, at), group, ...rest.slice(at)]
  }

  /** How many tasks each lane holds — its roots, the count the group header
   * shows. The Tasks subtitle reads In Progress and Review from here. */
  @lazy({ equals: compareStructural }) get stageCounts():
    | Readonly<Record<Stage, number>>
    | typeof LOADING {
    try {
      const counts = {} as Record<Stage, number>
      for (const lane of this.lanes) counts[lane.stage] = lane.rootIds.length
      return counts
    } catch (error) {
      if (error === LOADING) return LOADING
      throw error
    }
  }

  /** The count and the opened deck share this selection, ignoring other board filters. */
  @lazy private get screening() {
    return new ProposalQueue(this.pool, this.searchFilter.text ?? '')
  }
  @lazy({ equals: compareShallow }) get screeningIds() {
    return this.screening.queue
  }

  @lazy get proposals(): number | typeof LOADING {
    const ids = this.screeningIds
    return ids === LOADING ? LOADING : (ids?.length ?? 0)
  }
}
