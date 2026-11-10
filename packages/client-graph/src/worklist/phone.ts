import { boardTextMatcher } from '@podium/client-core/values'
import { companion, lazy } from '@podium/mobx-helpers'
import { action, compareShallow, compareStructural, observable, observableRef } from 'mobx'
import { omitGone } from '../lookup'
import type { IssueModel } from '../models'
import { RowWindow } from '../row-window'
import { compareRank } from '../shared/row-view'
import { type GroupNode, repoLabelOf, worklistGroups } from './groups'
import type { WorklistIssue } from './issue'
import type { MobileWorkRef } from './mobile'
import type { SidebarBand } from './sidebar'
import type { Worklist } from './view-model'
import { FINISHED_UNREAD_WINDOW_MS } from './visible'

export type PhoneWorkLane = 'open' | 'snoozed' | 'closed'

const EMPTY_IDS: readonly string[] = Object.freeze([])
const EMPTY_REFS: readonly MobileWorkRef[] = Object.freeze([])
const EMPTY_SECTIONS: readonly PhoneWorkSection[] = Object.freeze([])

/** SectionList's identity-only boundary; displayed facts stay on the section. */
export interface PhoneListSection {
  readonly key: string
  readonly source: PhoneWorkSection
  readonly label: string
  readonly kind: 'pinned' | 'project'
  readonly total: number
  readonly data: readonly MobileWorkRef[]
}

export interface PhoneWorkFilterSnapshot {
  lane: PhoneWorkLane
  query: string
}

/** Live filters, with a serializable navigation snapshot for a remounted screen. */
export class PhoneWorkFilters {
  @observable accessor lane: PhoneWorkLane = 'open'
  @observable accessor query = ''
  constructor(
    initial?: PhoneWorkFilterSnapshot,
    private readonly changed?: (snapshot: PhoneWorkFilterSnapshot) => void,
  ) {
    if (initial) this.restore(initial)
  }
  @action restore(snapshot: PhoneWorkFilterSnapshot) {
    this.lane = snapshot.lane
    this.query = snapshot.query
  }
  @action setLane(lane: PhoneWorkLane) {
    if (this.lane === lane) return
    this.lane = lane
    this.changed?.({ lane: this.lane, query: this.query })
  }
  @action setQuery(query: string) {
    if (this.query === query) return
    this.query = query
    this.changed?.({ lane: this.lane, query: this.query })
  }
}

/** The phone draws the desktop's sections and borrows its screen's filters. */
export class PhoneWorklist {
  @observableRef accessor filters = new PhoneWorkFilters()
  readonly pinned = new PhoneWorkSection('pinned', this)
  private readonly projectSection = companion(
    (group: GroupNode) => new PhoneWorkSection(group.key, this),
  )

  private readonly searchHit = companion((row: WorklistIssue) => new PhoneSearchHit(row, this))
  /** Whether the "projects with nothing open" row is unfolded; per worklist, not saved. */
  @observable accessor quietExpanded = false

  constructor(readonly worklist: Worklist) {}

  @action toggleQuiet() {
    this.quietExpanded = !this.quietExpanded
  }

  @action setFilters(filters: PhoneWorkFilters) {
    this.filters = filters
  }
  get lane() {
    return this.filters.lane
  }
  get query() {
    return this.filters.query
  }
  setLane(lane: PhoneWorkLane) {
    this.filters.setLane(lane)
  }
  setQuery(query: string) {
    this.filters.setQuery(query)
  }
  @lazy get needle() {
    return this.query.trim().toLocaleLowerCase()
  }

  section(key: string): PhoneWorkSection {
    return key === 'pinned'
      ? this.pinned
      : this.projectSection(worklistGroups(this.worklist.pool).group(key))
  }

  recentClosure(id: string): boolean {
    const row = this.worklist.knownRow(id)
    const at = Date.parse(row?.foldAt ?? '')
    return Number.isFinite(at) && !this.worklist.host.inputs.passed(at + FINISHED_UNREAD_WINDOW_MS)
  }

  /** Pins are an Open presentation. Sleeping/closed pins still belong to their project. */
  @lazy({ equals: compareStructural }) get pinnedLanes(): Readonly<
    Record<PhoneWorkLane, readonly string[]>
  > {
    const lanes: Record<PhoneWorkLane, string[]> = { open: [], snoozed: [], closed: [] }
    for (const id of this.worklist.sections().pinnedIds) {
      const row = this.worklist.knownRow(id)
      if (!row) continue
      const latchedOpen = row.selected && !this.worklist.selectedWasFolded && !row.dismissed
      if (row.closed && !latchedOpen) {
        if (this.recentClosure(id)) lanes.closed.push(id)
      } else lanes[row.issue.deferred ? 'snoozed' : 'open'].push(id)
    }
    return lanes
  }

  @lazy({ equals: compareShallow }) get sections(): readonly PhoneWorkSection[] {
    const sections: PhoneWorkSection[] = []
    if (this.lane === 'open' && this.pinned.ids.length > 0) sections.push(this.pinned)
    const keys = [...this.worklist.desktop.bandKeys(this.worklist.layout)]
    for (const id of this.pinnedLanes[this.lane]) {
      if (this.lane === 'open') break
      const key = this.worklist.knownRow(id)?.repoKey
      if (key && !keys.includes(key)) keys.push(key)
    }
    for (const key of keys) {
      const section = this.section(key)
      // Registered empty projects remain visible in unfiltered Open, like desktop.
      if ((!this.needle && this.lane === 'open') || section.ids.length > 0) sections.push(section)
    }
    return sections
  }

  /** Unfiltered Open folds projects with nothing open into one row (data plan W4);
   * search and the other lanes already leave empty projects out. */
  @lazy({ equals: compareShallow }) get quietSections(): readonly PhoneWorkSection[] {
    if (this.lane !== 'open' || this.needle) return EMPTY_SECTIONS
    const quiet = this.sections.filter((section) => !section.pinned && section.ids.length === 0)
    return quiet.length ? quiet : EMPTY_SECTIONS
  }

  /** {@link sections} without the folded quiet projects. */
  @lazy({ equals: compareShallow }) get activeSections(): readonly PhoneWorkSection[] {
    const quiet = this.quietSections
    return quiet.length
      ? this.sections.filter((section) => !quiet.includes(section))
      : this.sections
  }

  /** The Tasks board's text rule, built once per query (W7). */
  @lazy get textMatcher() {
    return boardTextMatcher(this.query)
  }

  /** A sub-task of the row that matches the search by title or ref (data plan W7),
   * or null. Only sub-tasks already in the pool are searched. */
  childHit(id: string): string | null {
    if (!this.needle) return null
    const row = this.worklist.knownRow(id)
    return row?.ready === 'ready' ? this.searchHit(row).childId : null
  }

  @lazy({ equals: compareShallow }) get listSections(): readonly PhoneListSection[] {
    return this.sections.map((section) => section.listSection)
  }

  matches(id: string): boolean {
    if (!this.needle) return true
    const row = this.worklist.knownRow(id)
    if (row?.ready !== 'ready') return false
    return (
      Boolean(this.textMatcher?.(row.issue)) ||
      row.searchText.includes(this.needle) ||
      this.searchHit(row).childId !== null
    )
  }

  @lazy get counts(): Readonly<Record<PhoneWorkLane, number>> {
    const desktop = this.worklist.sections()
    return {
      open:
        this.pinnedLanes.open.length + desktop.bands.reduce((n, band) => n + band.rowIds.length, 0),
      snoozed:
        this.pinnedLanes.snoozed.length +
        desktop.bands.reduce((n, band) => n + band.snoozedIds.length, 0),
      closed:
        this.pinnedLanes.closed.length +
        desktop.bands.reduce(
          (n, band) => n + band.closedIds.filter((id) => this.recentClosure(id)).length,
          0,
        ),
    }
  }

  /** Search can discover another lifecycle without mixing its tasks into the current list. */
  @lazy get otherLaneHits(): Readonly<Record<PhoneWorkLane, number>> {
    const hits = { open: 0, snoozed: 0, closed: 0 }
    if (!this.needle) return hits
    const sections = this.worklist.sections()
    const count = (ids: readonly string[]) => ids.reduce((n, id) => n + Number(this.matches(id)), 0)
    for (const lane of ['open', 'snoozed', 'closed'] as const)
      hits[lane] = count(this.pinnedLanes[lane])
    for (const band of sections.bands) {
      hits.open += count(band.rowIds)
      hits.snoozed += count(band.snoozedIds)
      hits.closed += count(band.closedIds.filter((id) => this.recentClosure(id)))
    }
    hits[this.lane] = 0
    return hits
  }
}

/** One section companion over the existing desktop band, with no second filing/index. */
export class PhoneWorkSection {
  readonly window = new RowWindow(
    () => this.ids,
    (id) => id,
  )
  readonly foldedListSection: PhoneListSection
  constructor(
    readonly key: string,
    readonly phone: PhoneWorklist,
  ) {
    this.foldedListSection = this.listBoundary(EMPTY_REFS)
  }

  private get band(): SidebarBand | undefined {
    return this.phone.worklist.desktop.band(this.phone.worklist.layout, this.key)
  }

  get pinned() {
    return this.key === 'pinned'
  }
  /** The project's repository, for starting new work in it; null for Pinned. */
  get repoPath(): string | null {
    return this.pinned ? null : (this.band?.repoPath ?? null)
  }
  get label() {
    if (this.pinned) return 'Pinned'
    if (this.band) return this.band.label
    const first = this.allIds[0]
    return repoLabelOf((first && this.phone.worklist.knownRow(first)?.issue.repoPath) || this.key)
  }
  get foldKey() {
    return this.pinned ? 'podium:sidebar:pinned-fold' : `podium:sidebar:project-fold:${this.key}`
  }
  @lazy({ equals: compareShallow }) get allIds(): readonly string[] {
    if (this.pinned) return this.phone.lane === 'open' ? this.phone.pinnedLanes.open : EMPTY_IDS
    const band = this.band
    const base = !band
      ? EMPTY_IDS
      : this.phone.lane === 'open'
        ? band.rowIds
        : this.phone.lane === 'snoozed'
          ? band.snoozedIds
          : band.closedIds.filter((id) => this.phone.recentClosure(id))
    if (this.phone.lane === 'open') return base
    const worklist = this.phone.worklist
    const pins = this.phone.pinnedLanes[this.phone.lane].filter(
      (id) => worklist.knownRow(id)?.repoKey === this.key,
    )
    if (!pins.length) return base
    return [...base, ...pins].sort((a, b) => {
      const left = worklist.knownRow(a)!,
        right = worklist.knownRow(b)!
      if (this.phone.lane === 'closed') {
        const byTime = Date.parse(right.foldAt) - Date.parse(left.foldAt)
        if (byTime) return byTime
      }
      return left.rank && right.rank ? compareRank(left.rank, right.rank) : a.localeCompare(b)
    })
  }
  get total() {
    return this.allIds.length
  }
  @lazy({ equals: compareShallow }) get ids(): readonly string[] {
    return this.phone.needle ? this.allIds.filter((id) => this.phone.matches(id)) : this.allIds
  }
  private listBoundary(data: readonly MobileWorkRef[]): PhoneListSection {
    const source = this
    return {
      key: this.key,
      source,
      data,
      get label() {
        return source.label
      },
      get kind() {
        return source.pinned ? 'pinned' : 'project'
      },
      get total() {
        return source.ids.length
      },
    }
  }
  @lazy get listSection(): PhoneListSection {
    return this.listBoundary(this.ids.map((id) => ({ id, listKey: `${this.key}:${id}` })))
  }
}

/** A row's search rule: the first resident descendant, breadth first, whose
 * title or ref the query matches. Deleted and archived sub-tasks never match. */
class PhoneSearchHit {
  constructor(
    readonly row: WorklistIssue,
    readonly phone: PhoneWorklist,
  ) {}

  @lazy get childId(): string | null {
    const matches = this.phone.textMatcher
    if (!matches) return null
    const pool = this.phone.worklist.pool
    const seen = new Set<string>([this.row.id])
    const queue = [...pool.graph.many('issue', this.row.id, 'treeChildren')]
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!
      if (seen.has(id)) continue
      seen.add(id)
      // A search never loads cold sub-tasks.
      // untracked-read: work-search-child-peek
      if (!omitGone(pool.row('issue', id, 'peek'))) continue
      const issue = omitGone(pool.model('issue', id)) as IssueModel | undefined
      if (!issue || typeof issue === 'symbol') continue
      if (!issue.deletedAt && !issue.archived && matches(issue)) return id
      queue.push(...pool.graph.many('issue', id, 'treeChildren'))
    }
    return null
  }
}
