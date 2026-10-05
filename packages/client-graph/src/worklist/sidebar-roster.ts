import { keyedComputed } from '@podium/mobx-helpers'
/** Resident roster candidates, maintained by existing ingest and issue filings.
 * No per-session reaction or full session/issue record is retained here.
 *
 * POD-5407: only sessions in memory are filed. A session the rule keeps cold
 * is cold through its issue (or its own decay, unbound), which the rule calls
 * cold only once every keep that session could give has passed, so it can
 * never be a retained seat; one only waiting for the load window is filed
 * when it arrives. The former cold lane summaries (one per history session,
 * built at every attach) are gone. */
import { compareStructural, observable, type ObservableSet } from 'mobx'
import { debugName } from '../debug-name'
import type { MobxPool } from '../pool'
import type { SliceIssue, SliceSession, SliceWorktree } from '../shared/slice-types'
import { LOADING } from './rollup'
import { retains, retentionOf } from './visible'
import { SortedLanes } from './sorted-lanes'
import { nextUp } from '../clock'

export interface SidebarOwner {
  readonly represented: boolean
  readonly excluded: boolean
  readonly unownedIds: readonly string[]
  readonly finishAt?: number
}
interface SeatLocation { readonly owner: string | null; readonly path: string }
const EMPTY: readonly string[] = Object.freeze([])

export class SidebarRosterIndex {
  private readonly seats = new Map<string, SeatLocation>()
  private readonly owned = new Map<string, Set<string>>()
  private readonly owners = new Map<string, SidebarOwner>()
  private readonly representedUnowned = new Map<string, number>()
  private readonly dirty = new Set<string>()
  private readonly lanes = observable.map<string, ObservableSet<string>>(undefined, {
    deep: false, name: debugName(() => 'pool.sidebar.rosterCandidates'),
  })
  /** Project metadata and roster path lanes contain resident worktrees only. */
  readonly projects = observable.set<string>(undefined, { deep: false, name: debugName(() => 'pool.sidebar.projects') })
  private readonly projectCounts = observable.map<number | undefined, number>(undefined, { deep: false, name: debugName(() => 'pool.sidebar.projectCounts') })
  private readonly worktrees = new Map<string, { readonly group: string; readonly project?: number }>()
  private readonly paths = new SortedLanes<string, string>((a, b) => a < b ? -1 : a > b ? 1 : 0, 'pool.sidebar.rosterPaths')
  // The lane snapshot and metadata record are freshly assembled on a change.
  private readonly bands = keyedComputed((key: string) => debugName(() => `pool.sidebar.rosterBand.${key}`), (key: string) => {
    const ids = [...this.paths.lane(key)]
    const head = ids[0] === undefined ? undefined : this.pool.row('worktree', ids[0])
    const lane = head === LOADING ? undefined : head as SliceWorktree | undefined
    return { ids, label: lane?.repoName ?? key, repoPath: lane?.repoPath ?? key }
  }, { equals: compareStructural })
  private readonly expiries = new Map<string, number>()
  private readonly due = new Map<number, Set<string>>()
  private readonly deadlines: number[] = []
  private now: number

  constructor(private readonly pool: MobxPool) { this.now = pool.clock.current }

  /** TRACKED. Owner facts come from the worklist's filing, so every read
   * reports demand for it (POD-5423): without a reader, owners are absent. */
  candidates(path: string): Iterable<string> {
    this.pool.worklist.need()
    return this.lanes.get(path) ?? EMPTY
  }
  keys(): Iterable<string> {
    this.pool.worklist.need()
    return this.paths.keys()
  }
  band(key: string) {
    this.pool.worklist.need()
    return this.bands(key)
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
      return
    }
    while (this.deadlines.length && this.deadlines[0]! <= now) {
      const at = this.deadlines.shift()!
      const ids = this.due.get(at)
      this.due.delete(at)
      for (const id of ids ?? EMPTY) {
        this.expiries.delete(id)
        if (this.seats.has(id)) this.fileSeat(id)
      }
    }
  }
  /** A session's own row, its table slot or its worktree link moved. These
   * are the only facts `sync` reads, so an issue publication queues nothing:
   * its owner facts reach the seats it owns through `fileOwner` (POD-5423). */
  queueSession(id: string): void { this.dirty.add(id) }

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
      // Only seats already located under this owner read these facts. A
      // member with no seat (cold, or with no worktree link) has no lane to
      // enter until its own row or link moves, which queues it (POD-5423:
      // never the owner's session history).
      for (const seat of this.owned.get(id) ?? EMPTY) this.fileSeat(seat)
    }
  }

  /** After relation upkeep, within the publication's existing action. */
  flush(): void {
    for (const id of this.dirty) this.sync(id)
    this.dirty.clear()
  }

  private sync(id: string): void {
    const row = this.pool.row('session', id, 'mark')
    const path = row === LOADING || row === undefined ? null : this.pool.graph.forwardTarget('session', id, 'worktree')
    if (row === LOADING || row === undefined || path === null) { this.removeSeat(id); return }
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
        lane = observable.set<string>(undefined, { deep: false, name: debugName(() => 'pool.sidebar.rosterSeats') })
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

  private filePath(path: string): void {
    const group = this.worktrees.get(path)?.group
    const present = (this.lanes.get(path)?.size ?? 0) > 0
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
    this.representedUnowned.clear()
    this.dirty.clear(); this.lanes.clear()
    this.projects.clear(); this.projectCounts.clear(); this.worktrees.clear(); this.paths.clear(); this.bands.clear()
    this.expiries.clear(); this.due.clear(); this.deadlines.length = 0
  }
}
