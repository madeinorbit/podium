/**
 * POD-4446 — recursive subtree rollup with chain invalidation (spec R-ROLL).
 * Aggregate over the visible formal subtree (started-by provenance is out,
 * spec §6): phase, working, asking (waiting + pending decisions, offer-only
 * dedup), mission progress over the live formal subtree. On change only the
 * ancestor chain recomputes, stopping at the first unchanged value.
 */

import type { SliceIssue, SliceSession } from '../../shared/src/slice-types'
import { assertNever, nullStats, type Delta, type DerivationStats } from './deltas'
import type { IndexSet } from './indexes'
import {
  hasLeftMission,
  isOfferOnlyAttention,
  isSessionWorking,
  issueAbandoned,
  issueFinished,
  issueFinishedAt,
  issuePendingDecision,
  motionPhase,
  openSession,
  parseMs,
  preferredTip,
  spinOffOriginId,
} from './rules'
import { splitMembers, type SummaryModule } from './summary'
import type { IssueTable, SessionTable } from './tables'
import type { VisibleModule } from './visible'

export interface RollupValue {
  phase: 'queued' | 'working' | 'waiting' | 'done'
  working: boolean
  asking: boolean
  progressDone: number
  progressTotal: number
}

export interface OriginTick {
  id: string
  seq: number
  title: string
  ref: string
}

interface BatchCache {
  /** Issues with ≥1 open explicit session (missionSessionIndex.openIssues). */
  openExplicit: Set<string>
  /** Every issue with an open session on it or beneath it (formal parents). */
  staffed: Set<string>
  /** Latest explicit non-archived lastActiveAt per issue (tip ordering). */
  lastActive: Map<string, string>
}

export class RollupModule {
  /** Aggregates by issue id (visible rows only). */
  readonly aggregates = new Map<string, RollupValue>()
  /** Origin tick per visible row (R-ORIGIN renders beside the row). */
  readonly ticks = new Map<string, OriginTick | null>()
  /**
   * J1 (POD-4453): the old `batch()` rebuilt these three seats from scratch
   * on every computing dispatch (~2× session seats + staffed ancestor steps,
   * ~11.2k visits at 1x — the M2 note's REMOVABLE slope item). They are now
   * maintained incrementally: per-issue open counts + lastActive maxima
   * recomputed from the touched issue's bucket only (O(bucket), typically 1
   * session), staffed as ancestor refcounts adjusted on open flips and parent
   * moves (O(depth)). Reads below are O(1); no `rollup-batch` scan remains
   * on the event path. Bootstrap/replace still build once (cold path).
   */
  readonly openExplicit = new Set<string>()
  readonly staffed = new Set<string>()
  readonly lastActive = new Map<string, string>()
  private readonly openCounts = new Map<string, number>()
  private readonly staffedCounts = new Map<string, number>()
  private readonly sessionSnaps = new Map<
    string,
    { issue: string | null; open: boolean; lastActiveAt: string; archived: boolean }
  >

  constructor(
    private readonly tables: { issues: IssueTable; sessions: SessionTable },
    private readonly indexes: IndexSet,
    private readonly summary: SummaryModule,
    private readonly visible: VisibleModule,
    private readonly getNow: () => number,
    private readonly stats: DerivationStats = nullStats,
  ) {}

  // ---------------------------------------------------------- seat maintenance

  /**
   * Seats read by every compute, maintained incrementally (see the field
   * comment). Semantics mirror the old from-scratch build exactly: open counts
   * sessions with `openSession` in the issue's explicit bucket, lastActive
   * takes the max non-archived lastActiveAt, staffed is the ancestor closure
   * of open issues through `parentOf`.
   */
  private batch(): BatchCache {
    return { openExplicit: this.openExplicit, staffed: this.staffed, lastActive: this.lastActive }
  }

  /** Recompute one issue's open/lastActive seat from its bucket only. */
  private refreshIssueSeat(issueId: string): void {
    const bucket = this.indexes.explicitByIssue.get(issueId)
    let open = 0
    let best: string | undefined
    if (bucket !== undefined) {
      for (const sid of bucket) {
        const s = this.tables.sessions.rows.get(sid)
        if (s === undefined) continue
        if (!s.archived && (best === undefined || s.lastActiveAt > best)) best = s.lastActiveAt
        if (openSession(s)) open += 1
      }
    }
    const prevBest = this.lastActive.get(issueId)
    if (best === undefined) {
      if (prevBest !== undefined) this.lastActive.delete(issueId)
    } else if (prevBest !== best) {
      this.lastActive.set(issueId, best)
    }
    const wasOpen = this.openExplicit.has(issueId)
    if (open > 0) this.openCounts.set(issueId, open)
    else this.openCounts.delete(issueId)
    if (wasOpen === open > 0) return
    if (open > 0) {
      this.openExplicit.add(issueId)
      this.staffUp(issueId)
    } else {
      this.openExplicit.delete(issueId)
      this.staffDown(issueId)
    }
  }

  /** +1 along the issue and its formal ancestors (cycle-safe). */
  private staffUp(issueId: string): void {
    let current: string | undefined = issueId
    const walked = new Set<string>()
    while (current !== undefined && !walked.has(current)) {
      walked.add(current)
      this.staffedCounts.set(current, (this.staffedCounts.get(current) ?? 0) + 1)
      this.staffed.add(current)
      current = this.indexes.parentOf.get(current)
    }
  }

  /** −1 along the issue and its formal ancestors (cycle-safe). */
  private staffDown(issueId: string): void {
    let current: string | undefined = issueId
    const walked = new Set<string>()
    while (current !== undefined && !walked.has(current)) {
      walked.add(current)
      const next = (this.staffedCounts.get(current) ?? 1) - 1
      if (next <= 0) {
        this.staffedCounts.delete(current)
        this.staffed.delete(current)
      } else {
        this.staffedCounts.set(current, next)
      }
      current = this.indexes.parentOf.get(current)
    }
  }

  private chainUp(start: string | null): void {
    let current: string | undefined = start ?? undefined
    const walked = new Set<string>()
    while (current !== undefined && !walked.has(current)) {
      walked.add(current)
      this.staffedCounts.set(current, (this.staffedCounts.get(current) ?? 0) + 1)
      this.staffed.add(current)
      current = this.indexes.parentOf.get(current)
    }
  }

  private chainDown(start: string | null): void {
    let current: string | undefined = start ?? undefined
    const walked = new Set<string>()
    while (current !== undefined && !walked.has(current)) {
      walked.add(current)
      const next = (this.staffedCounts.get(current) ?? 1) - 1
      if (next <= 0) {
        this.staffedCounts.delete(current)
        this.staffed.delete(current)
      } else {
        this.staffedCounts.set(current, next)
      }
      current = this.indexes.parentOf.get(current)
    }
  }

  /** Open issues in the formal subtree rooted at `rootId` (self included). */
  private openInSubtree(rootId: string): string[] {
    const out: string[] = []
    if (this.openExplicit.has(rootId)) out.push(rootId)
    const stack = [rootId]
    const seen = new Set<string>([rootId])
    let visits = 0
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const child of this.indexes.childrenByParent.get(id) ?? []) {
        visits += 1
        if (seen.has(child)) continue
        seen.add(child)
        if (this.openExplicit.has(child)) out.push(child)
        stack.push(child)
      }
    }
    this.stats.scan('rollup-walk', visits)
    return out
  }

  /** A parent edge moved: re-hang the moved subtree's open issues. */
  private rehangStaffing(childId: string, from: string | null, to: string | null): void {
    if (from === to) return
    const open = this.openInSubtree(childId)
    if (open.length === 0) return
    for (let i = 0; i < open.length; i += 1) {
      this.chainDown(from)
      this.chainUp(to)
    }
  }

  /** Diff one session row against its snapshot; refresh touched seats. */
  private noteSession(sessionId: string): void {
    const s = this.tables.sessions.rows.get(sessionId)
    const prev = this.sessionSnaps.get(sessionId)
    const home = s !== undefined && s.headless !== true && s.issueId != null ? s.issueId : null
    if (s === undefined) {
      if (prev?.issue != null) this.refreshIssueSeat(prev.issue)
      this.sessionSnaps.delete(sessionId)
      return
    }
    const snap = { issue: home, open: openSession(s), lastActiveAt: s.lastActiveAt, archived: s.archived }
    this.sessionSnaps.set(sessionId, snap)
    if ((prev?.issue ?? null) !== home) {
      if (prev?.issue != null) this.refreshIssueSeat(prev.issue)
      if (home !== null) this.refreshIssueSeat(home)
      return
    }
    if (home !== null) {
      if (
        prev === undefined ||
        prev.open !== snap.open ||
        prev.lastActiveAt !== snap.lastActiveAt ||
        prev.archived !== snap.archived
      ) {
        this.refreshIssueSeat(home)
      }
    }
  }

  // ---------------------------------------------------------- spin-off tips

  private liveDescendants(originId: string): SliceIssue[] {
    const issues = this.tables.issues.rows
    const out: SliceIssue[] = []
    const seen = new Set<string>()
    const stack = [originId]
    let visits = 0
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const childId of this.indexes.spinOffChildren.get(id) ?? []) {
        visits += 1
        if (seen.has(childId)) continue
        seen.add(childId)
        const child = issues.get(childId)
        if (child === undefined) continue
        out.push(child)
        stack.push(childId)
      }
    }
    this.stats.scan('rollup-walk', visits)
    return out
  }

  /** liveSpinOffTip (mission.ts:780): where the work went after a hop. */
  spinOffTip(originId: string): SliceIssue | null {
    const cache = this.batch()
    const branches = new Map<string, SliceIssue[]>()
    for (const issue of this.liveDescendants(originId)) {
      const origin = spinOffOriginId(issue)
      if (!hasLeftMission(issue.stage, origin) && !(origin !== null && cache.openExplicit.has(issue.id))) {
        continue
      }
      let branchRoot = issue
      let parentId = spinOffOriginId(branchRoot)
      while (parentId !== null && parentId !== originId) {
        const parent = this.tables.issues.rows.get(parentId)
        if (parent === undefined) break
        branchRoot = parent
        parentId = spinOffOriginId(parent)
      }
      if (parentId !== originId) continue
      const branch = branches.get(branchRoot.id) ?? []
      branch.push(issue)
      branches.set(branchRoot.id, branch)
    }
    const tips: SliceIssue[] = []
    for (const branch of branches.values()) {
      const tip = preferredTip(branch, (id) => cache.openExplicit.has(id), (id) => this.lastActiveOf(id))
      if (tip !== null) tips.push(tip)
    }
    return preferredTip(tips, (id) => cache.openExplicit.has(id), (id) => this.lastActiveOf(id))
  }

  private lastActiveOf(issueId: string): string {
    const issue = this.tables.issues.rows.get(issueId)
    const latest = issue?.updatedAt ?? ''
    const seen = this.batch().lastActive.get(issueId)
    return seen !== undefined && seen > latest ? seen : latest
  }

  /** issueContinuation presence (mission.ts:2207): supersede/dupe, else hop. */
  private continuationOf(issue: SliceIssue): boolean {
    const extra = issue as SliceIssue & { supersededBy?: string; duplicateOf?: string }
    if (extra.supersededBy ?? extra.duplicateOf) return true
    if (this.batch().openExplicit.has(issue.id)) return false
    return this.spinOffTip(issue.id) !== null
  }

  /** isVacatedOrigin (mission.ts:794): sessionless, work continued elsewhere. */
  private vacatedOrigin(issue: SliceIssue): boolean {
    const bucket = this.indexes.explicitByIssue.get(issue.id)
    if (bucket !== undefined) {
      for (const sid of bucket) {
        const s = this.tables.sessions.rows.get(sid)
        if (s !== undefined && s.issueId === issue.id && openSession(s)) return false
      }
    }
    if (this.spinOffTip(issue.id) !== null) return true
    return (this.indexes.dependentsOf.get(issue.id) ?? []).some((dep) => dep.type === 'discovered-from')
  }

  // ---------------------------------------------------------- progress

  /** Formal member walk from a root (missionIssueIds formal half, no fixpoint:
   *  started-by provenance is out of slice — spec §6). */
  private formalMembers(rootId: string): Set<string> {
    const ids = new Set<string>([rootId])
    const stack = [rootId]
    let visits = 0
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const child of this.indexes.childrenByParent.get(id) ?? []) {
        visits += 1
        if (ids.has(child)) continue
        ids.add(child)
        stack.push(child)
      }
    }
    this.stats.scan('rollup-walk', visits)
    return ids
  }

  /** missionRollup units + exclusive buckets (mission.ts:1329), formal only. */
  private progressOf(rootId: string): { done: number; total: number } {
    const issues = this.tables.issues.rows
    const formal = this.formalMembers(rootId)
    formal.delete(rootId)
    const live = (id: string): boolean => {
      const issue = issues.get(id)
      return issue !== undefined && issue.archived !== true && issue.deletedAt == null
    }
    const members = [...formal].filter((id) => {
      const issue = issues.get(id)
      return (
        issue !== undefined &&
        live(id) &&
        issue.stage !== 'proposed' &&
        !issueAbandoned(issue)
      )
    })
    const fromChildren = members.length > 0
    const staffed = this.batch().staffed
    const units = (fromChildren ? members : live(rootId) ? [rootId] : []).filter((id) => {
      const issue = issues.get(id)
      return issue !== undefined && !issueAbandoned(issue) && !this.vacatedOrigin(issue)
    })
    let done = 0
    let run = 0
    let review = 0
    let stall = 0
    let block = 0
    for (const id of units) {
      const issue = issues.get(id) as SliceIssue
      if (issueFinished(issue)) done += 1
      else if (issue.blocked === true) block += 1
      else if (issue.stage === 'review') review += 1
      else if (issue.stage === 'planning' || issue.stage === 'in_progress' || issue.stage === 'shipping') {
        if (issue.stage === 'shipping' || staffed.has(id)) run += 1
        else stall += 1
      }
    }
    return { done, total: units.length }
  }

  // ---------------------------------------------------------- aggregate

  private ownLive(issueId: string): SliceSession[] {
    const issue = this.tables.issues.rows.get(issueId)
    if (issue === undefined) return []
    return splitMembers(this.summary.membersOf(issueId), this.getNow(), issue).live
  }

  /** Visible formal subtree: own row plus visible descendants, cycle-safe. */
  private visibleSubtree(rootId: string): string[] {
    const out: string[] = [rootId]
    const seen = new Set<string>([rootId])
    const stack = [rootId]
    let visits = 0
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const child of this.indexes.childrenByParent.get(id) ?? []) {
        visits += 1
        if (seen.has(child) || !this.visible.isVisible(child)) continue
        seen.add(child)
        out.push(child)
        stack.push(child)
      }
    }
    this.stats.scan('rollup-walk', visits)
    return out
  }

  compute(issueId: string): RollupValue | null {
    const root = this.tables.issues.rows.get(issueId)
    if (root === undefined || !this.visible.isVisible(issueId)) return null
    this.stats.aggregates()
    const members = this.visibleSubtree(issueId)
    const ownByMember = new Map<string, SliceSession[]>()
    const sessions: SliceSession[] = []
    for (const id of members) {
      const own = this.ownLive(id)
      ownByMember.set(id, own)
      sessions.push(...own)
    }
    // Pending decisions over the visible subtree (row-attention.ts:162).
    let pending = 0
    const deciding = new Set<string>()
    let sinceMs: number | undefined
    for (const id of members) {
      const member = this.tables.issues.rows.get(id) as SliceIssue
      const decision = issuePendingDecision(member)
      if (decision === null) continue
      if (!issueFinished(member) && (ownByMember.get(id) ?? []).some(isSessionWorking)) continue
      if (decision === 'review' && this.continuationOf(member)) continue
      pending += 1
      for (const s of ownByMember.get(id) ?? []) deciding.add(s.sessionId)
      const at = issueFinishedAt(member)
      if (at > 0 && (sinceMs === undefined || at < sinceMs)) sinceMs = at
    }
    void sinceMs
    // Phase (rowMotionPhase, row-attention.ts:45).
    let phase: RollupValue['phase']
    if (pending > 0) {
      phase = 'waiting'
    } else if (sessions.length === 0 && issueFinished(root)) {
      phase = 'done'
    } else {
      const kinds = sessions.map((s) => motionPhase(s, root))
      if (kinds.includes('waiting')) phase = 'waiting'
      else if (kinds.includes('working')) phase = 'working'
      else if (kinds.length > 0 && kinds.every((k) => k === 'done')) phase = 'done'
      else phase = 'queued'
      if (phase === 'done' && !issueFinished(root)) phase = 'queued'
    }
    const working = sessions.some(isSessionWorking)
    // Asking (rowWaitingCount, row-attention.ts:116): waiting sessions with
    // the offer-only dedup, plus pending decisions.
    const waiting = sessions.filter((s) => motionPhase(s, root) === 'waiting')
    const extra = waiting.filter((s) => !(isOfferOnlyAttention(s) && deciding.has(s.sessionId)))
    const progress = this.progressOf(issueId)
    return {
      phase,
      working,
      asking: extra.length + pending > 0,
      progressDone: progress.done,
      progressTotal: progress.total,
    }
  }

  tickOf(issueId: string): OriginTick | null {
    const issue = this.tables.issues.rows.get(issueId)
    if (issue === undefined) return null
    const originId = this.indexes.originOf.get(issueId)
    if (originId === undefined) return null
    const origin = this.tables.issues.rows.get(originId)
    if (origin === undefined) return null
    const prefix = this.indexes.prefixForRepo(origin.repoId)
    return {
      id: origin.id,
      seq: origin.seq,
      title: origin.title,
      ref: prefix ? `${prefix}-${origin.seq}` : `#${origin.seq}`,
    }
  }

  /** Recompute one row; emit RollupChanged iff the value moved. */
  refresh(issueId: string, out: Delta[]): void {
    const next = this.compute(issueId)
    const prev = this.aggregates.get(issueId)
    if (next === null) {
      if (prev !== undefined) {
        this.aggregates.delete(issueId)
        this.ticks.delete(issueId)
        out.push({ kind: 'RollupChanged', id: issueId })
      }
      return
    }
    const tick = this.tickOf(issueId)
    const prevTick = this.ticks.get(issueId)
    if (
      prev === undefined ||
      JSON.stringify(prev) !== JSON.stringify(next) ||
      JSON.stringify(prevTick ?? null) !== JSON.stringify(tick)
    ) {
      this.aggregates.set(issueId, next)
      this.ticks.set(issueId, tick)
      out.push({ kind: 'RollupChanged', id: issueId })
    }
  }

  /** Ancestor chain recompute, stopping at the first unchanged value. */
  private refreshChain(seed: string, out: Delta[]): void {
    const done = new Set<string>()
    let current: string | undefined = seed
    const walked = new Set<string>()
    while (current !== undefined && !walked.has(current)) {
      walked.add(current)
      if (!done.has(current) && this.visible.isVisible(current)) {
        done.add(current)
        const before = this.aggregates.get(current)
        this.refresh(current, out)
        const after = this.aggregates.get(current)
        if (before !== undefined && JSON.stringify(before) === JSON.stringify(after)) return
        if (before === undefined && after === undefined) return
      }
      current = this.indexes.parentOf.get(current)
    }
  }

  private memberIssuesOfSession(sessionId: string): string[] {
    return this.indexes.memberIssuesOfSession(sessionId)
  }

  apply(batch: Delta[]): Delta[] {
    const out: Delta[] = []
    // Seat maintenance first (indexes already applied): session diffs refresh
    // touched buckets, parent moves re-hang the moved subtree. Reads in the
    // chain phase below then see current seats.
    for (const delta of batch) {
      switch (delta.kind) {
        case 'SessionChanged':
          this.noteSession(delta.id)
          break
        case 'SessionRemoved':
          this.noteSession(delta.id)
          break
        case 'IssueRemoved':
          this.refreshIssueSeat(delta.id)
          break
        case 'MembershipChanged':
          this.refreshIssueSeat(delta.issueId)
          break
        case 'ChildrenChanged':
          this.rehangStaffing(delta.childId, delta.from, delta.to)
          break
        case 'IssueChanged':
        case 'WorktreeChanged':
        case 'WorktreeRemoved':
        case 'OriginChanged':
        case 'SummaryChanged':
        case 'RollupChanged':
        case 'VisibilityChanged':
        case 'OrderChanged':
        case 'GroupChanged':
        case 'RowChanged':
        case 'SelectionChanged':
        case 'ClockChanged':
          break
        default:
          assertNever(delta)
      }
    }
    {
      const seeds = new Set<string>()
      const chains = new Set<string>()
      for (const delta of batch) {
        switch (delta.kind) {
          case 'MembershipChanged':
          case 'SummaryChanged':
          case 'OriginChanged':
            seeds.add(delta.kind === 'MembershipChanged' ? delta.issueId : delta.id)
            break
          case 'IssueChanged':
          case 'SessionChanged':
            if (delta.kind === 'IssueChanged') seeds.add(delta.id)
            for (const issueId of this.memberIssuesOfSession(delta.id)) seeds.add(issueId)
            break
          case 'VisibilityChanged':
            if (delta.visible) seeds.add(delta.id)
            else {
              this.aggregates.delete(delta.id)
              this.ticks.delete(delta.id)
            }
            break
          case 'ChildrenChanged': {
            if (delta.from !== null) chains.add(delta.from)
            if (delta.to !== null) chains.add(delta.to)
            break
          }
          case 'IssueRemoved':
          case 'SessionRemoved':
            this.aggregates.delete(delta.id)
            this.ticks.delete(delta.id)
            break
          case 'WorktreeChanged':
          case 'WorktreeRemoved':
          case 'RollupChanged':
          case 'OrderChanged':
          case 'GroupChanged':
          case 'RowChanged':
          case 'SelectionChanged':
          case 'ClockChanged':
            break
          default:
            assertNever(delta)
        }
      }
      for (const id of seeds) this.refreshChain(id, out)
      for (const id of chains) {
        // Old/new parent subtrees changed shape: recompute the chain above.
        let current: string | undefined = id
        const walked = new Set<string>()
        while (current !== undefined && !walked.has(current)) {
          walked.add(current)
          if (this.visible.isVisible(current)) this.refresh(current, out)
          else break
          current = this.indexes.parentOf.get(current)
        }
      }
      return out
    }
  }

  /** Full derive for replace/bootstrap (no deltas; store derives after). */
  rebuildAll(): void {
    this.aggregates.clear()
    this.ticks.clear()
    this.buildSeats()
    for (const id of this.visible.orderedIds()) {
      const next = this.compute(id)
      if (next !== null) {
        this.aggregates.set(id, next)
        this.ticks.set(id, this.tickOf(id))
      }
    }
  }

  /** Cold-path seat build (bootstrap/replace only): one pass, no scans. */
  private buildSeats(): void {
    this.openExplicit.clear()
    this.staffed.clear()
    this.lastActive.clear()
    this.openCounts.clear()
    this.staffedCounts.clear()
    this.sessionSnaps.clear()
    for (const [issueId, bucket] of this.indexes.explicitByIssue) {
      let open = 0
      let best: string | undefined
      for (const sid of bucket) {
        const s = this.tables.sessions.rows.get(sid)
        if (s === undefined) continue
        if (!s.archived && (best === undefined || s.lastActiveAt > best)) best = s.lastActiveAt
        if (openSession(s)) open += 1
      }
      if (best !== undefined) this.lastActive.set(issueId, best)
      if (open > 0) {
        this.openCounts.set(issueId, open)
        this.openExplicit.add(issueId)
      }
    }
    for (const [sid, s] of this.tables.sessions.rows) {
      this.sessionSnaps.set(sid, {
        issue: s.headless !== true && s.issueId != null ? s.issueId : null,
        open: openSession(s),
        lastActiveAt: s.lastActiveAt,
        archived: s.archived,
      })
    }
    for (const issueId of this.openExplicit) this.staffUp(issueId)
  }
}
