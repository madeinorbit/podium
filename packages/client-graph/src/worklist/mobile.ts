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
  private readonly views = new WeakMap<MobileWorkState, IComputedValue<MobileWorkSections>>()
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
      view = computed(() => this.sectionValues(state), { name: debugName(() => 'pool.mobileWork.sections'), equals: compareStructural })
      this.views.set(state, view)
    }
    return view.get()
  }

  private sectionValues(state: MobileWorkState): MobileWorkSections {
    const sections: MobileWorkSection[] = [], orderingSections: MobileWorkSection[] = []
    const ref = (id: string, kind: MobileWorkRef['kind'] = 'issue'): MobileWorkRef => ({ id, kind, listKey: id })
    const band = (key: string, label: string, kind: MobileWorkSection['kind'], data: readonly MobileWorkRef[], snoozedIds: readonly string[] = [], closedIds: readonly string[] = []): MobileWorkSection => ({
      key, label, kind, total: data.length, data, snoozedIds, closedIds,
      foldKey: `podium:sidebar:work-group-fold:${key}`, collapsed: false,
    })
    let pending = 0, issueCount = 0
    const waiting = (row: MobileWorkRef): boolean => {
      if (row.kind === 'issue') {
        const issue = this.pool.issue(row.id)
        if (issue === undefined) { if (this.pool.row('issue', row.id) === LOADING) pending += 1; return false }
        if (issue.aggregate.pending > 0) pending += issue.aggregate.pending
        return issue.mobileWaitingCount > 0
      }
      const value = this.row(row)
      if (value === LOADING) { pending += 1; return false }
      return value !== undefined && value.waitingCount > 0
    }
    const pinned = this.pool.groups.pinnedRootIds.map(id => ref(id))
    issueCount += pinned.length
    if (pinned.length > 0) {
      const pinnedBand = band('pinned', 'Pinned', 'pinned', pinned)
      sections.push(pinnedBand); orderingSections.push(pinnedBand)
    }
    const attention = pinned.filter(waiting).map(row => ({ ...row, listKey: `needs-you:${row.id}` }))
    const projects: MobileWorkSection[] = []
    for (const group of this.pool.sidebar.sections(state).bands) {
      // Mobile consumes the published unselected list, never the desktop latch.
      const open = this.pool.groups.rootOpen.lane(group.key).map(id => ref(id))
      const snoozed = this.pool.groups.rootSnoozed.lane(group.key).slice()
      const closed = this.pool.groups.rootClosed.lane(group.key).slice()
      issueCount += open.length
      const rows = [...open, ...group.worktreeIds.map(id => ref(id, 'worktree'))]
      if (rows.length + snoozed.length + closed.length === 0) continue
      const live: MobileWorkRef[] = []
      for (const row of rows) { if (waiting(row)) attention.push(row); else live.push(row) }
      const project = band(group.key, group.label, 'project', live, snoozed, closed)
      orderingSections.push({ ...project, data: rows, total: rows.length })
      if (live.length + snoozed.length + closed.length > 0) projects.push(project)
    }
    if (attention.length > 0) sections.push(band('needs-you', 'Needs you', 'attention', attention))
    sections.push(...projects)
    return { sections: sections.map(section => {
      const collapsed = !state.searching && state.collapsed?.[section.foldKey] === true
      return collapsed ? { ...section, collapsed, data: [], snoozedIds: [], closedIds: [] } : section
    }), orderingSections, issueCount, pinnedCount: pinned.length, attentionCount: attention.length, pending }
  }
}

const EMPTY_STATE: MobileWorkState = Object.freeze({})
