/**
 * POD-4446 — visible set with rescue rows (spec R-VIS).
 *
 * Flat pass per issue (rows.ts:51-118): structurally excluded rows never
 * show; rows with ≥1 retained session show; sessionless rows show only as
 * active human issues or decay-gated finished rows (awaiting-merge and
 * closed top-level exempt from decay). Rescue (rows.ts:121-158): every
 * missing live human-audience unfinished ancestor of a visible row
 * materializes as a sessionless row, cycle-guarded, finished ancestors never
 * resurrected.
 *
 * Incremental form: flat visibility per issue plus refcounted ancestor
 * chains (`keptBy`). A row is visible iff flat-visible or kept by a visible
 * descendant; rescue rows flip to flat-visible without a delta when they
 * gain sessions. Coarse-tick re-evaluation is scoped to decay-sensitive
 * rows, never the table.
 */

import type { SliceIssue } from '../../shared/src/slice-types'
import { assertNever, nullStats, type Delta, type DerivationStats } from './deltas'
import type { IndexSet } from './indexes'
import { rescueEligible, sessionlessKept, structurallyExcluded } from './rules'
import { splitMembers, type SummaryModule } from './summary'
import type { IssueTable } from './tables'
export class VisibleModule {
  /** All visible rows (flat + rescue). The comparison surface for rollup. */
  readonly visible = new Set<string>()
  /** Flat-pass visibility (own sessions / sessionless keep). */
  readonly flat = new Set<string>()
  /** Sessionless rescue rows (visible without flat visibility). */
  readonly rescue = new Set<string>()
  /** Rescue refcounts: ancestor id -> visible descendants keeping it. */
  readonly keptBy = new Map<string, Set<string>>()
  /** Stored ancestor chain per visible row (for unchaining on moves). */
  private readonly chains = new Map<string, string[]>()
  /** Rows whose flat visibility can move with the coarse clock. */
  readonly decaySensitive = new Set<string>()

  constructor(
    private readonly tables: { issues: IssueTable },
    private readonly indexes: IndexSet,
    private readonly summary: SummaryModule,
    private readonly getNow: () => number,
    private readonly stats: DerivationStats = nullStats,
  ) {}

  isVisible(id: string): boolean {
    return this.visible.has(id)
  }

  orderedIds(): string[] {
    return [...this.visible]
  }

  /** Flat-pass predicate (rows.ts:62-118). */
  evaluateFlat(issueId: string): boolean {
    const issue = this.tables.issues.rows.get(issueId)
    if (issue === undefined) return false
    this.stats.visibility()
    if (structurallyExcluded(issue)) return false
    const now = this.getNow()
    const { retained } = splitMembers(this.summary.membersOf(issueId), now, issue)
    if (retained.length > 0) return true
    return sessionlessKept(issue, now)
  }

  /** Ancestor chain for rescue (rows.ts:131-158 walk). */
  private chainOf(issueId: string): string[] {
    const issues = this.tables.issues.rows
    const start = issues.get(issueId)
    if (start === undefined) return []
    const chain: string[] = []
    const walked = new Set<string>([issueId])
    let parentId = start.parentId ?? null
    while (parentId !== null && !walked.has(parentId)) {
      walked.add(parentId)
      const parent = issues.get(parentId)
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

  /** Reconcile one row's membership; emit on flip. Cascades: a row that
   *  leaves visibility releases its own chain contributions, so multi-level
   *  rescue stacks collapse level by level. */
  private reconcile(issueId: string, out: Delta[]): void {
    const want = this.flat.has(issueId) || (this.keptBy.get(issueId)?.size ?? 0) > 0
    const has = this.visible.has(issueId)
    if (want && !has) {
      this.visible.add(issueId)
      if (!this.flat.has(issueId)) this.rescue.add(issueId)
      else this.rescue.delete(issueId)
      out.push({ kind: 'VisibilityChanged', id: issueId, visible: true })
      // Newly visible rows hold up their own ancestors in turn.
      this.chainRow(issueId, out)
    } else if (!want && has) {
      this.visible.delete(issueId)
      this.rescue.delete(issueId)
      const chain = this.chains.get(issueId) ?? []
      this.chains.delete(issueId)
      out.push({ kind: 'VisibilityChanged', id: issueId, visible: false })
      for (const ancestor of chain) {
        this.dropKept(ancestor, issueId)
        this.reconcile(ancestor, out)
      }
    } else if (has && !this.flat.has(issueId)) {
      this.rescue.add(issueId)
    } else {
      this.rescue.delete(issueId)
    }
  }

  /**
   * Sync one row's chain contributions: drop stale ancestors, take eligible
   * current ones. Flip-free — reconcile emits only on membership change, so
   * re-syncing an unchanged chain is a silent no-op.
   */
  private chainRow(issueId: string, out: Delta[]): void {
    const chain = this.chainOf(issueId)
    const prev = this.chains.get(issueId)
    if (
      prev !== undefined &&
      prev.length === chain.length &&
      prev.every((ancestor, index) => ancestor === chain[index])
    ) {
      // Same structure — still re-sync eligibility (a stage flip can move an
      // ancestor in or out of rescue eligibility with no structural change).
    } else {
      const next = new Set(chain)
      for (const ancestor of prev ?? []) {
        if (!next.has(ancestor)) {
          this.dropKept(ancestor, issueId)
          this.reconcile(ancestor, out)
        }
      }
      this.chains.set(issueId, chain)
    }
    for (const ancestor of chain) {
      const candidate = this.tables.issues.rows.get(ancestor)
      if (candidate !== undefined && rescueEligible(candidate)) {
        if ((this.keptBy.get(ancestor)?.has(issueId) ?? false) !== true) {
          this.takeKept(ancestor, issueId)
          this.reconcile(ancestor, out)
        }
      } else if (this.keptBy.get(ancestor)?.has(issueId) === true) {
        this.dropKept(ancestor, issueId)
        this.reconcile(ancestor, out)
      }
    }
  }

  /** Purge a removed row's rescue bookkeeping (keeper seats + chains),
   *  reconciling ancestors that may have lost their last keeper. */
  private purge(issueId: string, out: Delta[]): void {
    this.keptBy.delete(issueId)
    this.chains.delete(issueId)
    for (const [ancestor, keepers] of [...this.keptBy]) {
      if (keepers.delete(issueId)) {
        if (keepers.size === 0) this.keptBy.delete(ancestor)
        this.reconcile(ancestor, out)
      }
    }
  }

  /** Visible rows in a moved subtree (rescue chains follow the move). */
  private visibleSubtree(childId: string): string[] {
    const out: string[] = []
    const stack = [childId]
    const seen = new Set<string>([childId])
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (this.visible.has(id)) out.push(id)
      for (const child of this.indexes.childrenByParent.get(id) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        stack.push(child)
      }
    }
    return out
  }

  private trackDecay(issueId: string, flatVisible: boolean): void {
    if (!flatVisible) {
      this.decaySensitive.delete(issueId)
      return
    }
    const issue = this.tables.issues.rows.get(issueId)
    if (issue === undefined) {
      this.decaySensitive.delete(issueId)
      return
    }
    const members = this.summary.membersOf(issueId)
    const sensitive =
      (members.length === 0 && (issue.stage === 'done' || issue.closedReason != null)) ||
      members.some((s) => s.stoppedAt != null)
    if (sensitive) this.decaySensitive.add(issueId)
    else this.decaySensitive.delete(issueId)
  }

  private refreshFlat(issueId: string, out: Delta[]): void {
    const issue = this.tables.issues.rows.get(issueId)
    // Missing or structurally excluded rows can never be flat-visible: drop
    // without evaluating the predicate (an unrelated heartbeat on an
    // archived issue's session evaluates nothing downstream).
    if (issue === undefined || structurallyExcluded(issue)) {
      this.purge(issueId, out)
      this.flat.delete(issueId)
      this.reconcile(issueId, out)
      this.decaySensitive.delete(issueId)
      return
    }
    // A rescue row that lost eligibility drops even while kept: finished
    // ancestors are never resurrected (rows.ts:128).
    if (this.rescue.has(issueId) && !rescueEligible(issue)) {
      this.keptBy.delete(issueId)
      this.flat.delete(issueId)
      this.reconcile(issueId, out)
      this.decaySensitive.delete(issueId)
      return
    }
    const next = this.evaluateFlat(issueId)
    const prev = this.flat.has(issueId)
    if (next && !prev) {
      this.flat.add(issueId)
      this.rescue.delete(issueId)
    } else if (!next && prev) {
      this.flat.delete(issueId)
    }
    this.trackDecay(issueId, next)
    this.reconcile(issueId, out)
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
    const flats = new Set<string>()
    const subtreeRoots: string[] = []
    for (const delta of batch) {
      switch (delta.kind) {
        case 'IssueChanged':
        case 'IssueRemoved':
        case 'MembershipChanged':
          flats.add(delta.kind === 'MembershipChanged' ? delta.issueId : delta.id)
          if (delta.kind === 'IssueChanged') subtreeRoots.push(delta.id)
          break
        case 'SessionChanged':
        case 'SessionRemoved':
          for (const issueId of this.memberIssuesOfSession(delta.id)) flats.add(issueId)
          break
        case 'ChildrenChanged':
          subtreeRoots.push(delta.childId)
          break
        case 'ClockChanged':
          for (const issueId of this.decaySensitive) flats.add(issueId)
          break
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
          break
        default:
          assertNever(delta)
      }
    }
    for (const issueId of flats) this.refreshFlat(issueId, out)
    // Re-sync chains whose ancestry or ancestor eligibility may have moved:
    // moved subtrees plus subtrees under changed issues. Sync is flip-free.
    const synced = new Set<string>()
    for (const rootId of subtreeRoots) {
      for (const id of this.visibleSubtree(rootId)) {
        if (synced.has(id)) continue
        synced.add(id)
        if (this.visible.has(id)) this.chainRow(id, out)
      }
    }
    for (const issueId of flats) {
      if (synced.has(issueId) || !this.visible.has(issueId)) continue
      this.chainRow(issueId, out)
    }
    return out
  }

  /** Full derive for replace/bootstrap (no deltas; store derives after). */
  rebuildAll(): void {
    this.visible.clear()
    this.flat.clear()
    this.rescue.clear()
    this.keptBy.clear()
    this.chains.clear()
    this.decaySensitive.clear()
    for (const issueId of this.tables.issues.rows.keys()) {
      if (this.evaluateFlat(issueId)) this.flat.add(issueId)
      this.trackDecay(issueId, this.flat.has(issueId))
    }
    for (const issueId of this.flat) {
      const chain = this.chainOf(issueId)
      this.chains.set(issueId, chain)
      for (const ancestor of chain) {
        const candidate = this.tables.issues.rows.get(ancestor)
        if (candidate !== undefined && rescueEligible(candidate)) this.takeKept(ancestor, issueId)
      }
    }
    for (const issueId of this.flat) this.visible.add(issueId)
    for (const keepers of this.keptBy.keys()) this.visible.add(keepers)
    for (const id of this.visible) {
      if (!this.flat.has(id)) this.rescue.add(id)
    }
  }
}
