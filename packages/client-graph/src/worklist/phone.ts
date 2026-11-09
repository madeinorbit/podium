import { companion, lazy } from '@podium/mobx-helpers'
import { action, compareShallow, compareStructural, observable, observableRef } from 'mobx'
import { compareRank } from '../shared/row-view'
import { type GroupNode, repoLabelOf, worklistGroups } from './groups'
import type { MobileWorkRef } from './mobile'
import type { SidebarBand } from './sidebar'
import type { Worklist } from './view-model'
import { FINISHED_UNREAD_WINDOW_MS } from './visible'

export type PhoneWorkLane = 'open' | 'snoozed' | 'closed'

const EMPTY_IDS: readonly string[] = Object.freeze([])
const EMPTY_REFS: readonly MobileWorkRef[] = Object.freeze([])

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
  @observable private accessor initialLane: PhoneWorkLane = 'open'
  @observableRef private accessor pool: MobxPool | undefined = undefined
  @lazy get lane(): PhoneWorkLane {
    const value = this.pool?.layoutValue('phone.board.lanes')
    return value === 'open' || value === 'snoozed' || value === 'closed' ? value : this.initialLane
  }
  @action bind(pool: MobxPool): void {
    this.pool = pool
  }
  @observable accessor query = ''
  constructor(
    initial?: PhoneWorkFilterSnapshot,
    private readonly changed?: (snapshot: PhoneWorkFilterSnapshot) => void,
  ) {
    if (initial) this.restore(initial)
  }
  @action restore(snapshot: PhoneWorkFilterSnapshot) {
    if (!this.pool) this.initialLane = snapshot.lane
    this.query = snapshot.query
  }
  @action setLane(lane: PhoneWorkLane) {
    if (this.lane === lane) return
    if (this.pool?.hasLayout) this.pool.setLayoutValue('phone.board.lanes', lane)
    else this.initialLane = lane
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

  constructor(readonly worklist: Worklist) {}

  @action setFilters(filters: PhoneWorkFilters) {
    filters.bind(this.worklist.pool)
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

  @lazy({ equals: compareShallow }) get listSections(): readonly PhoneListSection[] {
    return this.sections.map((section) => section.listSection)
  }

  matches(id: string): boolean {
    if (!this.needle) return true
    const row = this.worklist.knownRow(id)
    return row?.ready === 'ready' && row.searchText.includes(this.needle)
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
