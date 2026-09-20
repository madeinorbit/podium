/**
 * POD-4446 — recursive subtree rollup with chain invalidation (spec R-ROLL).
 *
 * The aggregate over an issue's VISIBLE formal subtree (own live sessions
 * plus visible descendants' — the in-slice reading of `aggregateSessions`,
 * since started-by provenance nesting is out per spec §6): motion phase,
 * working flag, asking count (waiting sessions plus pending decisions with
 * the offer-only dedup), and the mission progress rollup over the LIVE
 * formal subtree (visibility-independent, like `missionRollup`).
 *
 * On SummaryChanged(id) only the ancestor chain is recomputed, stopping at
 * the first ancestor whose value is unchanged — a change at depth 3 touches
 * exactly its chain. Spin-off tips and the staffed set are batch-cached.
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
  private cache: BatchCache | null = null

  constructor(
    private readonly tables: { issues: IssueTable; sessions: SessionTable },
    private readonly indexes: IndexSet,
    private readonly summary: SummaryModule,
    private readonly visible: VisibleModule,
    private readonly getNow: () => number,
    private readonly stats: DerivationStats = nullStats,
  ) {}

  // ---------------------------------------------------------- batch cache

  private batch(): BatchCache {
    if (this.cache !== null) return this.cache
    const openExplicit = new Set<string>()
    const lastActive = new Map<string, string>()
    for (const [issueId, bucket] of this.indexes.explicitByIssue) {
      for (const sid of bucket) {
        const s = this.tables.sessions.rows.get(sid)
        if (s === undefined || s.archived) continue
        const seen = lastActive.get(issueId)
        if (seen === undefined || s.lastActiveAt > seen) lastActive.set(issueId, s.lastActiveAt)
        if (openSession(s)) openExplicit.add(issueId)
      }
    }
    const staffed = new Set<string>()
    for (const [issueId, bucket] of this.indexes.explicitByIssue) {
      for (const sid of bucket) {
        const s = this.tables.sessions.rows.get(sid)
        if (s === undefined || s.issueId == null || !openSession(s)) continue
        let id: string | undefined = s.issueId
        while (id !== undefined && !staffed.has(id)) {
          staffed.add(id)
          id = this.indexes.parentOf.get(id)
        }
      }
    }
    this.cache = { openExplicit, staffed, lastActive }
    return this.cache
  }

  // ---------------------------------------------------------- spin-off tips

  private liveDescendants(originId: string): SliceIssue[] {
    const issues = this.tables.issues.rows
    const out: SliceIssue[] = []
    const seen = new Set<string>()
    const stack = [originId]
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const childId of this.indexes.spinOffChildren.get(id) ?? []) {
        if (seen.has(childId)) continue
        seen.add(childId)
        const child = issues.get(childId)
        if (child === undefined) continue
        out.push(child)
        stack.push(childId)
      }
    }
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
    const dependents = (issue as SliceIssue & { dependents?: Array<{ type: string }> }).dependents ?? []
    return dependents.some((dep) => dep.type === 'discovered-from')
  }

  // ---------------------------------------------------------- progress

  /** Formal member walk from a root (missionIssueIds formal half, no fixpoint:
   *  started-by provenance is out of slice — spec §6). */
  private formalMembers(rootId: string): Set<string> {
    const ids = new Set<string>([rootId])
    const stack = [rootId]
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const child of this.indexes.childrenByParent.get(id) ?? []) {
        if (ids.has(child)) continue
        ids.add(child)
        stack.push(child)
      }
    }
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
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const child of this.indexes.childrenByParent.get(id) ?? []) {
        if (seen.has(child) || !this.visible.isVisible(child)) continue
        seen.add(child)
        out.push(child)
        stack.push(child)
      }
    }
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
    const out: string[] = []
    for (const [issueId, bucket] of this.indexes.explicitByIssue) {
      if (bucket.has(sessionId)) out.push(issueId)
    }
    for (const [issueId, bucket] of this.indexes.resolvedByIssue) {
      if (bucket.has(sessionId)) out.push(issueId)
    }
    return out
  }

  apply(batch: Delta[]): Delta[] {
    const out: Delta[] = []
    try {
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
    } finally {
      this.cache = null
    }
  }

  /** Full derive for replace/bootstrap (no deltas; store derives after). */
  rebuildAll(): void {
    this.aggregates.clear()
    this.ticks.clear()
    try {
      for (const id of this.visible.orderedIds()) {
        const next = this.compute(id)
        if (next !== null) {
          this.aggregates.set(id, next)
          this.ticks.set(id, this.tickOf(id))
        }
      }
    } finally {
      this.cache = null
    }
  }
}
