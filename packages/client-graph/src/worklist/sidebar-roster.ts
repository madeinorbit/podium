import { keyedComputed } from '@podium/mobx-helpers'
import { machinePathsEqual } from '@podium/model'
/** Resident roster seats, maintained by existing ingest.
 * No per-session reaction or full session/issue record is retained here.
 *
 * POD-5407: only sessions in memory are filed. A session the rule keeps cold
 * is cold through its issue (or its own decay, unbound), which the rule calls
 * cold only once every keep that session could give has passed, so it can
 * never be a retained seat; one only waiting for the load window is filed
 * when it arrives. The former cold lane summaries (one per history session,
 * built at every attach) are gone. */
import { compareStructural, type ObservableSet, observable, observe } from 'mobx'
import { cachedKey } from '../cached'
import { nextUp } from '../clock'
import { debugName } from '../debug-name'
import type { MobxPool } from '../pool'
import { isExcluded } from '../shared/predicates'
import type { SliceIssue, SliceSession, SliceWorktree } from '../shared/slice-types'
import { LOADING } from './rollup'
import { SortedLanes } from './sorted-lanes'
import { retains, retentionOf } from './visible'

export interface SidebarOwner {
  readonly represented: boolean
  readonly excluded: boolean
  readonly finishAt?: number
}
interface SeatLocation { readonly owner: string | null; readonly path: string }
const EMPTY: readonly string[] = Object.freeze([])

/** The screen owns this view in the existing pool registry. */
export function sidebarRosterView(pool: MobxPool): SidebarRosterIndex {
  return pool.sources.view('sidebar.rosters', () => new SidebarRosterIndex(pool))
}

export class SidebarRosterIndex {
  private readonly seats = new Map<string, SeatLocation>()
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
    const ids = this.paths.lane(key).filter((path) => this.candidateIds(path).length > 0)
    const head = ids[0] === undefined ? undefined : this.pool.row('worktree', ids[0])
    const lane = head === LOADING ? undefined : head as SliceWorktree | undefined
    return { ids, label: lane?.repoName ?? key, repoPath: lane?.repoPath ?? key }
  }, { equals: compareStructural })
  private readonly expiries = new Map<string, number>()
  private readonly due = new Map<number, Set<string>>()
  private readonly deadlines: number[] = []
  private now: number

  /** Ownership is a read-time answer, independent of the filing reaction. */
  private readonly owner = cachedKey('pool.sidebar', 'owner', (id): SidebarOwner => {
    const issue = this.pool.knownIssue(id)
    const standing = issue?.standing
    const row = this.pool.row('issue', id, 'summary') as SliceIssue | typeof LOADING | undefined
    return {
      represented: issue?.placed === true,
      excluded: standing?.excluded === true || (row !== undefined && row !== LOADING && isExcluded(row)),
      finishAt: standing?.finished ? standing.finishedMs : undefined,
    }
  }, compareStructural)
  private readonly laneOwners = cachedKey('pool.sidebar', 'laneOwners', (path) =>
    [...this.pool.graph.many('worktree', path, 'issues')]
      .map((id) => this.owner(id)).filter((owner) => owner.represented), compareStructural)
  private readonly candidate = cachedKey('pool.sidebar', 'candidate', (id) => {
    const row = this.pool.row('session', id, 'mark')
    const retention = row === LOADING ? null : retentionOf(row as SliceSession | undefined)
    if (!retention?.seat || retention.shell) return false
    const owner = retention.issueId ? this.owner(retention.issueId) : undefined
    if (owner?.represented || owner?.excluded) return false
    const retainedBy = (value: SidebarOwner | undefined) => retains(retention,
      value?.finishAt === undefined ? undefined : { updatedAt: new Date(value.finishAt).toISOString() },
      { finished: value?.finishAt !== undefined }, this.pool.clock)
    if (!retainedBy(owner)) return false
    if (retention.issueId === undefined) {
      const path = this.pool.graph.one('session', id, 'worktree')
      if (path !== null && this.laneOwners(path).some(retainedBy)) return false
    }
    return true
  }, Object.is)
  private readonly candidateIds = cachedKey('pool.sidebar', 'candidateIds', (path) =>
    [...(this.lanes.get(path) ?? EMPTY)].filter((id) => this.candidate(id)), compareStructural)

  private readonly stops: readonly (() => void)[]
  constructor(private readonly pool: MobxPool) {
    this.now = pool.clock.peekNow()
    this.stops = [
      observe(pool.tables.session, change => this.queueSession(change.name)),
      observe(pool.tables.worktree, change => this.fileWorktree(change.name)),
    ]
  }

  dispose(): void {
    for (const stop of this.stops) stop()
    this.clear()
  }

  /** TRACKED. Only the path's resident seats and their owners are observed. */
  candidates(path: string): Iterable<string> {
    this.pool.worklist.need()
    return this.candidateIds(path)
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
    if (lane && machinePathsEqual(lane.path, lane.repoPath) && lane.projectRoot !== false) this.projects.add(path)
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
   * owner eligibility is derived when its path is read. */
  queueSession(id: string): void { this.dirty.add(id) }

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
    }
    this.fileSeat(id)
  }

  private fileSeat(id: string): void {
    const seat = this.seats.get(id)
    if (!seat) return
    let candidate = true
    let deadline = Number.POSITIVE_INFINITY
    if (candidate) {
      const row = this.pool.row('session', id, 'mark')
      const retention = row === LOADING ? null : retentionOf(row as SliceSession | undefined)
      const passed = (at: number) => { deadline = Math.min(deadline, nextUp(at)); return this.pool.clock.peekNow() > at }
      candidate = retention !== null && retention.seat && !retention.shell && retains(retention, undefined, undefined, { passed })
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
    this.seats.clear()
    this.dirty.clear(); this.lanes.clear()
    this.projects.clear(); this.projectCounts.clear(); this.worktrees.clear(); this.paths.clear(); this.bands.clear()
    this.expiries.clear(); this.due.clear(); this.deadlines.length = 0
  }
}
