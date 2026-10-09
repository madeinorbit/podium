import { machinePathKey, machinePathsEqual } from '@podium/model/browser'
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
import { worklistView } from './view-model'
import { worklistGroups } from './groups'
import { nextUp } from '../clock'
import { debugName } from '../debug-name'
import type { MobxPool } from '../pool'
import { isExcluded } from '../shared/predicates'
import type { SliceIssue, SliceSession, SliceWorktree } from '../shared/slice-types'
import { LOADING } from './rollup'
import { retains, retentionOf } from './visible'
import { SortedLanes } from './sorted-lanes'
import { createQueryResult } from '../query-result'

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
  /** Membership is filed by ingest; eligibility is a tracked row answer.
   * The existing query owns its ordered snapshot and releases every row
   * observer when the last group reader goes away. */
  private readonly groupResults = new Map<string, ReturnType<typeof createQueryResult<string>>>()
  private readonly groupListeners = new Map<string, Set<(path: string | undefined) => void>>()
  private readonly candidateListeners = new Map<string, Set<(id: string | undefined) => void>>()
  groupIds(key: string): readonly string[] {
    let result = this.groupResults.get(key)
    if (!result) {
      result = createQueryResult({
        name: `pool.sidebar.rosterIds.${key}`,
        ids: () => this.paths.lane(key),
        has: path => this.paths.has(path) && this.worktrees.get(path)?.group === key,
        read: path => { const tree = this.pool.model('worktree', path); return tree && worklistView(this.pool).tree(tree).hasCandidates ? path : undefined },
        subscribe: changed => {
          let listeners = this.groupListeners.get(key)
          if (!listeners) {
            listeners = new Set()
            this.groupListeners.set(key, listeners)
          }
          listeners.add(changed)
          return () => {
            listeners.delete(changed)
            if (!listeners.size) this.groupListeners.delete(key)
          }
        },
        released: () => this.groupResults.delete(key),
      })
      this.groupResults.set(key, result)
    }
    const ids = result.get()
    return ids === LOADING || ids === undefined ? EMPTY : ids
  }
  private readonly expiries = new Map<string, number>()
  private readonly due = new Map<number, Set<string>>()
  private readonly deadlines: number[] = []
  private now: number

  /** Membership alone; the worktree companion owns read-time eligibility. */
  residentCandidates(path: string): Iterable<string> { return this.lanes.get(path) ?? EMPTY }

  hasResidentCandidate(path: string, id: string): boolean { return this.lanes.get(path)?.has(id) ?? false }

  /** Keyed membership moves are delivered inside the publication's action. */
  subscribeCandidates(path: string, changed: (id: string | undefined) => void): () => void {
    let listeners = this.candidateListeners.get(path)
    if (!listeners) {
      listeners = new Set()
      this.candidateListeners.set(path, listeners)
    }
    listeners.add(changed)
    return () => {
      listeners.delete(changed)
      if (!listeners.size) this.candidateListeners.delete(path)
    }
  }

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
    for (const result of [...this.groupResults.values()]) result.dispose()
    this.clear()
  }

  /** TRACKED. Only the path's resident seats and their owners are observed. */
  candidates(path: string): Iterable<string> {
    this.pool.worklist.need()
    const tree = this.pool.model('worktree', path)
    return tree ? worklistView(this.pool).tree(tree).candidateIds : EMPTY
  }
  keys(): Iterable<string> {
    this.pool.worklist.need()
    return this.paths.keys()
  }
  band(key: string) {
    this.pool.worklist.need()
    return worklistGroups(this.pool).group(key).rosterBand
  }
  unpinnedProjectLanes(project: number | undefined, pinned: readonly string[]): number {
    let count = this.projectCounts.get(project) ?? 0
    for (const path of pinned) {
      const row = this.pool.row('worktree', this.pool.queries.registeredWorktreePath(path) ?? path)
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
    else this.worktrees.set(path, { group: lane.repoId ?? machinePathKey(lane.repoPath), project })
    if (lane && machinePathsEqual(lane.path, lane.repoPath) && lane.projectRoot !== false) this.projects.add(path)
    else this.projects.delete(path)
    this.filePath(path, previous?.group)
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
    const wasCandidate = lane?.has(id) ?? false
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
    if (candidate !== wasCandidate)
      for (const changed of this.candidateListeners.get(seat.path) ?? []) changed(id)
    this.filePath(seat.path)
  }

  private removeSeat(id: string): void {
    const previous = this.seats.get(id)
    if (!previous) return
    const lane = this.lanes.get(previous.path)
    if (lane) {
      const removed = lane.delete(id)
      if (!lane.size) this.lanes.delete(previous.path)
      if (removed)
        for (const changed of this.candidateListeners.get(previous.path) ?? []) changed(id)
    }
    this.seats.delete(id)
    this.schedule(id, Number.POSITIVE_INFINITY)
    this.filePath(previous.path)
  }

  private filePath(path: string, previousGroup = this.worktrees.get(path)?.group): void {
    const group = this.worktrees.get(path)?.group
    const present = (this.lanes.get(path)?.size ?? 0) > 0
    if (!this.paths.file(path, present ? group : undefined, path)) return
    if (previousGroup !== undefined)
      for (const changed of this.groupListeners.get(previousGroup) ?? []) changed(path)
    if (group !== undefined && group !== previousGroup)
      for (const changed of this.groupListeners.get(group) ?? []) changed(path)
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
    this.projects.clear(); this.projectCounts.clear(); this.worktrees.clear(); this.paths.clear()
    for (const listeners of [...this.candidateListeners.values()])
      for (const changed of [...listeners]) changed(undefined)
    for (const listeners of [...this.groupListeners.values()])
      for (const changed of [...listeners]) changed(undefined)
    this.expiries.clear(); this.due.clear(); this.deadlines.length = 0
  }
}
