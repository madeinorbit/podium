import { isFinished } from '../shared/predicates'
/**
 * POD-5423 (review finding 8): each issue's explicit seats (`issue.sessions`)
 * judged ONCE PER SEAT CHANGE, not once per issue re-run.
 *
 * The members group reads which seats are retained at the clock, which of
 * them are on the live roster, and whether one of its own is on the task
 * (`retainedSeatIdsPartOf`, `rosterIdsPartOf`, `openOwnPartOf` in
 * `visible.ts`). Asked of every seat in one derivation, that is a walk of the
 * issue's whole session history whenever ANY seat's row moves (a mark-read, a
 * phase), and the history of a coordinator or epic issue is hundreds of
 * sessions. Here every seat keeps its own verdict, recomputed when that
 * seat's row, its membership, its issue's finish facts or a deadline it read
 * moves; the issue's summary (one observable value, made when the issue's
 * members are first read) changes only when a verdict does. A heartbeat or a
 * mark-read that leaves the verdict alone wakes nothing.
 *
 * THE RULE IS NOT RESTATED: a verdict is `retains` (`visible.ts`) over
 * `retentionOf` of the row the members group reads (`peek`: hot or cold), with
 * the issue's own `finished` and finish stamps, at the pool's clock. The plain
 * rebuild still walks the seats directly (`membersOf` without a summary).
 *
 * Plain maps, no reaction and no per-seat computed. Maintenance runs inside
 * the publication's or the load window's action (`flush`), like the sidebar
 * roster index.
 */
import { observableRef } from 'mobx'
import { nextUp } from '../clock'
import type { SliceIssue, SliceSession } from '../shared/slice-types'
import { activityMsOf, retains, retentionOf } from './visible'

/** What the members group reads of an issue's explicit seats. */
export interface SeatSummary {
  /** Seats retained at the clock (exited included), in id order. */
  readonly retained: readonly string[]
  /** The retained seats not exited, in id order. */
  readonly roster: readonly string[]
  /** Seats of its own (`issueId` is this issue) neither archived nor exited. */
  readonly present: number
  /**
   * The latest `lastActiveAt` (epoch ms) among its non-shell seats, archived
   * included: what the unread roll-up compares with the read cursor
   * (`unreadPartOf`). Null with none.
   */
  readonly activity: number | null
}

/** What the index reads from the pool. */
export interface SeatVerdictHost {
  /** The issue's explicit seats, from the relation index (untracked, maintenance). */
  seats(issueId: string): Iterable<string>
  /** A row as the members group reads it (`peek`: hot or cold), untracked. */
  session(id: string): SliceSession | undefined
  issue(id: string): SliceIssue | undefined
  /** The clock now. */
  now(): number
}

interface Verdict {
  readonly retained: boolean
  readonly roster: boolean
  readonly present: boolean
  /** Its `lastActiveAt` when it counts toward unread (a non-shell seat), else null. */
  readonly activity: number | null
  /** Its finish waits on the issue's finish stamps (`idleDone`). */
  readonly idle: boolean
}

const OUT: Verdict = { retained: false, roster: false, present: false, activity: null, idle: false }
const NO_IDS: readonly string[] = Object.freeze([])
export const NO_SEATS: SeatSummary = Object.freeze({
  retained: NO_IDS,
  roster: NO_IDS,
  present: 0,
  activity: null,
})

/** Insert or remove `id` in a sorted copy (UTF-16 order, as the seat list). */
function withId(list: readonly string[], id: string, on: boolean): readonly string[] {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((list[mid] as string) < id) lo = mid + 1
    else hi = mid
  }
  const has = list[lo] === id
  if (has === on) return list
  const next = list.slice()
  if (on) next.splice(lo, 0, id)
  else next.splice(lo, 1)
  return next
}

/** The finish facts of an issue its idle seats read. */
function finishOf(issue: SliceIssue | undefined): string {
  if (issue === undefined) return ''
  const finished = isFinished(issue)
  return finished ? `1|${issue.closedAt ?? ''}|${issue.updatedAt ?? ''}` : '0'
}

class SeatSummaryEntry {
  @observableRef accessor summary: SeatSummary
  constructor(summary: SeatSummary, readonly verdicts: Map<string, Verdict>, public finish: string) {
    this.summary = summary
  }
}

export class SeatVerdicts {
  /** Per summarised issue: its summary (observable) and each seat's verdict (plain). */
  private readonly issues = new Map<string, SeatSummaryEntry>()
  /** Summarised seat → its issue (a seat belongs to one issue's bucket). */
  private readonly owner = new Map<string, string>()
  private readonly dirtySeats = new Set<string>()
  private readonly dirtyIssues = new Set<string>()
  private readonly moves: [issueId: string, seat: string, added: boolean][] = []
  private readonly expiries = new Map<string, number>()
  private readonly due = new Map<number, Set<string>>()
  private readonly deadlines: number[] = []
  private now: number

  constructor(private readonly host: SeatVerdictHost) {
    this.now = host.now()
  }

  /**
   * TRACKED: issue `id`'s summary. The first read (from a derivation) judges
   * its seats once and keeps them judged from then on; it builds one
   * observable value and writes nothing observed.
   */
  summary(id: string): SeatSummary {
    let entry = this.issues.get(id)
    if (entry === undefined) {
      const verdicts = new Map<string, Verdict>()
      const issue = this.host.issue(id)
      let summary = NO_SEATS
      for (const seat of this.host.seats(id)) {
        const verdict = this.judge(seat, id, issue)
        verdicts.set(seat, verdict)
        this.owner.set(seat, id)
        summary = this.withVerdict(summary, seat, OUT, verdict, verdicts)
      }
      entry = new SeatSummaryEntry(summary, verdicts, finishOf(issue))
      this.issues.set(id, entry)
    }
    return entry.summary
  }

  /** A session's row (hot or cold) moved, or its table slot did. */
  queueSession(id: string): void {
    if (this.owner.has(id)) this.dirtySeats.add(id)
  }

  /** An issue's row moved: its idle seats read its finish stamps. */
  queueIssue(id: string): void {
    if (this.issues.has(id)) this.dirtyIssues.add(id)
  }

  /** The explicit seat bucket of `issueId` moved by one member. */
  queueMember(issueId: string, seat: string, added: boolean): void {
    if (this.issues.has(issueId)) this.moves.push([issueId, seat, added])
  }

  /** Inside the publication's (or load window's) action, after relation upkeep. */
  flush(): void {
    if (this.moves.length === 0 && this.dirtyIssues.size === 0 && this.dirtySeats.size === 0) return
    for (const [issueId, seat, added] of this.moves.splice(0)) {
      const entry = this.issues.get(issueId)
      if (entry === undefined) continue
      if (added) {
        this.owner.set(seat, issueId)
        this.refile(seat)
      } else if (entry.verdicts.has(seat)) {
        this.set(issueId, seat, undefined)
        if (this.owner.get(seat) === issueId) this.owner.delete(seat)
        this.schedule(seat, Number.POSITIVE_INFINITY)
      }
    }
    for (const id of this.dirtyIssues) {
      const entry = this.issues.get(id)
      if (entry === undefined) continue
      const finish = finishOf(this.host.issue(id))
      if (finish === entry.finish) continue
      entry.finish = finish
      // Only an idle finished turn reads the issue (`retains`). A seat whose
      // idleness the issue's finish just made relevant is idle too.
      for (const [seat, verdict] of entry.verdicts) if (verdict.idle) this.dirtySeats.add(seat)
    }
    this.dirtyIssues.clear()
    for (const seat of this.dirtySeats) this.refile(seat)
    this.dirtySeats.clear()
  }

  /** Re-judge the seats whose deadlines the clock crossed (every seat on a rewind). */
  advanceClock(now: number): void {
    const previous = this.now
    this.now = now
    if (now < previous) {
      for (const seat of this.owner.keys()) this.refile(seat)
      return
    }
    while (this.deadlines.length && (this.deadlines[0] as number) <= now) {
      const at = this.deadlines.shift() as number
      const seats = this.due.get(at)
      this.due.delete(at)
      for (const seat of seats ?? NO_IDS) {
        this.expiries.delete(seat)
        this.refile(seat)
      }
    }
  }

  /** Re-judge every summarised seat (an attach replaced the slice). */
  reset(): void {
    // Membership is re-read whole below; queued moves are subsumed.
    this.moves.length = 0
    for (const [id, entry] of this.issues) {
      const seats = new Set(this.host.seats(id))
      for (const seat of [...entry.verdicts.keys()]) {
        if (seats.has(seat)) continue
        this.set(id, seat, undefined)
        if (this.owner.get(seat) === id) this.owner.delete(seat)
        this.schedule(seat, Number.POSITIVE_INFINITY)
      }
      entry.finish = finishOf(this.host.issue(id))
      for (const seat of seats) {
        this.owner.set(seat, id)
        this.refile(seat)
      }
    }
  }

  clear(): void {
    this.issues.clear()
    this.owner.clear()
    this.dirtySeats.clear()
    this.dirtyIssues.clear()
    this.moves.length = 0
    this.expiries.clear()
    this.due.clear()
    this.deadlines.length = 0
  }

  private refile(seat: string): void {
    const issueId = this.owner.get(seat)
    if (issueId === undefined) return
    this.set(issueId, seat, this.judge(seat, issueId, undefined))
  }

  /** `retainedSeatIdsPartOf` / `rosterIdsPartOf` / `openOwnPartOf` for one seat, at the clock. */
  private judge(seat: string, issueId: string, known: SliceIssue | undefined): Verdict {
    const retention = retentionOf(this.host.session(seat))
    let deadline = Number.POSITIVE_INFINITY
    let verdict = OUT
    if (retention !== null) {
      const idle = retention.finish.kind === 'idleDone'
      let retained = false
      if (retention.seat) {
        const issue = idle ? (known ?? this.host.issue(issueId)) : undefined
        const finished =
          issue !== undefined && (isFinished(issue))
        // Only a threshold still ahead is a deadline: a passed one stays
        // passed until the clock rewinds (every seat is re-judged then).
        const passed = (at: number): boolean => {
          if (this.now > at) return true
          deadline = Math.min(deadline, nextUp(at))
          return false
        }
        retained = retains(retention, issue, { finished }, { passed })
      }
      verdict = {
        retained,
        roster: retained && !retention.exited,
        present: retention.issueId === issueId && !retention.archived && !retention.exited,
        activity: retention.shell ? null : activityMsOf(this.host.session(seat)),
        idle,
      }
    }
    this.schedule(seat, deadline)
    return verdict
  }

  /** Record `seat`'s verdict (undefined: it left) and publish the summary when it moved. */
  private set(issueId: string, seat: string, verdict: Verdict | undefined): void {
    // Approved applying-action aggregate (POD-5542): this bucket summary
    // changes one seat; deriving it anew would visit the owner's full roster.
    const entry = this.issues.get(issueId)
    if (entry === undefined) return
    const before = entry.verdicts.get(seat) ?? OUT
    if (verdict !== undefined) entry.verdicts.set(seat, verdict)
    else entry.verdicts.delete(seat)
    const after = verdict ?? OUT
    const summary = entry.summary
    const next = this.withVerdict(summary, seat, before, after, entry.verdicts)
    if (next !== summary) entry.summary = next
  }

  /** The summary with one seat's verdict moved from `before` to `after` (`verdicts` already holds `after`). */
  private withVerdict(
    summary: SeatSummary,
    seat: string,
    before: Verdict,
    after: Verdict,
    verdicts: ReadonlyMap<string, Verdict>,
  ): SeatSummary {
    let activity = summary.activity
    if (after.activity !== null && (activity === null || after.activity > activity))
      activity = after.activity
    else if (
      before.activity !== null &&
      before.activity === activity &&
      after.activity !== activity
    ) {
      // The latest seat fell back or left: the next latest, over this issue's seats.
      activity = null
      for (const other of verdicts.values())
        if (other.activity !== null && (activity === null || other.activity > activity))
          activity = other.activity
    }
    if (
      before.retained === after.retained &&
      before.roster === after.roster &&
      before.present === after.present &&
      activity === summary.activity
    )
      return summary
    return {
      retained: withId(summary.retained, seat, after.retained),
      roster: withId(summary.roster, seat, after.roster),
      present: summary.present + Number(after.present) - Number(before.present),
      activity,
    }
  }

  private schedule(seat: string, at: number): void {
    const previous = this.expiries.get(seat)
    if (previous === at) return
    if (previous !== undefined) {
      const seats = this.due.get(previous)
      seats?.delete(seat)
      if (!seats?.size) {
        this.due.delete(previous)
        const index = this.deadlines.indexOf(previous)
        if (index >= 0) this.deadlines.splice(index, 1)
      }
      this.expiries.delete(seat)
    }
    if (!Number.isFinite(at)) return
    let seats = this.due.get(at)
    if (!seats) {
      seats = new Set()
      this.due.set(at, seats)
      let lo = 0
      let hi = this.deadlines.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if ((this.deadlines[mid] as number) < at) lo = mid + 1
        else hi = mid
      }
      this.deadlines.splice(lo, 0, at)
    }
    seats.add(seat)
    this.expiries.set(seat, at)
  }
}
