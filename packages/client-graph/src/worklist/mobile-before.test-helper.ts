import { worklistGroups } from './groups'
import { keyedComputed } from '@podium/mobx-helpers'
/** Phone bands over the existing resident root/roster indexes. No legacy
 * worklist derivation, second runtime, row copies or new filing reactions. */
import { compareShallow, computed, type IComputedValue } from 'mobx'
import type { MobxPool } from '../pool'
import { worklistView } from './view-model'
import { debugName } from '../debug-name'
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
  readonly data: readonly MobileWorkRef[]
  readonly snoozedIds: readonly string[]
  readonly closedIds: readonly string[]
  readonly foldKey: string
  readonly collapsed: boolean
}
export interface MobileWorkSections {
  readonly sections: readonly MobileWorkSection[]
  readonly orderingSections: readonly MobileWorkSection[]
  readonly issueCount: number
  readonly pinnedCount: number
  readonly attentionCount: number
  readonly pending: number
}

/** Both platform adapters obtain the same worklist view model. */
export function mobileWorkView(pool: MobxPool) { return worklistView(pool) }

const EMPTY_IDS: readonly string[] = Object.freeze([])
const EMPTY_REFS: readonly MobileWorkRef[] = Object.freeze([])
const band = (key: string, label: string, kind: MobileWorkSection['kind'], data: readonly MobileWorkRef[], snoozedIds: readonly string[] = EMPTY_IDS, closedIds: readonly string[] = EMPTY_IDS): MobileWorkSection => ({
  key, label, kind, total: data.length, data, snoozedIds, closedIds,
  foldKey: `podium:sidebar:work-group-fold:${key}`, collapsed: false,
})
interface MobileLane {
  readonly section: MobileWorkSection
  readonly ordering: MobileWorkSection
  readonly attention: readonly MobileWorkRef[]
  readonly issueCount: number
  readonly pending: number
}

/** One computed per resident band, with independent row arrays. Membership
 * changes in one project cannot map/copy another project's native data. */
export class MobileSectionsBefore {
  private rowRef(id: string, kind: MobileWorkRef['kind'] = 'issue', attention = false): MobileWorkRef {
    return { id, kind, listKey: attention ? `needs-you:${id}` : id }
  }
  private readonly label = keyedComputed(() => debugName(() => 'pool.mobileWork.label'),
    (key: string) => sidebarView(this.pool).band(this.state, key)?.label ?? '')
  private readonly worktreeIds = keyedComputed(() => debugName(() => 'pool.mobileWork.worktreeIds'),
    (key: string) => sidebarView(this.pool).band(this.state, key)?.worktreeIds ?? EMPTY_IDS,
    { equals: compareShallow })
  private readonly openRows = keyedComputed(() => debugName(() => 'pool.mobileWork.openRows'), (key: string) => worklistGroups(this.pool).rootOpen.lane(key).map(id => this.rowRef(id)), { equals: compareShallow })
  private readonly snoozedRows = keyedComputed(() => debugName(() => 'pool.mobileWork.snoozedRows'), (key: string) => worklistGroups(this.pool).rootSnoozed.lane(key).slice(), { equals: compareShallow })
  private readonly closedRows = keyedComputed(() => debugName(() => 'pool.mobileWork.closedRows'), (key: string) => worklistGroups(this.pool).rootClosed.lane(key).slice(), { equals: compareShallow })
  private readonly allRows = keyedComputed(() => debugName(() => 'pool.mobileWork.allRows'), (key: string) => [...this.openRows(key), ...this.worktreeIds(key).map(id => this.rowRef(id, 'worktree'))], { equals: compareShallow })
  private readonly split = keyedComputed(() => debugName(() => 'pool.mobileWork.split'), (key: string) => {
    const live: MobileWorkRef[] = [], attention: MobileWorkRef[] = []
    let pending = 0
    for (const row of this.allRows(key)) {
      const waiting = this.waiting(row)
      pending += waiting.pending
      ;(waiting.asking ? attention : live).push(row)
    }
    return { live, attention, pending }
  })
  private readonly liveRows = keyedComputed(() => debugName(() => 'pool.mobileWork.liveRows'), (key: string) => this.split(key).live, { equals: compareShallow })
  private readonly attentionRows = keyedComputed(() => debugName(() => 'pool.mobileWork.attentionRows'), (key: string) => this.split(key).attention, { equals: compareShallow })
  private readonly section = keyedComputed(() => debugName(() => 'pool.mobileWork.section'), (key: string) => band(key, this.label(key), 'project', this.liveRows(key), this.snoozedRows(key), this.closedRows(key)))
  private readonly ordering = keyedComputed(() => debugName(() => 'pool.mobileWork.ordering'), (key: string) => band(key, this.label(key), 'project', this.allRows(key), this.snoozedRows(key), this.closedRows(key)))
  private readonly pending = keyedComputed(() => debugName(() => 'pool.mobileWork.pending'), (key: string) => this.split(key).pending)
  private readonly project = keyedComputed(() => debugName(() => 'pool.mobileWork.project'), (key: string): MobileLane => ({
    section: this.section(key), ordering: this.ordering(key), attention: this.attentionRows(key),
    issueCount: this.openRows(key).length, pending: this.pending(key),
  }))
  private readonly displayed = keyedComputed(() => debugName(() => 'pool.mobileWork.display'), (key: string) => {
    const source = key === 'pinned' ? this.pinned.get().section : key === 'needs-you'
      ? this.attention.get() : this.project(key).section
    const collapsed = !this.state.searching && this.state.collapsed?.[source.foldKey] === true
    return collapsed ? { ...source, collapsed, data: EMPTY_REFS, snoozedIds: EMPTY_IDS, closedIds: EMPTY_IDS } : source
  })
  private readonly pinned: IComputedValue<MobileLane>
  private readonly attention: IComputedValue<MobileWorkSection>
  readonly value: IComputedValue<MobileWorkSections>

  constructor(private readonly pool: MobxPool, private readonly state: MobileWorkState) {
    const pinnedData = computed(() => worklistGroups(pool).pinnedRootIds.map(id => this.rowRef(id)), { equals: compareShallow, name: debugName(() => 'pool.mobileWork.pinnedData') })
    const pinnedSection = computed(() => band('pinned', 'Pinned', 'pinned', pinnedData.get()), { name: debugName(() => 'pool.mobileWork.pinnedSection') })
    const pinnedAttention = computed(() => pinnedData.get().filter(row => this.waiting(row).asking)
      .map(row => this.rowRef(row.id, row.kind, true)), { equals: compareShallow, name: debugName(() => 'pool.mobileWork.pinnedAttention') })
    this.pinned = computed(() => {
      let pending = 0
      for (const row of pinnedData.get()) pending += this.waiting(row).pending
      const section = pinnedSection.get()
      return { section, ordering: section, attention: pinnedAttention.get(), issueCount: section.total, pending }
    }, { equals: compareShallow, name: debugName(() => 'pool.mobileWork.pinned') })
    const attentionData = computed(() => [
      ...this.pinned.get().attention,
      ...this.projectKeys().flatMap(key => this.project(key).attention),
    ], { equals: compareShallow, name: debugName(() => 'pool.mobileWork.attentionData') })
    this.attention = computed(() => band('needs-you', 'Needs you', 'attention', attentionData.get()),
      { name: debugName(() => 'pool.mobileWork.attention') })
    this.value = computed(() => this.sections(), {
      name: debugName(() => 'pool.mobileWork.sections'),
      equals: (a, b) => a.issueCount === b.issueCount && a.pinnedCount === b.pinnedCount
        && a.attentionCount === b.attentionCount && a.pending === b.pending
        && sameSections(a.sections, b.sections) && sameSections(a.orderingSections, b.orderingSections),
    })
  }

  /** The band keys alone (POD-5423): a lane move inside a band re-runs none of the bands' views. */
  private projectKeys(): readonly string[] {
    return sidebarView(this.pool).bandKeys(this.state)
  }

  private waiting(row: MobileWorkRef): { asking: boolean; pending: number } {
    if (row.kind === 'issue') {
      const issue = worklistView(this.pool).knownRow(row.id)
      if (issue === undefined) return { asking: false, pending: this.pool.row('issue', row.id) === LOADING ? 1 : 0 }
      return { asking: mobileWaitingCount(issue.aggregate, issue.finished === true) > 0, pending: issue.aggregate.pending }
    }
    const value = mobileWorkView(this.pool).mobileRow(row)
    return { asking: value !== undefined && value !== LOADING && value.waitingCount > 0, pending: value === LOADING ? 1 : 0 }
  }

  private display(section: MobileWorkSection): MobileWorkSection {
    return this.displayed(section.key)
  }

  private sections(): MobileWorkSections {
    const sections: MobileWorkSection[] = [], orderingSections: MobileWorkSection[] = []
    const pinned = this.pinned.get(), attention = this.attention.get(), keys = this.projectKeys()
    let issueCount = pinned.issueCount, pending = pinned.pending
    if (pinned.section.total > 0) { sections.push(this.display(pinned.section)); orderingSections.push(pinned.ordering) }
    if (attention.total > 0) sections.push(this.display(attention))
    for (const key of keys) {
      const project = this.project(key)
      issueCount += project.issueCount; pending += project.pending
      const { section, ordering } = project
      if (ordering.total + ordering.snoozedIds.length + ordering.closedIds.length > 0) orderingSections.push(ordering)
      if (section.total + section.snoozedIds.length + section.closedIds.length > 0) sections.push(this.display(section))
    }
    return { sections, orderingSections, issueCount, pinnedCount: pinned.section.total, attentionCount: attention.total, pending }
  }
}

function sameSections(a: readonly MobileWorkSection[], b: readonly MobileWorkSection[]): boolean {
  return a.length === b.length && a.every((section, index) => section === b[index])
}
