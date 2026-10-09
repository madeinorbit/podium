import { worklistGroups } from './groups'
import { lazy } from '@podium/mobx-helpers'
/** Phone bands over the existing resident root/roster indexes. No legacy
 * worklist derivation, second runtime, row copies or new filing reactions. */
import { compareShallow } from 'mobx'
import type { MobxPool } from '../pool'
import { worklistView } from './view-model'
import { LOADING } from './rollup'
import { sidebarView, type SidebarState } from './sidebar'
import { mobileWaitingCount } from './mobile-row'

export interface MobileWorkState extends SidebarState {
  /** Search overrides folds; text matching stays in the native UI. */
  readonly searching?: boolean
}
export interface MobileWorkRef {
  readonly id: string
  readonly kind: 'issue' | 'worktree'
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
  constructor(readonly pool: MobxPool, readonly key: string, readonly root: MobileSectionsView) {}
  get label() { return this.key === 'pinned' ? 'Pinned' : this.key === 'needs-you' ? 'Needs you' : this.projectLabel }
  @lazy private get projectLabel() { return sidebarView(this.pool).band(this.root.state, this.key)?.label ?? '' }
  get kind(): MobileWorkSection['kind'] { return this.key === 'pinned' ? 'pinned' : this.key === 'needs-you' ? 'attention' : 'project' }
  @lazy({ equals: compareShallow }) get worktreeIds() { return this.kind === 'project'
    ? sidebarView(this.pool).band(this.root.state, this.key)?.worktreeIds ?? EMPTY_IDS : EMPTY_IDS }
  @lazy({ equals: compareShallow }) get openIds() { return this.kind === 'pinned' ? worklistGroups(this.pool).pinnedRootIds
    : this.kind === 'project' ? worklistGroups(this.pool).rootOpen.lane(this.key).slice() : EMPTY_IDS }
  @lazy({ equals: compareShallow }) get snoozedIds() { return this.kind === 'project' ? worklistGroups(this.pool).rootSnoozed.lane(this.key).slice() : EMPTY_IDS }
  @lazy({ equals: compareShallow }) get closedIds() { return this.kind === 'project' ? worklistGroups(this.pool).rootClosed.lane(this.key).slice() : EMPTY_IDS }
  @lazy({ equals: compareShallow }) get allIds(): readonly string[] {
    return this.kind === 'attention' ? this.root.attentionIds : [...this.openIds, ...this.worktreeIds]
  }
  @lazy({ equals: compareShallow }) get attentionIds() { return this.allIds.filter(id => this.root.waiting(id, this.worktreeIds.includes(id)).asking) }
  @lazy({ equals: compareShallow }) get liveIds() { return this.kind === 'project' ? this.allIds.filter(id => !this.attentionIds.includes(id)) : this.allIds }
  @lazy get pending() { return this.allIds.reduce((total, id) => total + this.root.waiting(id, this.worktreeIds.includes(id)).pending, 0) }
  get foldKey() { return `podium:sidebar:work-group-fold:${this.key}` }
  @lazy get collapsed() { return !this.root.state.searching && this.root.state.collapsed?.[this.foldKey] === true }
  @lazy({ equals: compareShallow }) get data() { return this.collapsed ? EMPTY_IDS : this.liveIds }
  @lazy get total() { return this.liveIds.length }
}

/** One section model owned by the always-on worklist. */
export class MobileSectionsView implements MobileWorkSections {
  constructor(readonly pool: MobxPool, private readonly initialState?: MobileWorkState) {}
  get state(): MobileWorkState { return this.initialState ?? worklistView(this.pool).layout }
  @lazy({ equals: compareShallow }) get projectKeys() { return sidebarView(this.pool).bandKeys(this.state) }
  project(key: string): MobileSection { return worklistGroups(this.pool).group(key).workSection }
  section(key: string): MobileSection { return key === 'pinned' ? this.pinned : key === 'needs-you' ? this.attention : this.project(key) }
  readonly pinned = new MobileSection(this.pool, 'pinned', this)
  readonly attention = new MobileSection(this.pool, 'needs-you', this)
  @lazy({ equals: compareShallow }) get attentionIds() {
    return [...this.pinned.attentionIds, ...this.projectKeys.flatMap(key => this.project(key).attentionIds)]
  }
  waiting(id: string, worktree: boolean): { asking: boolean; pending: number } {
    if (!worktree) {
      const issue = worklistView(this.pool).knownRow(id)
      if (issue === undefined) return { asking: false, pending: this.pool.row('issue', id) === LOADING ? 1 : 0 }
      return { asking: mobileWaitingCount(issue.aggregate, issue.issue.finished === true) > 0, pending: issue.aggregate.pending }
    }
    const value = worklistView(this.pool).mobileRow({ id, kind: 'worktree' })
    return { asking: value !== undefined && value !== LOADING && value.waitingCount > 0, pending: value === LOADING ? 1 : 0 }
  }
  @lazy({ equals: compareShallow }) get sectionKeys() {
    const sections: string[] = []
    if (this.pinned.total) sections.push('pinned')
    if (this.attention.total) sections.push('needs-you')
    for (const key of this.projectKeys) {
      const row = this.project(key)
      if (row.total + row.snoozedIds.length + row.closedIds.length > 0) sections.push(key)
    }
    return sections
  }
  @lazy({ equals: compareShallow }) get orderingSectionKeys() {
    const sections: string[] = []
    if (this.pinned.total) sections.push('pinned')
    for (const key of this.projectKeys) {
      const row = this.project(key)
      if (row.allIds.length + row.snoozedIds.length + row.closedIds.length > 0) sections.push(key)
    }
    return sections
  }
  @lazy get issueCount() { return this.pinned.openIds.length + this.projectKeys.reduce((total, key) => total + this.project(key).openIds.length, 0) }
  @lazy get pinnedCount() { return this.pinned.openIds.length }
  @lazy get attentionCount() { return this.attentionIds.length }
  @lazy get pending() { return this.pinned.pending + this.projectKeys.reduce((total, key) => total + this.project(key).pending, 0) }
}
