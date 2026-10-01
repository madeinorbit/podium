/** Resident roster candidates, maintained by existing ingest and issue filings.
 * No per-session reaction or full session/issue record is retained here. */
import { computed, compareStructural, observable, type IComputedValue, type ObservableSet } from 'mobx'
import type { MobxPool } from '../pool'
import type { SliceIssue, SliceSession, SliceWorktree } from '../shared/slice-types'
import { issueExcluded } from '../shared/schema'
import { LOADING } from './rollup'
import { retains, retentionOf, type HiddenIssue } from './visible'
import { SortedLanes } from './sorted-lanes'
import { nextUp } from '../clock'

export interface SidebarOwner {
  readonly represented: boolean
  readonly excluded: boolean
  readonly unownedIds: readonly string[]
  readonly finishAt?: number
}
interface SeatLocation { readonly owner: string | null; readonly path: string }
/** A cold row has no resident index entry. This declared two-field summary
 * tells a lane only whether a read needs to inspect the existing relation and
 * request a batch. It never supplies a roster id or payload. */
interface ColdLaneSummary { readonly path: string; readonly possible: boolean }
const EMPTY: ReadonlySet<string> = new Set()

export class SidebarRosterIndex {
  private readonly seats = new Map<string, SeatLocation>()
  private readonly owned = new Map<string, Set<string>>()
  private readonly owners = new Map<string, SidebarOwner>()
  private readonly representedUnowned = new Map<string, number>()
  private readonly cold = new Map<string, ColdLaneSummary>()
  private readonly dirty = new Set<string>()
  private readonly dirtyOwners = new Set<string>()
  private readonly lanes = observable.map<string, ObservableSet<string>>(undefined, {
    deep: false, name: 'pool.sidebar.rosterCandidates',
  })
  private readonly coldCounts = observable.map<string, number>(undefined, {
    deep: false, name: 'pool.sidebar.coldRosterSummary',
  })
  /** Project metadata and roster path lanes contain resident worktrees only. */
  readonly projects = observable.set<string>(undefined, { deep: false, name: 'pool.sidebar.projects' })
  private readonly projectCounts = observable.map<number | undefined, number>(undefined, { deep: false, name: 'pool.sidebar.projectCounts' })
  private readonly worktrees = new Map<string, { readonly group: string; readonly project?: number }>()
  private readonly paths = new SortedLanes<string, string>((a, b) => a.localeCompare(b), 'pool.sidebar.rosterPaths')
  private readonly bands = new Map<string, IComputedValue<{ readonly ids: readonly string[]; readonly label: string; readonly repoPath: string }>>()
  private readonly expiries = new Map<string, number>()
  private readonly due = new Map<number, Set<string>>()
  private readonly deadlines: number[] = []
  private now: number

  constructor(private readonly pool: MobxPool) { this.now = pool.clock.current }

  candidates(path: string): Iterable<string> { return this.lanes.get(path) ?? EMPTY }
  coldPending(path: string): boolean { return (this.coldCounts.get(path) ?? 0) > 0 }
  keys(): Iterable<string> { return this.paths.keys() }
  band(key: string) {
    let band = this.bands.get(key)
    if (!band) {
      band = computed(() => {
        const ids = this.paths.lane(key).slice()
        const head = ids[0] === undefined ? undefined : this.pool.row('worktree', ids[0])
        const lane = head === LOADING ? undefined : head as SliceWorktree | undefined
        return { ids, label: lane?.repoName ?? key, repoPath: lane?.repoPath ?? key }
      }, { name: `pool.sidebar.rosterBand.${key}`, equals: compareStructural })
      this.bands.set(key, band)
    }
    return band.get()
  }
  unpinnedProjectLanes(project: number | undefined, pinned: readonly string[]): number {
    let count = this.projectCounts.get(project) ?? 0
    for (const path of pinned) {
      const row = this.pool.row('worktree', path)
      if (row !== undefined && row !== LOADING && (row as SliceWorktree).projectIndex === project) count -= 1
    }
    return count
  }
  fileWorktree(path: string): void {
    const value = this.pool.row('worktree', path, 'mark')
    const lane = value === LOADING ? undefined : value as SliceWorktree | undefined
    const previous = this.worktrees.get(path)
    const project = lane?.projectIndex
    const count = (index: number | undefined, by: number) => {
      const n = (this.projectCounts.get(index) ?? 0) + by
      if (n) this.projectCounts.set(index, n)
      else this.projectCounts.delete(index)
    }
    if ((previous !== undefined) !== (lane !== undefined) || previous?.project !== project) {
      if (previous !== undefined) count(previous.project, -1)
      if (lane !== undefined) count(project, 1)
    }
    if (lane === undefined) this.worktrees.delete(path)
    else this.worktrees.set(path, { group: lane.repoId ?? lane.repoPath, project })
    if (lane && lane.path === lane.repoPath && lane.projectRoot !== false) this.projects.add(path)
    else this.projects.delete(path)
    this.filePath(path)
  }
  advanceClock(now: number): void {
    const previous = this.now
    this.now = now
    if (now < previous) {
      // A clock reset changes every retention window. Ordinary forward ticks
      // touch only due candidates, with no per-seat reactive registration.
      for (const id of this.seats.keys()) this.fileSeat(id)
      for (const id of this.cold.keys()) this.sync(id)
      return
    }
    while (this.deadlines.length && this.deadlines[0]! <= now) {
      const at = this.deadlines.shift()!
      const ids = this.due.get(at)
      this.due.delete(at)
      for (const id of ids ?? EMPTY) {
        this.expiries.delete(id)
        if (this.seats.has(id)) this.fileSeat(id)
        else this.sync(id)
      }
    }
  }
  queueSession(id: string): void { this.dirty.add(id) }
  queueIssue(id: string): void { this.dirtyOwners.add(id) }

  /** Existing issue filing reaction supplies these narrow facts. A burst on
   * a represented issue never invalidates its worktree's fallback roster. */
  fileOwner(id: string, next: SidebarOwner | undefined): void {
    const previous = this.owners.get(id)
    const before = previous?.unownedIds ?? EMPTY
    const after = new Set(next?.unownedIds ?? [])
    for (const seat of before) if (!after.has(seat)) {
      const n = (this.representedUnowned.get(seat) ?? 0) - 1
      if (n > 0) this.representedUnowned.set(seat, n)
      else this.representedUnowned.delete(seat)
      this.fileSeat(seat)
    }
    const old = new Set(before)
    for (const seat of after) if (!old.has(seat)) {
      this.representedUnowned.set(seat, (this.representedUnowned.get(seat) ?? 0) + 1)
      this.fileSeat(seat)
    }
    if (next === undefined) this.owners.delete(id)
    else this.owners.set(id, next)
    if (previous?.represented !== next?.represented || previous?.excluded !== next?.excluded || previous?.finishAt !== next?.finishAt) {
      for (const seat of this.owned.get(id) ?? EMPTY) this.fileSeat(seat)
      this.queueIssue(id)
      this.flush()
    }
  }

  /** After relation upkeep, within the publication's existing action. */
  flush(): void {
    for (const owner of this.dirtyOwners) {
      for (const id of this.pool.relations.many('issue', owner, 'sessions')) this.dirty.add(id)
    }
    this.dirtyOwners.clear()
    for (const id of this.dirty) this.sync(id)
    this.dirty.clear()
  }

  private sync(id: string): void {
    const row = this.pool.row('session', id, 'mark')
    const path = this.pool.graph.forwardTarget('session', id, 'worktree')
    if (row === LOADING) {
      this.removeSeat(id)
      const summary = this.pool.hidden('session', id)
      const retention = retentionOf(summary as SliceSession | undefined)
      const owner = retention?.issueId ? this.pool.hidden('issue', retention.issueId) as HiddenIssue | undefined : undefined
      let deadline = Number.POSITIVE_INFINITY
      const passed = (at: number) => { deadline = Math.min(deadline, nextUp(at)); return this.pool.clock.current > at }
      const possible = path !== null && retention !== null && retention.seat && !retention.shell &&
        !(retention.issueId && (this.owners.get(retention.issueId)?.represented || this.owners.get(retention.issueId)?.excluded)) &&
        !(owner && (issueExcluded(owner) || (owner.flatUntil !== undefined && passed(owner.flatUntil)))) &&
        (owner !== undefined || retains(retention, undefined, undefined, { passed }))
      this.setCold(id, path === null ? undefined : { path, possible })
      this.schedule(id, possible ? deadline : Number.POSITIVE_INFINITY)
      return
    }
    this.setCold(id, undefined)
    if (row === undefined || path === null) { this.removeSeat(id); return }
    const session = row as SliceSession
    const owner = session.issueId || null
    const previous = this.seats.get(id)
    if (previous?.path !== path || previous?.owner !== owner) {
      this.removeSeat(id)
      this.seats.set(id, { owner, path })
      if (owner !== null) {
        let members = this.owned.get(owner)
        if (!members) { members = new Set(); this.owned.set(owner, members) }
        members.add(id)
      }
    }
    this.fileSeat(id)
  }

  private fileSeat(id: string): void {
    const seat = this.seats.get(id)
    if (!seat) return
    const owner = seat.owner === null ? undefined : this.owners.get(seat.owner)
    let candidate = seat.owner === null ? !this.representedUnowned.has(id) : !owner?.represented && !owner?.excluded
    let deadline = Number.POSITIVE_INFINITY
    if (candidate) {
      const row = this.pool.row('session', id, 'mark')
      const retention = row === LOADING ? null : retentionOf(row as SliceSession | undefined)
      let issue: Pick<SliceIssue, 'closedAt' | 'updatedAt'> | undefined
      const standing = { finished: owner?.finishAt !== undefined }
      if (owner?.finishAt !== undefined) issue = { updatedAt: new Date(owner.finishAt).toISOString() }
      const passed = (at: number) => { deadline = Math.min(deadline, nextUp(at)); return this.pool.clock.current > at }
      candidate = retention !== null && retention.seat && !retention.shell && retains(retention, issue, standing, { passed })
    }
    this.schedule(id, candidate ? deadline : Number.POSITIVE_INFINITY)
    let lane = this.lanes.get(seat.path)
    if (candidate) {
      if (!lane) {
        lane = observable.set<string>(undefined, { deep: false, name: 'pool.sidebar.rosterSeats' })
        this.lanes.set(seat.path, lane)
      }
      lane.add(id)
    } else if (lane) {
      lane.delete(id)
      if (!lane.size) this.lanes.delete(seat.path)
    }
    this.filePath(seat.path)
  }

  private removeSeat(id: string): void {
    const previous = this.seats.get(id)
    if (!previous) return
    const lane = this.lanes.get(previous.path)
    if (lane) {
      lane.delete(id)
      if (!lane.size) this.lanes.delete(previous.path)
    }
    if (previous.owner !== null) {
      const members = this.owned.get(previous.owner)
      members?.delete(id)
      if (!members?.size) this.owned.delete(previous.owner)
    }
    this.seats.delete(id)
    this.schedule(id, Number.POSITIVE_INFINITY)
    this.filePath(previous.path)
  }

  private setCold(id: string, next: ColdLaneSummary | undefined): void {
    const previous = this.cold.get(id)
    if (previous?.path === next?.path && previous?.possible === next?.possible) return
    const add = (path: string, by: number) => {
      const n = (this.coldCounts.get(path) ?? 0) + by
      if (n > 0) this.coldCounts.set(path, n)
      else this.coldCounts.delete(path)
    }
    if (previous?.possible) add(previous.path, -1)
    if (next?.possible) add(next.path, 1)
    if (next) this.cold.set(id, next)
    else this.cold.delete(id)
    if (previous) this.filePath(previous.path)
    if (next && next.path !== previous?.path) this.filePath(next.path)
  }

  private filePath(path: string): void {
    const group = this.worktrees.get(path)?.group
    const present = (this.lanes.get(path)?.size ?? 0) > 0 || (this.coldCounts.get(path) ?? 0) > 0
    this.paths.file(path, present ? group : undefined, path)
  }

  private schedule(id: string, at: number): void {
    const previous = this.expiries.get(id)
    if (previous === at) return
    if (previous !== undefined) {
      const ids = this.due.get(previous)
      ids?.delete(id)
      if (!ids?.size) {
        this.due.delete(previous)
        const index = this.deadlines.indexOf(previous)
        if (index >= 0) this.deadlines.splice(index, 1)
      }
      this.expiries.delete(id)
    }
    if (!Number.isFinite(at)) return
    let ids = this.due.get(at)
    if (!ids) {
      ids = new Set(); this.due.set(at, ids)
      let lo = 0, hi = this.deadlines.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.deadlines[mid]! < at) lo = mid + 1; else hi = mid }
      this.deadlines.splice(lo, 0, at)
    }
    ids.add(id); this.expiries.set(id, at)
  }

  clear(): void {
    this.seats.clear(); this.owned.clear(); this.owners.clear()
    this.representedUnowned.clear(); this.cold.clear()
    this.dirty.clear(); this.dirtyOwners.clear(); this.lanes.clear(); this.coldCounts.clear()
    this.projects.clear(); this.projectCounts.clear(); this.worktrees.clear(); this.paths.clear(); this.bands.clear()
    this.expiries.clear(); this.due.clear(); this.deadlines.length = 0
  }
}
