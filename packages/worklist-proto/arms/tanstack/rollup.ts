/**
 * POD-4448 — the ONE custom derived collection (methodology §5.4): the
 * recursive subtree rollup with chain invalidation (spec R-ROLL), plus the
 * two graph fixpoints the query language cannot express (rescue keeper
 * chains, spec R-VIS.3; agent nesting drops) and the single origin tick
 * (spec R-ORIGIN). Everything relational ELSE is a live query; this sync is
 * the only imperative derivation in the arm.
 *
 * Inputs (all subscribed, so no silent staleness): issues rows, childQ
 * edges, verdictQ member verdicts, summaryQ flat flags + band + repoKey,
 * and prefix bumps via notePrefixChanged(). Flat membership is read off
 * summaryQ events, NOT visibleQ events: visibleQ's pure-DSL `where`
 * retractions emit no change event when an upstream update makes a row
 * fail the predicate (verified M2 — state goes correct, subscribers hear
 * nothing), while summaryQ's `fn` re-runs and notifies on every
 * (excluded, flat) flip. visibleQ remains the graph's declared visible
 * set (bootstrap seeds from it), but nothing subscribes to it.
 * Outputs: one RollupRow
 * per issue with the subtree aggregate, the final visibility flag, the
 * tick, and denormalized rank/lane inputs (band, sortKeyEnc, createdAt,
 * seq, pinned, repoKey, fold inputs) so orderQ/laneQ stay single-source
 * pure queries over this collection.
 *
 * Invalidation rule: a member-verdict change recomputes its owner's chain
 * up to the root, stopping at the first value-unchanged ancestor; a child
 * edge move recomputes the full chains above both ends (shape changed, no
 * early stop); a flat flip (seen on summaryQ) reconciles keeper chains
 * (which can flip further ancestors) and seeds the affected chains; an
 * issue change reseats origin/dependent/tick/rank inputs and seeds its own
 * chain; summary band/repoKey-only changes rewrite denormalized denorm
 * without chains; prefix bumps re-tick named rows. Every recompute is
 * value-compared — unchanged values write nothing downstream.
 */

import type { Collection } from '@tanstack/db'
import type { SliceIssue, SliceSession } from '../../shared/src/slice-types'
import { EntitySync, type PrefixIndex } from './collections'
import type { ChildRow, LiveQuery, QueryChange, SummaryRow, VerdictRow } from './queries'
import type { ResolveRow } from './queries'
import {
  displayRefOf,
  plainDeps,
  encodeSortKey,
  groupKeyOf,
  hasLeftMission,
  issueAbandoned,
  issueFinished,
  issueFinishedAt,
  issuePendingDecision,
  motionPhaseFromParts,
  openSession,
  preferredTip,
  rescueEligible,
  spinOffOriginId,
  bandOf,
} from './rules'

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

export interface RollupRow {
  id: string
  marker: 1
  /** Flat minus drops plus rescue — the final visible set. */
  final: boolean
  phase: RollupValue['phase']
  working: boolean
  asking: boolean
  progressDone: number
  progressTotal: number
  band: 0 | 1 | 2
  repoKey: string
  repoPath: string
  sortKeyEnc: string
  createdAt: string
  seq: number
  pinned: boolean
  parentId: string | null | undefined
  audience: 'human' | 'agent' | undefined
  stage: string
  closedReason: string | null | undefined
  needsHuman: boolean | undefined
  tuckedAt: string | null | undefined
  closedAt: string | null | undefined
  updatedAt: string
  finishedAt: number
  tickId: string | null
  tickSeq: number | null
  tickTitle: string | null
  tickRef: string | null
}

interface IssueRead {
  get(id: string): SliceIssue | undefined
  keys(): Iterable<string>
}

interface Change<T> {
  type: 'insert' | 'update' | 'delete'
  key: string | number
  value?: T
}

export interface RollupInputs {
  issues: IssueRead
  issuesEvents: LiveQuery
  resolveQ: LiveQuery
  childQ: LiveQuery
  verdictQ: LiveQuery
  verdictR: LiveQuery
  summaryQ: LiveQuery
  prefix: PrefixIndex
}

export class RollupSync {
  readonly sync: EntitySync<RollupRow>
  readonly collection: Collection<RollupRow, string, Record<string, never>>
  /** Ticks per visible row (R-ORIGIN renders beside the row). */
  readonly ticks = new Map<string, OriginTick | null>()
  private readonly childrenByParent = new Map<string, Set<string>>()
  private readonly parentOf = new Map<string, string>()
  private readonly memberSeats = new Map<string, Map<string, VerdictRow>>()
  private readonly sidOwner = new Map<string, Set<string>>()
  private readonly resolveKey = new Map<string, string | null>()
  private readonly originOf = new Map<string, string>()
  private readonly spinOffChildren = new Map<string, Set<string>>()
  private readonly dependentsOf = new Map<string, Array<{ id: string; type: string }>>()
  private readonly outgoingDeps = new Map<string, Array<{ to: string; type: string }>>()
  private readonly flat = new Set<string>()
  private readonly keptBy = new Map<string, Set<string>>()
  private readonly chains = new Map<string, string[]>()
  private readonly rescue = new Set<string>()
  private readonly dropped = new Set<string>()
  private readonly final = new Set<string>()
  private readonly aggregates = new Map<string, RollupValue>()
  private readonly written = new Map<string, string>()
  private readonly bandById = new Map<string, 0 | 1 | 2>()
  private readonly repoKeyById = new Map<string, string>()
  /** Seats dropped in this flush (retraction half of a del+ins pair nets
   *  zero against its re-add — indexUpdates counts net membership moves,
   *  the hand arm's seat semantics). */
  private readonly droppedSeats = new Set<string>()
  private batch: {
    openExplicit: Set<string>
    lastActive: Map<string, string>
  } | null = null
  private batching = false
  private dirtyChains = new Set<string>()
  private fullChains = new Set<string>()
  private readonly unsubs: Array<() => void> = []

  constructor(
    private readonly inputs: RollupInputs,
    private readonly countRollup: () => void,
    private readonly countIndex: () => void,
    private readonly countScan?: (name: string, visits: number) => void,
  ) {
    this.sync = new EntitySync<RollupRow>('tanstack-arm.rollup', [], (row) => row.id)
    this.collection = this.sync.collection as unknown as Collection<
      RollupRow,
      string,
      Record<string, never>
    >
  }

  subscribe(): void {
    const subs = [
      this.inputs.issuesEvents.subscribeChanges((changes) => {
        for (const c of changes) {
          const id = String(c.key)
          const irow = c.value as SliceIssue | undefined
          this.ingestIssue(id, c.type === 'delete' ? undefined : irow)
        }
      }),
      // Join-key moves arrive here first (resolveQ is upstream of the
      // verdicts): drop the session's seats when its key moved — the verdict
      // insert/update re-seats under the new owner. Value-only changes share
      // the key and are ignored. Deletes are silent upstream — session
      // removals arrive explicitly via dropSession, issue removals via
      // ingestIssue.
      this.inputs.resolveQ.subscribeChanges((changes) => {
        for (const c of changes) {
          if (c.type === 'delete') continue
          const v = c.value as ResolveRow | undefined
          if (v === undefined) continue
          // Join-key moves (explicit reassign, R3 re-resolution) drop the
          // session's seats; the verdict insert/update re-seats. Value-only
          // changes share the key and stop here — no churn.
          if (this.resolveKey.get(v.sid) !== (v.joinKey ?? null)) {
            this.resolveKey.set(v.sid, v.joinKey ?? null)
            if (this.sidOwner.has(v.sid)) this.dropSession(v.sid)
          }
        }
      }),
      this.inputs.childQ.subscribeChanges((changes) => this.ingestChild(changes)),
      this.inputs.verdictQ.subscribeChanges((changes) => this.ingestVerdict(changes)),
      this.inputs.verdictR.subscribeChanges((changes) => this.ingestVerdict(changes)),
      this.inputs.summaryQ.subscribeChanges((changes) => this.ingestSummary(changes)),
    ]
    for (const sub of subs) this.unsubs.push(() => sub.unsubscribe())
  }

  dispose(): void {
    for (const off of this.unsubs.splice(0)) {
      try {
        off()
      } catch {
        // Teardown is best-effort.
      }
    }
  }

  // ------------------------------------------------------------ seats

  private takeSeat(map: Map<string, Set<string>>, key: string, id: string): boolean {
    let bucket = map.get(key)
    if (bucket === undefined) {
      bucket = new Set()
      map.set(key, bucket)
    }
    if (bucket.has(id)) return false
    bucket.add(id)
    this.countIndex()
    return true
  }

  private dropSeat(map: Map<string, Set<string>>, key: string, id: string): boolean {
    const bucket = map.get(key)
    if (bucket === undefined || !bucket.delete(id)) return false
    if (bucket.size === 0) map.delete(key)
    this.countIndex()
    return true
  }

  // ------------------------------------------------------------ batch cache

  private batchCache(): NonNullable<RollupSync['batch']> {
    if (this.batch !== null) return this.batch
    const openExplicit = new Set<string>()
    const lastActive = new Map<string, string>()
    for (const [owner, seats] of this.memberSeats) {
      for (const v of seats.values()) {
        if (!v.explicit) continue
        const seen = lastActive.get(owner)
        if (seen === undefined || v.activeAt > seen) lastActive.set(owner, v.activeAt)
        if (openSession({ archived: v.archived, status: v.status } as SliceSession)) {
          openExplicit.add(owner)
        }
      }
    }
    this.batch = { openExplicit, lastActive }
    return this.batch
  }

  // ---------------------------------------------------------- spin-off tips

  private liveDescendants(originId: string): SliceIssue[] {
    const out: SliceIssue[] = []
    const seen = new Set<string>()
    const stack = [originId]
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const childId of this.spinOffChildren.get(id) ?? []) {
        if (seen.has(childId)) continue
        seen.add(childId)
        const child = this.inputs.issues.get(childId)
        if (child === undefined) continue
        out.push(child)
        stack.push(childId)
      }
    }
    return out
  }

  private spinOffTip(originId: string): SliceIssue | null {
    const cache = this.batchCache()
    const branches = new Map<string, SliceIssue[]>()
    for (const issue of this.liveDescendants(originId)) {
      const origin = spinOffOriginId(issue)
      if (
        !hasLeftMission(issue.stage, origin) &&
        !(origin !== null && cache.openExplicit.has(issue.id))
      ) {
        continue
      }
      let branchRoot = issue
      let parentId = spinOffOriginId(branchRoot)
      while (parentId !== null && parentId !== originId) {
        const parent = this.inputs.issues.get(parentId)
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
      const tip = preferredTip(
        branch,
        (id) => cache.openExplicit.has(id),
        (id) => this.lastActiveOf(id),
      )
      if (tip !== null) tips.push(tip)
    }
    return preferredTip(
      tips,
      (id) => cache.openExplicit.has(id),
      (id) => this.lastActiveOf(id),
    )
  }

  private lastActiveOf(issueId: string): string {
    const issue = this.inputs.issues.get(issueId)
    const latest = issue?.updatedAt ?? ''
    const seen = this.batchCache().lastActive.get(issueId)
    return seen !== undefined && seen > latest ? seen : latest
  }

  private continuationOf(issue: SliceIssue): boolean {
    const extra = issue as SliceIssue & { supersededBy?: string; duplicateOf?: string }
    if (extra.supersededBy ?? extra.duplicateOf) return true
    if (this.batchCache().openExplicit.has(issue.id)) return false
    return this.spinOffTip(issue.id) !== null
  }

  private vacatedOrigin(issue: SliceIssue): boolean {
    const seats = this.memberSeats.get(issue.id)
    if (seats !== undefined) {
      for (const [, v] of seats) {
        if (!v.explicit) continue
        if (openSession({ archived: v.archived, status: v.status } as SliceSession)) return false
      }
    }
    if (this.spinOffTip(issue.id) !== null) return true
    return (this.dependentsOf.get(issue.id) ?? []).some((dep) => dep.type === 'discovered-from')
  }

  // ---------------------------------------------------------- progress

  private formalMembers(rootId: string): Set<string> {
    const ids = new Set<string>([rootId])
    const stack = [rootId]
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const child of this.childrenByParent.get(id) ?? []) {
        if (ids.has(child)) continue
        ids.add(child)
        stack.push(child)
      }
    }
    return ids
  }

  private progressOf(rootId: string): { done: number; total: number } {
    const issues = this.inputs.issues
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
    const units = (members.length > 0 ? members : live(rootId) ? [rootId] : []).filter((id) => {
      const issue = issues.get(id)
      return issue !== undefined && !issueAbandoned(issue) && !this.vacatedOrigin(issue)
    })
    let done = 0
    for (const id of units) {
      const issue = issues.get(id) as SliceIssue
      if (issueFinished(issue)) done += 1
    }
    return { done, total: units.length }
  }

  // ---------------------------------------------------------- aggregate

  private ownLive(issueId: string): VerdictRow[] {
    const out: VerdictRow[] = []
    for (const v of this.memberSeats.get(issueId)?.values() ?? []) {
      if (v.live) out.push(v)
    }
    return out
  }

  private visibleSubtree(rootId: string): string[] {
    const out: string[] = [rootId]
    const seen = new Set<string>([rootId])
    const stack = [rootId]
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const child of this.childrenByParent.get(id) ?? []) {
        if (seen.has(child) || !this.final.has(child)) continue
        seen.add(child)
        out.push(child)
        stack.push(child)
      }
    }
    return out
  }

  compute(issueId: string): RollupValue | null {
    const root = this.inputs.issues.get(issueId)
    if (root === undefined || !this.final.has(issueId)) return null
    this.countRollup()
    const rootFinished = issueFinished(root)
    const members = this.visibleSubtree(issueId)
    const ownByMember = new Map<string, VerdictRow[]>()
    const sessions: VerdictRow[] = []
    for (const id of members) {
      const own = this.ownLive(id)
      ownByMember.set(id, own)
      sessions.push(...own)
    }
    let pending = 0
    const deciding = new Set<string>()
    for (const id of members) {
      const member = this.inputs.issues.get(id)
      if (member === undefined) continue
      if (issuePendingDecision(member) === null) continue
      const own = ownByMember.get(id) ?? []
      if (!issueFinished(member) && own.some((v) => v.workingNow)) continue
      if (issuePendingDecision(member) === 'review' && this.continuationOf(member)) continue
      pending += 1
      for (const v of own) deciding.add(v.sid)
    }
    let phase: RollupValue['phase']
    if (pending > 0) {
      phase = 'waiting'
    } else if (sessions.length === 0 && rootFinished) {
      phase = 'done'
    } else {
      const kinds = sessions.map((v) =>
        motionPhaseFromParts({
          needsYou: v.needsYou,
          offerOnly: v.offerOnly,
          endedDone: v.endedDone,
          workingNow: v.workingNow,
          finished: rootFinished,
        }),
      )
      if (kinds.includes('waiting')) phase = 'waiting'
      else if (kinds.includes('working')) phase = 'working'
      else if (kinds.length > 0 && kinds.every((k) => k === 'done')) phase = 'done'
      else phase = 'queued'
      if (phase === 'done' && !rootFinished) phase = 'queued'
    }
    const working = sessions.some((v) => v.workingNow)
    const waiting = sessions.filter(
      (v) =>
        motionPhaseFromParts({
          needsYou: v.needsYou,
          offerOnly: v.offerOnly,
          endedDone: v.endedDone,
          workingNow: v.workingNow,
          finished: rootFinished,
        }) === 'waiting',
    )
    const extra = waiting.filter((v) => !(v.offerOnly && deciding.has(v.sid)))
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
    const originId = this.originOf.get(issueId)
    if (originId === undefined) return null
    const origin = this.inputs.issues.get(originId)
    if (origin === undefined) return null
    const prefix = this.inputs.prefix.prefixForRepo(origin.repoId)
    return {
      id: origin.id,
      seq: origin.seq,
      title: origin.title,
      ref: displayRefOf(origin, prefix),
    }
  }

  // ---------------------------------------------------------- row write

  private assemble(id: string): { row: RollupRow; tick: OriginTick | null } | null {
    const issue = this.inputs.issues.get(id)
    if (issue === undefined) return null
    const aggregate = this.aggregates.get(id)
    const final = this.final.has(id)
    const tick = final && aggregate !== undefined ? this.tickOf(id) : null
    return {
      row: {
        id,
        marker: 1,
        final,
        phase: aggregate?.phase ?? 'queued',
        working: aggregate?.working ?? false,
        asking: aggregate?.asking ?? false,
        progressDone: aggregate?.progressDone ?? 0,
        progressTotal: aggregate?.progressTotal ?? 0,
        band: this.bandById.get(id) ?? bandOf(issue, 0),
        repoKey: this.repoKeyById.get(id) ?? groupKeyOf(issue),
        repoPath: issue.repoPath,
        sortKeyEnc: encodeSortKey(issue.sortKey),
        createdAt: issue.createdAt,
        seq: issue.seq,
        pinned: issue.pinned === true,
        parentId: issue.parentId,
        audience: issue.audience,
        stage: issue.stage,
        closedReason: issue.closedReason,
        needsHuman: issue.needsHuman,
        tuckedAt: issue.tuckedAt,
        closedAt: issue.closedAt,
        updatedAt: issue.updatedAt,
        finishedAt: issueFinishedAt(issue),
        tickId: tick?.id ?? null,
        tickSeq: tick?.seq ?? null,
        tickTitle: tick?.title ?? null,
        tickRef: tick?.ref ?? null,
      },
      tick,
    }
  }

  /** Rewrite one row when its value moved; returns true when written. */
  private rewrite(id: string): boolean {
    const next = this.assemble(id)
    if (next === null) {
      if (this.written.has(id)) {
        this.written.delete(id)
        this.aggregates.delete(id)
        this.ticks.delete(id)
        this.pendingWrites.push({ op: 'remove', key: id })
        return true
      }
      return false
    }
    const snap = JSON.stringify([next.row, next.tick])
    if (this.written.get(id) === snap) return false
    this.written.set(id, snap)
    this.ticks.set(id, next.tick)
    this.pendingWrites.push({ op: 'upsert', key: id, value: next.row })
    return true
  }

  private readonly pendingWrites: Array<
    { op: 'upsert'; key: string; value: RollupRow } | { op: 'remove'; key: string }
  > = []

  private refresh(id: string): void {
    const next = this.compute(id)
    const prev = this.aggregates.get(id)
    if (next === null) {
      if (prev !== undefined) {
        this.aggregates.delete(id)
        this.rewrite(id)
      }
      return
    }
    if (prev === undefined || JSON.stringify(prev) !== JSON.stringify(next)) {
      this.aggregates.set(id, next)
    }
    this.rewrite(id)
  }

  /** Ancestor chain recompute, stopping at the first unchanged value. */
  private refreshChain(seed: string): void {
    let current: string | undefined = seed
    const walked = new Set<string>()
    while (current !== undefined && !walked.has(current)) {
      walked.add(current)
      if (this.final.has(current)) {
        const before = this.written.get(current)
        this.refresh(current)
        const after = this.written.get(current)
        if (before !== undefined && before === after) return
        if (before === undefined && after === undefined) return
      }
      current = this.parentOf.get(current)
    }
  }

  // ---------------------------------------------------------- rescue/hosted

  private chainOf(issueId: string): string[] {
    const start = this.inputs.issues.get(issueId)
    if (start === undefined) return []
    const chain: string[] = []
    const walked = new Set<string>([issueId])
    let parentId = start.parentId ?? null
    while (parentId !== null && !walked.has(parentId)) {
      walked.add(parentId)
      const parent = this.inputs.issues.get(parentId)
      if (
        parent === undefined ||
        parent.archived === true ||
        parent.deletedAt != null ||
        parent.stage === 'proposed' ||
        parent.stage === 'shipping'
      ) {
        break
      }
      chain.push(parentId)
      parentId = parent.parentId ?? null
    }
    return chain
  }

  private takeKept(ancestor: string, descendant: string): void {
    let keepers = this.keptBy.get(ancestor)
    if (keepers === undefined) {
      keepers = new Set()
      this.keptBy.set(ancestor, keepers)
    }
    keepers.add(descendant)
  }

  private dropKept(ancestor: string, descendant: string): void {
    const keepers = this.keptBy.get(ancestor)
    if (keepers === undefined) return
    keepers.delete(descendant)
    if (keepers.size === 0) this.keptBy.delete(ancestor)
  }

  private reconcile(issueId: string): void {
    const want =
      (this.flat.has(issueId) && !this.dropped.has(issueId)) ||
      (this.keptBy.get(issueId)?.size ?? 0) > 0
    const has = this.final.has(issueId)
    if (want && !has) {
      this.final.add(issueId)
      if (!this.flat.has(issueId)) this.rescue.add(issueId)
      else this.rescue.delete(issueId)
      this.dirtyChains.add(issueId)
      this.chainRow(issueId)
    } else if (!want && has) {
      this.final.delete(issueId)
      this.rescue.delete(issueId)
      const chain = this.chains.get(issueId) ?? []
      this.chains.delete(issueId)
      this.aggregates.delete(issueId)
      this.rewrite(issueId)
      for (const ancestor of chain) {
        this.dropKept(ancestor, issueId)
        this.reconcile(ancestor)
      }
      this.dirtyChains.add(issueId)
    } else if (has && !this.flat.has(issueId)) {
      this.rescue.add(issueId)
    } else {
      this.rescue.delete(issueId)
    }
  }

  private chainRow(issueId: string): void {
    const chain = this.chainOf(issueId)
    const prev = this.chains.get(issueId)
    if (
      prev === undefined ||
      prev.length !== chain.length ||
      prev.some((ancestor, index) => ancestor !== chain[index])
    ) {
      const next = new Set(chain)
      for (const ancestor of prev ?? []) {
        if (!next.has(ancestor)) {
          this.dropKept(ancestor, issueId)
          this.reconcile(ancestor)
        }
      }
      this.chains.set(issueId, chain)
    }
    for (const ancestor of chain) {
      const candidate = this.inputs.issues.get(ancestor)
      if (candidate !== undefined && rescueEligible(candidate)) {
        if ((this.keptBy.get(ancestor)?.has(issueId) ?? false) !== true) {
          this.takeKept(ancestor, issueId)
          this.reconcile(ancestor)
        }
      } else if (this.keptBy.get(ancestor)?.has(issueId) === true) {
        this.dropKept(ancestor, issueId)
        this.reconcile(ancestor)
      }
    }
  }

  private purge(issueId: string): void {
    this.keptBy.delete(issueId)
    this.chains.delete(issueId)
    this.dropped.delete(issueId)
    for (const [ancestor, keepers] of [...this.keptBy]) {
      if (keepers.delete(issueId)) {
        if (keepers.size === 0) this.keptBy.delete(ancestor)
        this.reconcile(ancestor)
      }
    }
  }

  private hosted(issueId: string): boolean {
    const seen = new Set<string>([issueId])
    let parentId = this.inputs.issues.get(issueId)?.parentId ?? null
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId)
      if (this.final.has(parentId)) return true
      parentId = this.inputs.issues.get(parentId)?.parentId ?? null
    }
    return false
  }

  private recheckAgent(issueId: string): void {
    const issue = this.inputs.issues.get(issueId)
    if (issue === undefined || !this.flat.has(issueId) || issue.audience !== 'agent') {
      if (this.dropped.delete(issueId)) this.reconcile(issueId)
      return
    }
    if (this.hosted(issueId)) {
      if (this.dropped.delete(issueId)) this.reconcile(issueId)
      if (this.final.has(issueId)) this.chainRow(issueId)
    } else if (!this.dropped.has(issueId)) {
      this.dropped.add(issueId)
      this.reconcile(issueId)
    }
  }

  // ---------------------------------------------------------- ingest

  private ingestChild(changes: QueryChange[]): void {
    for (const c of changes) {
      const key = String(c.key)
      if (c.type === 'delete' || c.value === undefined) {
        const prev = this.parentOf.get(key)
        if (prev !== undefined) {
          this.parentOf.delete(key)
          this.dropSeat(this.childrenByParent, prev, key)
          this.fullChains.add(prev)
        }
        continue
      }
      const to = (c.value as ChildRow).parentId
      const from = this.parentOf.get(key) ?? null
      if (from === to) continue
      if (from !== null) {
        this.dropSeat(this.childrenByParent, from, key)
        this.fullChains.add(from)
      }
      this.parentOf.set(key, to)
      this.takeSeat(this.childrenByParent, to, key)
      this.fullChains.add(to)
    }
    this.flushBatch()
  }

  private ingestVerdict(changes: QueryChange[]): void {
    for (const c of changes) {
      const v = c.value as VerdictRow | undefined
      if (c.type === 'delete' || v === undefined) {
        // Deletes are silent upstream (verified) — this branch is
        // defensive; removals arrive via dropSession / ingestIssue.
        // Retraction halves of del+ins pairs land here: record now, count
        // at flush only if no re-add nets it to zero.
        const sid = v?.sid ?? String(c.key)
        const owners = this.sidOwner.get(sid)
        if (owners !== undefined) {
          this.sidOwner.delete(sid)
          for (const owner of owners) {
            const seats = this.memberSeats.get(owner)
            if (seats !== undefined) {
              seats.delete(sid)
              if (seats.size === 0) this.memberSeats.delete(owner)
              this.droppedSeats.add(`${owner}:${sid}`)
            }
            this.dirtyChains.add(owner)
          }
        }
        continue
      }
      const sid = v.sid
      let owners = this.sidOwner.get(sid)
      if (owners === undefined) {
        owners = new Set()
        this.sidOwner.set(sid, owners)
      }
      for (const owner of [...owners]) {
        if (owner !== v.owner) {
          const seats = this.memberSeats.get(owner)
          if (seats !== undefined) {
            seats.delete(sid)
            if (seats.size === 0) this.memberSeats.delete(owner)
            this.droppedSeats.add(`${owner}:${sid}`)
          }
          owners.delete(owner)
          this.dirtyChains.add(owner)
        }
      }
      let seats = this.memberSeats.get(v.owner)
      if (seats === undefined) {
        seats = new Map()
        this.memberSeats.set(v.owner, seats)
      }
      const had = seats.get(sid)
      const dropKey = `${v.owner}:${sid}`
      if (had === undefined) {
        // Fresh seat: nets zero against a same-flush retraction, else a
        // genuine membership move.
        seats.set(sid, v)
        if (this.droppedSeats.delete(dropKey)) {
          // Retraction + assertion: net membership unchanged.
        } else {
          this.countIndex()
        }
      } else if (JSON.stringify(had) !== JSON.stringify(v)) {
        seats.set(sid, v)
      }
      owners.add(v.owner)
      this.dirtyChains.add(v.owner)
    }
    this.flushBatch()
  }

  private ingestSummary(changes: QueryChange[]): void {
    // Flat membership lives here, NOT on visibleQ events: every flat flip
    // changes the SummaryRow value, and summaryQ's fn re-runs and notifies
    // on each one — while visibleQ's pure-DSL where retractions are silent
    // (M2 archive finding: the archived row left visibleQ state with no
    // event, and final stayed true). Aggregates never read summary values —
    // only the denormalized band/repoKey ride the row, rewritten below
    // without chains.
    for (const c of changes) {
      const id = String(c.key)
      const srow = c.value as SummaryRow | undefined
      if (c.type === 'delete' || srow === undefined) {
        this.bandById.delete(id)
        this.repoKeyById.delete(id)
        // A summary retraction is a membership loss (issue deletes are
        // also driven explicitly, idempotently, via ingestIssue).
        if (this.flat.delete(id)) {
          this.purge(id)
          this.reconcile(id)
          this.recheckAgent(id)
        }
      } else {
        const flat = !srow.excluded && srow.flat
        const had = this.flat.has(id)
        if (flat && !had) {
          this.flat.add(id)
          this.reconcile(id)
          this.recheckAgent(id)
        } else if (!flat && had) {
          this.flat.delete(id)
          this.purge(id)
          this.reconcile(id)
          this.recheckAgent(id)
        }
        const prevBand = this.bandById.get(id)
        const prevKey = this.repoKeyById.get(id)
        if (prevBand !== srow.band || prevKey !== srow.repoKey) {
          this.bandById.set(id, srow.band)
          this.repoKeyById.set(id, srow.repoKey)
          this.rewrite(id)
        }
      }
    }
    this.flushBatch()
  }

  /** Issue rows drive origin/dependent seats, tick inputs and rank denorm. */
  ingestIssue(id: string, issue: SliceIssue | undefined): void {
    const prevOrigin = this.originOf.get(id) ?? null
    const nextOrigin = issue === undefined ? null : spinOffOriginId(issue)
    const liveSeat =
      issue !== undefined && issue.archived !== true && issue.deletedAt == null ? nextOrigin : null
    const prevSeat =
      prevOrigin !== null && this.spinOffChildren.get(prevOrigin)?.has(id) === true
        ? prevOrigin
        : null
    if (prevSeat !== liveSeat) {
      if (prevSeat !== null) this.dropSeat(this.spinOffChildren, prevSeat, id)
      if (liveSeat !== null) this.takeSeat(this.spinOffChildren, liveSeat, id)
    }
    if (prevOrigin !== nextOrigin) {
      if (nextOrigin === null) this.originOf.delete(id)
      else {
        this.originOf.set(id, nextOrigin)
        this.countIndex()
      }
    }
    const outgoing = issue === undefined ? [] : plainDeps(issue).map((dep) => ({ to: dep.id, type: dep.type }))
    const prevOutgoing = this.outgoingDeps.get(id) ?? []
    const same =
      prevOutgoing.length === outgoing.length &&
      prevOutgoing.every((edge, i) => edge.to === outgoing[i]?.to && edge.type === outgoing[i]?.type)
    if (!same) {
      for (const edge of prevOutgoing) {
        const edges = this.dependentsOf.get(edge.to)
        if (edges !== undefined) {
          const kept = edges.filter((entry) => entry.id !== id)
          if (kept.length === 0) this.dependentsOf.delete(edge.to)
          else this.dependentsOf.set(edge.to, kept)
          this.countIndex()
        }
      }
      if (issue === undefined) {
        this.outgoingDeps.delete(id)
      } else {
        this.outgoingDeps.set(id, outgoing)
        for (const edge of outgoing) {
          const edges = this.dependentsOf.get(edge.to) ?? []
          edges.push({ id, type: edge.type })
          this.dependentsOf.set(edge.to, edges)
          this.countIndex()
        }
      }
    } else if (issue === undefined) {
      this.outgoingDeps.delete(id)
    }
    if (issue === undefined) {
      this.dropOwnerSeats(id)
      this.dropChildEdge(id)
      this.originOf.delete(id)
      this.outgoingDeps.delete(id)
      this.countScan?.('dependents-scan', this.dependentsOf.size)
      for (const [to, edges] of [...this.dependentsOf]) {
        const kept = edges.filter((entry) => entry.id !== id)
        if (kept.length === 0) this.dependentsOf.delete(to)
        else this.dependentsOf.set(to, kept)
      }
      this.final.delete(id)
      this.flat.delete(id)
      this.purge(id)
      this.aggregates.delete(id)
      this.bandById.delete(id)
      this.repoKeyById.delete(id)
      this.rewrite(id)
      this.flushBatch()
      return
    }
    // R1 edge from the issue row itself: childQ drops archived rows
    // silently, so the edge is reconciled here (childQ events dedup
    // against this — a live move arrives twice and the second is a no-op).
    const liveEdge =
      issue.archived !== true && issue.deletedAt == null && issue.parentId != null
        ? issue.parentId
        : null
    const prevEdge = this.parentOf.get(id) ?? null
    if (prevEdge !== liveEdge) {
      if (prevEdge !== null) {
        this.dropSeat(this.childrenByParent, prevEdge, id)
        this.fullChains.add(prevEdge)
      }
      if (liveEdge !== null) {
        this.takeSeat(this.childrenByParent, liveEdge, id)
        this.parentOf.set(id, liveEdge)
        this.fullChains.add(liveEdge)
      } else {
        this.parentOf.delete(id)
      }
    }
    // Stage/blocked/needsHuman/closedReason/tick/rank inputs may move the
    // aggregate, the tick and the denormalized row: seed the own chain.
    this.dirtyChains.add(id)
    this.rewrite(id)
    this.flushBatch()
  }

  /** Drop one session's seats under every owner (explicit removal
   *  driving — verdict deletes are silent). No-ops without seats. The
   *  resolveKey stays: it tracks the last-seen join key, not seat presence
   *  (clearing it would make the next resolveQ update look like a move). */
  dropSession(sid: string): void {
    const owners = this.sidOwner.get(sid)
    if (owners === undefined) return
    this.sidOwner.delete(sid)
    for (const owner of owners) {
      const seats = this.memberSeats.get(owner)
      if (seats !== undefined) {
        seats.delete(sid)
        if (seats.size === 0) this.memberSeats.delete(owner)
        this.countIndex()
      }
      this.dirtyChains.add(owner)
    }
    this.flushBatch()
  }

  /** Drop every member seat of a removed owner. */
  private dropOwnerSeats(owner: string): void {
    const seats = this.memberSeats.get(owner)
    if (seats === undefined) return
    for (const sid of seats.keys()) {
      const owners = this.sidOwner.get(sid)
      if (owners !== undefined) {
        owners.delete(owner)
        if (owners.size === 0) {
          this.sidOwner.delete(sid)
          this.resolveKey.delete(sid)
        }
      }
    }
    this.memberSeats.delete(owner)
    this.countIndex()
    this.dirtyChains.add(owner)
  }

  /** Drop one node's R1 edge; orphaned children surface as roots. */
  private dropChildEdge(id: string): void {
    const prev = this.parentOf.get(id)
    if (prev !== undefined) {
      this.parentOf.delete(id)
      this.dropSeat(this.childrenByParent, prev, id)
      this.fullChains.add(prev)
    }
    const orphans = this.childrenByParent.get(id)
    if (orphans !== undefined) {
      this.childrenByParent.delete(id)
      this.countIndex()
      for (const child of orphans) {
        this.parentOf.delete(child)
        this.dirtyChains.add(child)
      }
    }
  }

  /** Prefix bumps re-tick named rows (displayRef join moved). */
  notePrefixChanged(): void {
    for (const id of this.originOf.keys()) {
      if (this.final.has(id)) this.rewrite(id)
    }
    this.flushBatch()
  }

  // ---------------------------------------------------------- flush

  private flushBatch(): void {
    if (this.batching) return
    try {
      for (const id of this.dirtyChains) this.refreshChain(id)
      this.dirtyChains.clear()
      for (const id of this.fullChains) {
        let current: string | undefined = id
        const walked = new Set<string>()
        while (current !== undefined && !walked.has(current)) {
          walked.add(current)
          if (this.final.has(current)) this.refresh(current)
          else break
          current = this.parentOf.get(current)
        }
      }
      this.fullChains.clear()
      // True seat removals (no same-flush re-add) count here.
      if (this.droppedSeats.size > 0) {
        for (let i = 0; i < this.droppedSeats.size; i += 1) this.countIndex()
        this.droppedSeats.clear()
      }
      if (this.pendingWrites.length > 0) {
        this.sync.write(this.pendingWrites.splice(0))
      }
    } finally {
      this.batch = null
    }
  }

  batchDuring(fn: () => void): void {
    this.batching = true
    try {
      fn()
    } finally {
      this.batching = false
      this.flushBatch()
    }
  }

  /** Full build for bootstrap/replace: seats from current collections. */
  rebuildAll(inputs: {
    children: ChildRow[]
    verdicts: VerdictRow[]
    flatIds: string[]
    issues: Iterable<string>
  }): void {
    this.childrenByParent.clear()
    this.parentOf.clear()
    this.memberSeats.clear()
    this.sidOwner.clear()
    this.resolveKey.clear()
    this.originOf.clear()
    this.spinOffChildren.clear()
    this.dependentsOf.clear()
    this.outgoingDeps.clear()
    this.flat.clear()
    this.keptBy.clear()
    this.chains.clear()
    this.rescue.clear()
    this.dropped.clear()
    this.final.clear()
    this.aggregates.clear()
    this.ticks.clear()
    this.written.clear()
    this.bandById.clear()
    this.repoKeyById.clear()
    this.dirtyChains.clear()
    this.fullChains.clear()
    this.droppedSeats.clear()
    this.pendingWrites.splice(0)
    this.batching = true
    try {
      for (const edge of inputs.children) {
        this.parentOf.set(edge.id, edge.parentId)
        this.takeSeat(this.childrenByParent, edge.parentId, edge.id)
      }
      for (const v of inputs.verdicts) {
        let seats = this.memberSeats.get(v.owner)
        if (seats === undefined) {
          seats = new Map()
          this.memberSeats.set(v.owner, seats)
        }
        seats.set(v.sid, v)
        let owners = this.sidOwner.get(v.sid)
        if (owners === undefined) {
          owners = new Set()
          this.sidOwner.set(v.sid, owners)
        }
        owners.add(v.owner)
      }
      for (const r of this.inputs.resolveQ.toArray as Array<{ sid: string; joinKey: string | null }>) {
        this.resolveKey.set(r.sid, r.joinKey ?? null)
      }
      for (const id of inputs.flatIds) this.flat.add(id)
      // Humans first; agents host monotonically; rescue in two rounds.
      for (const id of this.flat) {
        if (this.inputs.issues.get(id)?.audience !== 'agent') this.final.add(id)
      }
      for (let round = 0; round < 2; round += 1) {
        let grown = true
        while (grown) {
          grown = false
          for (const id of this.flat) {
            if (this.final.has(id)) continue
            if (this.inputs.issues.get(id)?.audience !== 'agent') continue
            if (this.hosted(id)) {
              this.final.add(id)
              this.dropped.delete(id)
              grown = true
            } else {
              this.dropped.add(id)
            }
          }
        }
        this.keptBy.clear()
        this.chains.clear()
        this.rescue.clear()
        for (const id of this.final) {
          const chain = this.chainOf(id)
          this.chains.set(id, chain)
          for (const ancestor of chain) {
            const candidate = this.inputs.issues.get(ancestor)
            if (candidate !== undefined && rescueEligible(candidate)) this.takeKept(ancestor, id)
          }
        }
        for (const keepers of this.keptBy.keys()) this.final.add(keepers)
      }
      for (const id of this.final) {
        if (!this.flat.has(id)) this.rescue.add(id)
      }
      for (const id of inputs.issues) {
        this.ingestIssueStatic(id)
        const summary = this.inputs.summaryQ.get(id) as SummaryRow | undefined
        if (summary !== undefined && !summary.excluded) {
          this.bandById.set(id, summary.band)
          this.repoKeyById.set(id, summary.repoKey)
        }
        const next = this.compute(id)
        if (next !== null) this.aggregates.set(id, next)
        const assembled = this.assemble(id)
        if (assembled !== null) {
          this.written.set(id, JSON.stringify([assembled.row, assembled.tick]))
          this.ticks.set(id, assembled.tick)
          this.pendingWrites.push({ op: 'upsert', key: id, value: assembled.row })
        }
      }
    } finally {
      this.batching = false
      this.batch = null
    }
    if (this.pendingWrites.length > 0) {
      this.sync.write(this.pendingWrites.splice(0))
    }
  }

  /** Seat-only ingest used by rebuildAll (no chain seeding mid-build). */
  private ingestIssueStatic(id: string): void {
    const issue = this.inputs.issues.get(id)
    const nextOrigin = issue === undefined ? null : spinOffOriginId(issue)
    if (nextOrigin !== null) this.originOf.set(id, nextOrigin)
    if (nextOrigin !== null && issue !== undefined && issue.archived !== true && issue.deletedAt == null) {
      this.takeSeat(this.spinOffChildren, nextOrigin, id)
    }
    const outgoing = issue === undefined ? [] : plainDeps(issue).map((dep) => ({ to: dep.id, type: dep.type }))
    if (outgoing.length > 0) {
      this.outgoingDeps.set(id, outgoing)
      for (const edge of outgoing) {
        const edges = this.dependentsOf.get(edge.to) ?? []
        edges.push({ id, type: edge.type })
        this.dependentsOf.set(edge.to, edges)
      }
    }
  }
}
