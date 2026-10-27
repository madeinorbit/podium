import { omitGone } from '../lookup'
import { createQueryResult, concatQueryResults } from '../query-result'
import { compareRank } from '../shared/row-view'
import { worklistGroups } from './groups'
import { lazy } from '@podium/mobx-helpers'
/** Phone bands over the existing resident root indexes. No second runtime,
 * row copies or new filing reactions. */
import { compareShallow } from 'mobx'
import type { MobxPool } from '../pool'
import { worklistView } from './view-model'
import { LOADING } from './rollup'
import { sidebarView, type SidebarState } from './sidebar'

export interface MobileWorkState extends SidebarState {
  /** Search overrides folds; text matching stays in the native UI. */
  readonly searching?: boolean
}
export interface MobileWorkRef {
  readonly id: string
  readonly listKey: string
}
export interface MobileWorkSection {
  readonly key: string
  readonly label: string
  readonly kind: 'pinned' | 'attention' | 'project'
  readonly total: number
  readonly data: readonly string[]
  readonly snoozedIds: readonly string[]
  readonly closedIds: readonly string[]
  readonly foldKey: string
  readonly collapsed: boolean
}
export interface MobileWorkSections {
  readonly sectionKeys: readonly string[]
  readonly orderingSectionKeys: readonly string[]
  readonly issueCount: number
  readonly pinnedCount: number
  readonly attentionCount: number
  readonly pending: number
}

/** Both platform adapters obtain the same worklist view model. */
export function mobileWorkView(pool: MobxPool) { return worklistView(pool) }


const EMPTY_IDS: readonly string[] = Object.freeze([])

/** Per-group lazy fields belong to the existing group row, never a keyed cache. */
export class MobileSection {
  private readonly members: ReturnType<typeof createQueryResult<string>> | undefined
  constructor(readonly pool: MobxPool, readonly key: string, readonly root: MobileSectionsView) {
    if (key !== 'needs-you') this.members = this.memberQuery()
  }
  private memberQuery() {
    const groups = () => worklistGroups(this.pool)
    const lane = () => this.kind === 'pinned' ? groups().rootPinned : groups().rootOpen
    const key = this.kind === 'pinned' ? 'pinned' : this.key
    return createQueryResult<string>({
      name: `worklist.phone@${this.key}.members`,
      ids: () => lane().lane(key),
      has: id => lane().hasIn(key, id),
      read: id => lane().hasIn(key, id) ? id : undefined,
      order: id => JSON.stringify(groups().rankOf(id)),
      compareOrder: (a, b) => compareRank(JSON.parse(a), JSON.parse(b)),
      matches: [id => this.root.sectionAsking(id), id => !this.root.sectionAsking(id)],
      totals: [id => this.root.pendingFor(id)],
      subscribe: changed => lane().subscribe(key, changed),
    })
  }
  private query() { this.pool.worklist.need(); return this.members! }
  private ids(rows: readonly string[] | typeof LOADING | undefined): readonly string[] {
    return rows === LOADING || rows === undefined ? EMPTY_IDS : rows
  }
  get label() { return this.key === 'pinned' ? 'Pinned' : this.key === 'needs-you' ? 'Needs you' : this.projectLabel }
  @lazy private get projectLabel() { return sidebarView(this.pool).band(this.root.state, this.key)?.label ?? '' }
  get kind(): MobileWorkSection['kind'] { return this.key === 'pinned' ? 'pinned' : this.key === 'needs-you' ? 'attention' : 'project' }
  // Forward declared data answers. The immutable kind guards empty lists.
  get openIds() { return this.kind === 'pinned' ? worklistGroups(this.pool).pinnedRootIds
    : this.kind === 'project' ? worklistGroups(this.pool).rootOpen.lane(this.key) : EMPTY_IDS }
  get snoozedIds() { return this.kind === 'project' ? worklistGroups(this.pool).rootSnoozed.lane(this.key) : EMPTY_IDS }
  get closedIds() { return this.kind === 'project' ? worklistGroups(this.pool).rootClosed.lane(this.key) : EMPTY_IDS }
  get allIds(): readonly string[] { return this.kind === 'attention' ? this.root.attentionIds : this.ids(this.query().get()) }
  get attentionIds(): readonly string[] { return this.kind === 'attention' ? this.root.attentionIds : this.ids(this.query().getMatch(0)) }
  get liveIds(): readonly string[] { return this.kind === 'project' ? this.ids(this.query().getMatch(1)) : this.allIds }
  @lazy get pending(): number {
    if (this.kind === 'attention') return 0
    const value = this.query().total(0)
    return value === LOADING || value === undefined ? 0 : value
  }
  get foldKey() { return `podium:sidebar:work-group-fold:${this.key}` }
  @lazy get collapsed() { return !this.root.state.searching && this.root.state.collapsed?.[this.foldKey] === true }
  get data() { return this.collapsed ? EMPTY_IDS : this.liveIds }
  @lazy get total() { return this.liveIds.length }
}

/** One section model owned by the always-on worklist. */
export class MobileSectionsView implements MobileWorkSections {
  readonly pinned: MobileSection
  readonly attention: MobileSection
  constructor(readonly pool: MobxPool, private readonly initialState?: MobileWorkState) {
    this.pinned = new MobileSection(pool, 'pinned', this)
    this.attention = new MobileSection(pool, 'needs-you', this)
  }
  get state(): MobileWorkState { return this.initialState ?? worklistView(this.pool).layout }
  @lazy({ equals: compareShallow }) get projectKeys() { return sidebarView(this.pool).bandKeys(this.state) }
  project(key: string): MobileSection { return worklistGroups(this.pool).group(key).workSection }
  section(key: string): MobileSection { return key === 'pinned' ? this.pinned : key === 'needs-you' ? this.attention : this.project(key) }
  @lazy get attentionIds() {
    return concatQueryResults([this.pinned.attentionIds, ...this.projectKeys.map(key => this.project(key).attentionIds)])
  }
  sectionAsking(id: string): boolean {
    return worklistView(this.pool).knownRow(id)?.sectionAsking ?? false
  }
  pendingFor(id: string): number {
    const issue = worklistView(this.pool).knownRow(id)
    return issue === undefined ? Number(omitGone(this.pool.row('issue', id)) === LOADING) : issue.aggregate.pending
  }
  private keys(ordering: boolean) {
    const sections: string[] = []
    if (this.pinned.total) sections.push('pinned')
    if (!ordering && this.attention.total) sections.push('needs-you')
    for (const key of this.projectKeys) {
      const row = this.project(key)
      if ((ordering ? row.allIds.length : row.total) + row.snoozedIds.length + row.closedIds.length > 0) sections.push(key)
    }
    return sections
  }
  @lazy({ equals: compareShallow }) get sectionKeys() { return this.keys(false) }
  @lazy({ equals: compareShallow }) get orderingSectionKeys() { return this.keys(true) }
  @lazy get issueCount() { return this.pinned.openIds.length + this.projectKeys.reduce((total, key) => total + this.project(key).openIds.length, 0) }
  @lazy get pinnedCount() { return this.pinned.openIds.length }
  @lazy get attentionCount() { return this.attentionIds.length }
  @lazy get pending() { return this.pinned.pending + this.projectKeys.reduce((total, key) => total + this.project(key).pending, 0) }
}
