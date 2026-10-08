import { observable, observableRef, action, reaction, compareStructural } from 'mobx'
import { companion } from '@podium/mobx-helpers'
import type { IssueModel, ModelHost, ModelOf, SessionModel } from '../models'
import type { MobxPool } from '../pool'
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
  // Native list keys are identity-only UI targets, shared across layout
  // projections. They have no reactive inputs and hold no record facts.
  private readonly references = companion((record: IssueModel | ModelOf['worktree']) => {
    const kind = record.entity as MobileWorkRef['kind']
    return {
      normal: { id: record.id, kind, listKey: record.id },
      attention: { id: record.id, kind, listKey: `needs-you:${record.id}` },
    }
  })
  readonly selection = observable.map<string, true>(undefined, { deep: false })
  readonly foldLatch = observable.box(false)
  private seenSelected: string | null = null
  private readonly evicted = observable.box(false)
  private readonly stopSelection: () => void
  @observable accessor selectedId: string | null = null
  @observableRef accessor layout: SidebarState = {}
  readonly host: ModelHost
  readonly desktop: SidebarIndex
  readonly phone = {
    row: (ref: Pick<MobileWorkRef, 'id' | 'kind'>) => this.mobileRow(ref),
    sections: (state?: MobileWorkState) => this.mobileSections(state),
  }
  readonly rowInputs: RollupInputs = {
    reached: at => this.pool.rollupInputs.reached!(at),
    loadedIssue: id => this.pool.rollupInputs.loadedIssue(id),
    spinOffCount: id => this.pool.rollupInputs.spinOffCount(id),
    nested: id => this.row(this.pool.issueObject(id)).rowNested,
    formalChildren: id => this.pool.rollupInputs.formalChildren(id),
    rollupNode: (id): RollupParts | undefined => this.knownRow(id)?.rowParts,
    seat: id => this.pool.rollupInputs.seat(id),
    seatActivity: id => this.pool.rollupInputs.seatActivity(id),
    spinOffIds: id => this.pool.rollupInputs.spinOffIds(id),
  }
  private readonly mobileLayout = companion((state: MobileWorkState) => new MobileSectionsView(this.pool, state))

  constructor(readonly pool: MobxPool) {
    this.host = pool
    this.desktop = new SidebarIndex(this)
    this.stopSelection = reaction(
      () => {
        const id = this.selection.keys().next().value ?? null
        return { id, resident: id === null ? null : pool.resident('issue', id) }
      },
      ({ id, resident }) => {
        if (id !== this.seenSelected) this.seenSelected = null
        if (id !== null && resident !== 'absent') this.seenSelected = id
        this.evicted.set(id !== null && resident === 'absent' && this.seenSelected === id)
      },
      { fireImmediately: true, equals: compareStructural },
    )
  }

  @action select(id: string | null): void {
    if (id === this.selectedId) return
    if (this.selectedId !== null) this.selection.delete(this.selectedId)
    if (id !== null) this.selection.set(id, true)
    this.selectedId = id
  }

  @action setLayout(layout: SidebarState): void { this.layout = layout }
  @action setFolded(folded: boolean): void { this.foldLatch.set(folded) }
  get selectionEvicted(): boolean { return this.evicted.get() }
  sections(state: SidebarState = this.layout) { return this.desktop.sections(state) }
  mobileSections(state: MobileWorkState = this.layout) { return this.mobileLayout(state).value.get() }
  desktopRow(id: string) { return this.desktop.row(id) }
  reference(id: string, kind: MobileWorkRef['kind'] = 'issue', attention = false): MobileWorkRef {
    const record = kind === 'issue' ? this.pool.issueObject(id) : this.pool.model('worktree', id)
    return record ? this.references(record)[attention ? 'attention' : 'normal']
      : { id, kind, listKey: attention ? `needs-you:${id}` : id }
  }
  mobileRow(ref: Pick<MobileWorkRef, 'id' | 'kind'>) {
    if (ref.kind === 'issue') {
      const issue = this.pool.issue(ref.id)
      return issue === undefined ? this.pool.row('issue', ref.id) === LOADING ? LOADING : undefined
        : this.row(issue).mobile
    }
    if (this.pool.row('worktree', ref.id) === LOADING) return LOADING
    const tree = this.pool.model('worktree', ref.id)
    return tree === undefined ? undefined : this.tree(tree).mobile
  }
  dispose() { this.stopSelection() }

  knownRow(id: string): WorklistIssue | undefined {
    return this.pool.tables.issue.has(id) || this.pool.residency?.known('issue', id) === true
      ? this.row(this.pool.issueObject(id)) : undefined
  }
}

export function worklistView(pool: MobxPool): Worklist {
  return pool.sources.view('worklist.view', () => new Worklist(pool))
}
