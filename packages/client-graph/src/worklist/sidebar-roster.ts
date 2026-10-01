/** Resident roster candidates, maintained by existing ingest and issue filings.
 * No per-session reaction or full session/issue record is retained here. */
import { observable, type ObservableSet } from 'mobx'
import type { MobxPool } from '../pool'
import type { SliceSession } from '../shared/slice-types'
import { issueExcluded } from '../shared/schema'
import { LOADING } from './rollup'
import { retains, retentionOf, type HiddenIssue } from './visible'

export interface SidebarOwner {
  readonly represented: boolean
  readonly excluded: boolean
  readonly unownedIds: readonly string[]
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

  constructor(private readonly pool: MobxPool) {}

  candidates(path: string): Iterable<string> { return this.lanes.get(path) ?? EMPTY }
  coldPending(path: string): boolean { return (this.coldCounts.get(path) ?? 0) > 0 }
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
    if (previous?.represented !== next?.represented || previous?.excluded !== next?.excluded) {
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
      const passed = (at: number) => this.pool.clock.current > at
      const possible = path !== null && retention !== null && retention.seat && !retention.shell &&
        !(retention.issueId && (this.owners.get(retention.issueId)?.represented || this.owners.get(retention.issueId)?.excluded)) &&
        !(owner && (issueExcluded(owner) || (owner.flatUntil !== undefined && passed(owner.flatUntil)))) &&
        (owner !== undefined || retains(retention, undefined, undefined, { passed }))
      this.setCold(id, path === null ? undefined : { path, possible })
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
    const candidate = seat.owner === null ? !this.representedUnowned.has(id) : !owner?.represented && !owner?.excluded
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
  }

  clear(): void {
    this.seats.clear(); this.owned.clear(); this.owners.clear()
    this.representedUnowned.clear(); this.cold.clear()
    this.dirty.clear(); this.dirtyOwners.clear(); this.lanes.clear(); this.coldCounts.clear()
  }
}
