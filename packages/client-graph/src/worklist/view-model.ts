import { here, omitGone } from '../lookup'
import { observable, observableRef, action } from 'mobx'
import { lazy, companion } from '@podium/mobx-helpers'
import type { IssueModel, ModelHost, ModelOf, SessionModel } from '../models'
import type { MobxPool } from '../pool'
import type { LocalsKey, SliceLocals } from '../shared/slice-types'
import { worklistGroups } from './groups'
import { WorklistIssue } from './issue'
import { WorklistSession } from './session'
import { WorklistWorktree } from './worktree'
import { SidebarIndex, type SidebarState } from './sidebar'
import { MobileSectionsView, type MobileWorkState, type MobileWorkRef } from './mobile'
import { LOADING, type RollupInputs, type RollupParts } from './rollup'

/** One view of the worklist, drawn by the desktop sidebar and phone Work tab. */
export class Worklist {
  readonly row: (issue: IssueModel) => WorklistIssue = companion(issue => new WorklistIssue(issue, this))
  readonly session: (session: SessionModel) => WorklistSession = companion(session => new WorklistSession(session))
  readonly tree: (tree: ModelOf['worktree']) => WorklistWorktree = companion(tree => new WorklistWorktree(tree, this))
  @observable accessor selectedId: string | null = null
  @observable accessor selectedWasFolded = false

  @lazy get selectionGone(): boolean {
    if (this.selectedId === null) return false
    try { return this.pool.issueObject(this.selectedId).exitKind !== undefined }
    catch (error) { if (error === LOADING) return false; throw error }
  }
  @observableRef accessor layout: SidebarState = {}
  readonly host: ModelHost
  readonly desktop: SidebarIndex
  readonly rowInputs: RollupInputs = {
    reached: at => this.pool.rollupInputs.reached!(at),
    loadedIssue: id => this.pool.rollupInputs.loadedIssue(id),
    spinOffCount: id => this.pool.rollupInputs.spinOffCount(id),
    nested: id => this.row(this.pool.issueObject(id)).visibleDescendantIds,
    formalChildren: id => this.pool.rollupInputs.formalChildren(id),
    rollupNode: (id): RollupParts | undefined => this.knownRow(id)?.visibleParts,
    seat: id => this.pool.rollupInputs.seat(id),
    seatActivity: id => this.pool.rollupInputs.seatActivity(id),
    spinOffIds: id => this.pool.rollupInputs.spinOffIds(id),
  }
  readonly mobileSectionsView: MobileSectionsView

  constructor(readonly pool: MobxPool) {
    this.host = pool
    this.desktop = new SidebarIndex(this)
    this.mobileSectionsView = new MobileSectionsView(pool)
  }

  @action select(id: string | null): void {
    if (id === this.selectedId) return
    this.selectedWasFolded = id !== null && worklistGroups(this.pool).placementOf(id)?.closed === true
    this.selectedId = id
  }

  @action setLayout(layout: SidebarState): void { this.layout = layout }
  @action setFolded(folded: boolean): void { this.selectedWasFolded = folded }

  /** Standalone replay sources can supply selection. Runtime selection is
   * adopted by the worklist instead, and that source carries only the clock. */
  @action applyLocals(locals: SliceLocals, changed: ReadonlySet<LocalsKey>): void {
    if (changed.has('selectedIssueId')) this.select(locals.selectedIssueId)
    if (changed.has('selectedIssueWasFolded')) this.setFolded(locals.selectedIssueWasFolded === true)
  }
  sections(state: SidebarState = this.layout) { return this.desktop.sections(state) }
  mobileSections() { return this.mobileSectionsView }
  desktopRow(id: string) { return this.desktop.row(id) }
  mobileRow(ref: Pick<MobileWorkRef, 'id' | 'kind'>): WorklistIssue | WorklistWorktree | typeof LOADING | undefined {
    if (ref.kind === 'issue') {
      const issue = here(this.pool.issue(ref.id))
      if (!issue) return omitGone(this.pool.row('issue', ref.id)) === LOADING ? LOADING : undefined
      const row = this.row(issue), ready = row.ready
      return ready === 'ready' ? row : ready
    }
    if (omitGone(this.pool.row('worktree', ref.id)) === LOADING) return LOADING
    const tree = here(this.pool.model('worktree', ref.id))
    if (!tree) return undefined
    const row = this.tree(tree), ready = row.ready
    return ready === 'ready' ? row : ready
  }

  knownRow(id: string): WorklistIssue | undefined {
    return this.pool.tables.issue.has(id) || this.pool.residency?.known('issue', id) === true
      ? this.row(this.pool.issueObject(id)) : undefined
  }
}

export function worklistView(pool: MobxPool): Worklist {
  return pool.sources.view('worklist.view', () => new Worklist(pool))
}
