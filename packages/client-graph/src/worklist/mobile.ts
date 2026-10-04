/** Phone bands over the existing resident root/roster indexes. No legacy
 * worklist derivation, second runtime, row copies or new filing reactions. */
import { compareStructural, computed, type IComputedValue } from 'mobx'
import type { MobxPool } from '../pool'
import { debugName } from '../debug-name'
import { LOADING } from './rollup'
import type { SidebarState } from './sidebar'
import { mobileWorktreeValues, type MobileRowValues } from './mobile-row'

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

export class MobileWorkIndex {
  private readonly views = new WeakMap<MobileWorkState, MobileSectionsView>()
  constructor(private readonly pool: MobxPool) {}

  row(ref: Pick<MobileWorkRef, 'id' | 'kind'>): MobileRowValues | typeof LOADING | undefined {
    if (ref.kind === 'issue') {
      const issue = this.pool.issue(ref.id)
      return issue === undefined ? this.pool.row('issue', ref.id) === LOADING ? LOADING : undefined : issue.mobileWork
    }
    if (this.pool.row('worktree', ref.id) === LOADING) return LOADING
    const row = this.pool.sidebar.worktree(ref.id)
    if (row === undefined) return undefined
    if (row.pending > 0) return LOADING
    return mobileWorktreeValues(ref.id, row.worktree.repoName, row.worktree.branch, row.sessions, row.activityAt)
  }

  sections(state: MobileWorkState = EMPTY_STATE): MobileWorkSections {
    let view = this.views.get(state)
    if (view === undefined) {
      view = new MobileSectionsView(this.pool, state)
      this.views.set(state, view)
    }
    return view.value.get()
  }
}

const EMPTY_IDS: readonly string[] = Object.freeze([])
const EMPTY_REFS: readonly MobileWorkRef[] = Object.freeze([])
const ref = (id: string, kind: MobileWorkRef['kind'] = 'issue'): MobileWorkRef => ({ id, kind, listKey: id })
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
class MobileSectionsView {
  private readonly projects = new Map<string, IComputedValue<MobileLane>>()
  private readonly headers = new Map<string, IComputedValue<{ label: string; worktreeIds: readonly string[] }>>()
  private readonly displayed = new Map<string, IComputedValue<MobileWorkSection>>()
  private readonly pinned: IComputedValue<MobileLane>
  private readonly attention: IComputedValue<MobileWorkSection>
  readonly value: IComputedValue<MobileWorkSections>

  constructor(private readonly pool: MobxPool, private readonly state: MobileWorkState) {
    const pinnedData = computed(() => pool.groups.pinnedRootIds.map(id => ref(id)), { equals: compareStructural, name: debugName(() => 'pool.mobileWork.pinnedData') })
    const pinnedSection = computed(() => band('pinned', 'Pinned', 'pinned', pinnedData.get()), { equals: compareStructural, name: debugName(() => 'pool.mobileWork.pinnedSection') })
    const pinnedAttention = computed(() => pinnedData.get().filter(row => this.waiting(row).asking)
      .map(row => ({ ...row, listKey: `needs-you:${row.id}` })), { equals: compareStructural, name: debugName(() => 'pool.mobileWork.pinnedAttention') })
    this.pinned = computed(() => {
      let pending = 0
      for (const row of pinnedData.get()) pending += this.waiting(row).pending
      const section = pinnedSection.get()
      return { section, ordering: section, attention: pinnedAttention.get(), issueCount: section.total, pending }
    }, { equals: compareStructural, name: debugName(() => 'pool.mobileWork.pinned') })
    this.attention = computed(() => band('needs-you', 'Needs you', 'attention', [
      ...this.pinned.get().attention,
      ...this.projectKeys().flatMap(key => this.project(key).get().attention),
    ]), { equals: compareStructural, name: debugName(() => 'pool.mobileWork.attention') })
    this.value = computed(() => this.sections(), {
      name: debugName(() => 'pool.mobileWork.sections'),
      equals: (a, b) => a.issueCount === b.issueCount && a.pinnedCount === b.pinnedCount
        && a.attentionCount === b.attentionCount && a.pending === b.pending
        && sameSections(a.sections, b.sections) && sameSections(a.orderingSections, b.orderingSections),
    })
  }

  /** The band keys alone (POD-5423): a lane move inside a band re-runs none of the bands' views. */
  private projectKeys(): readonly string[] {
    return this.pool.sidebar.bandKeys(this.state)
  }

  private waiting(row: MobileWorkRef): { asking: boolean; pending: number } {
    if (row.kind === 'issue') {
      const issue = this.pool.issue(row.id)
      if (issue === undefined) return { asking: false, pending: this.pool.row('issue', row.id) === LOADING ? 1 : 0 }
      return { asking: issue.mobileWaitingCount > 0, pending: issue.aggregate.pending }
    }
    const value = this.pool.mobileWork.row(row)
    return { asking: value !== undefined && value !== LOADING && value.waitingCount > 0, pending: value === LOADING ? 1 : 0 }
  }

  private project(key: string): IComputedValue<MobileLane> {
    let view = this.projects.get(key)
    if (view === undefined) {
      const header = computed(() => {
        const value = this.pool.sidebar.band(this.state, key)
        return { label: value?.label ?? '', worktreeIds: value?.worktreeIds ?? EMPTY_IDS }
      }, { equals: compareStructural, name: debugName(() => `pool.mobileWork.header`) })
      this.headers.set(key, header)
      const openRows = computed(() => this.pool.groups.rootOpen.lane(key).map(id => ref(id)), { equals: compareStructural, name: debugName(() => 'pool.mobileWork.openRows') })
      const snoozedRows = computed(() => this.pool.groups.rootSnoozed.lane(key).slice(), { equals: compareStructural, name: debugName(() => 'pool.mobileWork.snoozedRows') })
      const closedRows = computed(() => this.pool.groups.rootClosed.lane(key).slice(), { equals: compareStructural, name: debugName(() => 'pool.mobileWork.closedRows') })
      const allRows = computed(() => [...openRows.get(), ...header.get().worktreeIds.map(id => ref(id, 'worktree'))], { equals: compareStructural, name: debugName(() => 'pool.mobileWork.allRows') })
      const split = computed(() => {
        const live: MobileWorkRef[] = [], attention: MobileWorkRef[] = []
        let pending = 0
        for (const row of allRows.get()) {
          const waiting = this.waiting(row)
          pending += waiting.pending
          ;(waiting.asking ? attention : live).push(row)
        }
        return { live, attention, pending }
      }, { equals: compareStructural, name: debugName(() => 'pool.mobileWork.split') })
      const liveRows = computed(() => split.get().live, { equals: compareStructural, name: debugName(() => 'pool.mobileWork.liveRows') })
      const attentionRows = computed(() => split.get().attention, { equals: compareStructural, name: debugName(() => 'pool.mobileWork.attentionRows') })
      const section = computed(() => band(key, header.get().label, 'project', liveRows.get(), snoozedRows.get(), closedRows.get()), { equals: compareStructural, name: debugName(() => 'pool.mobileWork.section') })
      const ordering = computed(() => band(key, header.get().label, 'project', allRows.get(), snoozedRows.get(), closedRows.get()), { equals: compareStructural, name: debugName(() => 'pool.mobileWork.ordering') })
      view = computed(() => {
        return { section: section.get(), ordering: ordering.get(),
          attention: attentionRows.get(), issueCount: openRows.get().length, pending: split.get().pending }
      }, { equals: compareStructural, name: debugName(() => 'pool.mobileWork.project') })
      this.projects.set(key, view)
    }
    return view
  }

  private display(section: MobileWorkSection): MobileWorkSection {
    let view = this.displayed.get(section.key)
    if (view === undefined) {
      const key = section.key
      view = computed(() => {
        const source = key === 'pinned' ? this.pinned.get().section : key === 'needs-you'
          ? this.attention.get() : this.project(key).get().section
        const collapsed = !this.state.searching && this.state.collapsed?.[source.foldKey] === true
        return collapsed ? { ...source, collapsed, data: EMPTY_REFS, snoozedIds: EMPTY_IDS, closedIds: EMPTY_IDS } : source
      }, { equals: compareStructural, name: debugName(() => 'pool.mobileWork.display') })
      this.displayed.set(key, view)
    }
    return view.get()
  }

  private sections(): MobileWorkSections {
    const sections: MobileWorkSection[] = [], orderingSections: MobileWorkSection[] = []
    const pinned = this.pinned.get(), attention = this.attention.get(), keys = this.projectKeys()
    let issueCount = pinned.issueCount, pending = pinned.pending
    if (pinned.section.total > 0) { sections.push(this.display(pinned.section)); orderingSections.push(pinned.ordering) }
    if (attention.total > 0) sections.push(this.display(attention))
    for (const key of keys) {
      const project = this.project(key).get()
      issueCount += project.issueCount; pending += project.pending
      const { section, ordering } = project
      if (ordering.total + ordering.snoozedIds.length + ordering.closedIds.length > 0) orderingSections.push(ordering)
      if (section.total + section.snoozedIds.length + section.closedIds.length > 0) sections.push(this.display(section))
    }
    const active = new Set(keys)
    for (const key of this.projects.keys()) if (!active.has(key)) {
      this.projects.delete(key); this.headers.delete(key); this.displayed.delete(key)
    }
    return { sections, orderingSections, issueCount, pinnedCount: pinned.section.total, attentionCount: attention.total, pending }
  }
}

function sameSections(a: readonly MobileWorkSection[], b: readonly MobileWorkSection[]): boolean {
  return a.length === b.length && a.every((section, index) => section === b[index])
}
const EMPTY_STATE: MobileWorkState = Object.freeze({})
