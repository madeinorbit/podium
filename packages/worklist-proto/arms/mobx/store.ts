/**
 * POD-4447 — one MobX store per principal: normalized tables, relation
 * buckets, locals, and the single write path.
 *
 * Tables hold models (`IssueModel` / `SessionModel` / `WorktreeModel`) keyed
 * by id in shallow observable maps; values are borrowed immutable stream
 * objects behind `observable.ref`, never spread on the hot path. Relation
 * buckets are observable maps of readonly id arrays; the array is replaced on
 * change, so a content-only change moves no bucket and invalidates nothing.
 *
 * Writes: one `runInAction` per `RowSourceEvent` (update applies per row,
 * replace clears and reseeds atomically); `setSelection` / `setCoarseNow`
 * drive locals. Selection and the coarse clock are locals, never row fields
 * (spec §5). Every bucket write counts `indexUpdates`; every dispatch counts
 * one notification, including no-op passes.
 */

import { action, makeObservable, observable } from 'mobx'
import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ArmHandle, RowSource } from '../../shared/src/arm'
import { CommitLogContext, currentCommitLog } from '../../shared/src/row-shell'
import type {
  SliceIssue,
  SliceLocals,
  SliceSession,
  SliceSnapshot,
  SliceWorktree,
} from '../../shared/src/slice-types'
import type { ArmStats, RowRecord, RowSourceEvent } from '../../shared/src/stats'
import {
  hasLeftMission,
  issueAbandoned,
  issueFinished,
  openSession,
  preferredTip,
  spinOffOriginId,
} from './rules'
import { IssueModel } from './models/issue'
import { SessionModel } from './models/session'
import { WorktreeModel } from './models/worktree'
import { MobxList } from './react/list'
import { WorklistModel } from './worklist'

interface SessionHome {
  explicit: string | null
  resolved: string | null
}

function isLiveIssue(issue: SliceIssue): boolean {
  return !issue.archived && (issue.deletedAt === null || issue.deletedAt === undefined)
}

/** Live issues contribute a formal parent edge; orphans surface as roots (spec §2 R1). */
function parentEdgeOf(issue: SliceIssue): string | null {
  return isLiveIssue(issue) ? (issue.parentId ?? null) : null
}

function normalizeRoot(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

export class MobXStore {
  readonly issues = observable.map<string, IssueModel>({}, { deep: false })
  readonly sessions = observable.map<string, SessionModel>({}, { deep: false })
  readonly worktrees = observable.map<string, WorktreeModel>({}, { deep: false })

  // R1 formal edges (live-child edges only).
  readonly childrenByParent = observable.map<string, readonly string[]>({}, { deep: false })
  readonly parentOf = observable.map<string, string>({}, { deep: false })
  // R2 explicit seats (archived included, filtered at read) + R3 resolved seats.
  readonly explicitByIssue = observable.map<string, readonly string[]>({}, { deep: false })
  readonly resolvedByIssue = observable.map<string, readonly string[]>({}, { deep: false })
  readonly sessionHome = observable.map<string, SessionHome>({}, { deep: false })
  // R3 containment targets: live issues with a worktreePath, plus lane paths.
  readonly issuesByWorktree = observable.map<string, readonly string[]>({}, { deep: false })
  readonly lanePaths = observable.map<string, true>({}, { deep: false })
  // R4 origin edges (kept at any liveness) + live-only adjacency + incoming deps.
  readonly originOf = observable.map<string, string>({}, { deep: false })
  readonly spinOffChildren = observable.map<string, readonly string[]>({}, { deep: false })
  readonly dependentsOf = observable.map<string, ReadonlyArray<{ id: string; type: string }>>(
    {},
    { deep: false },
  )
  readonly outgoingDeps = observable.map<string, ReadonlyArray<{ to: string; type: string }>>(
    {},
    { deep: false },
  )
  // Prefix join + repo fan-out.
  readonly prefixByRepoId = observable.map<string, string | null>({}, { deep: false })
  readonly issuesByRepo = observable.map<string, readonly string[]>({}, { deep: false })

  readonly locals: { selectedIssueId: string | null; selectedIssueWasFolded: boolean; coarseNow: number }
  readonly stats: ArmStats
  readonly worklist: WorklistModel
  /** Least-fixpoint guard: in-progress `visible` reads as invisible, never re-entered. */
  readonly visibleGuard = new Set<string>()

  private off: (() => void) | null = null
  private webRoot: { unmount(): void } | null = null

  constructor(
    private readonly source: RowSource,
    locals: SliceLocals,
  ) {
    const stats: ArmStats = {
      rowsDerived: 0,
      rollupsDerived: 0,
      indexUpdates: 0,
      notifications: 0,
      reset: () => {
        stats.rowsDerived = 0
        stats.rollupsDerived = 0
        stats.indexUpdates = 0
        stats.notifications = 0
      },
    }
    this.stats = stats
    this.locals = observable({
      selectedIssueId: locals.selectedIssueId,
      selectedIssueWasFolded: locals.selectedIssueWasFolded ?? false,
      coarseNow: locals.coarseNow,
    })
    this.worklist = new WorklistModel(this)
    makeObservable(this, {
      source: false,
      locals: false,
      stats: false,
      worklist: false,
      visibleGuard: false,
      aggregateGuard: false,
      off: false,
      webRoot: false,
      issues: false,
      sessions: false,
      worktrees: false,
      childrenByParent: false,
      parentOf: false,
      explicitByIssue: false,
      resolvedByIssue: false,
      sessionHome: false,
      issuesByWorktree: false,
      lanePaths: false,
      originOf: false,
      spinOffChildren: false,
      dependentsOf: false,
      outgoingDeps: false,
      prefixByRepoId: false,
      issuesByRepo: false,
      apply: action,
      bootstrap: action,
      tableApply: action,
      ingestRecord: action,
      ingestIssue: action,
      ingestSession: action,
      ingestWorktree: action,
      takeSeat: action,
      dropSeat: action,
      moveSeat: action,
      resolveAllUnbound: action,
      setSelection: action,
      setCoarseNow: action,
      dispose: action,
      mountWeb: false,
      snapshot: false,
      handle: false,
      membersOf: false,
      unreadMembersOf: false,
      prefixForRepo: false,
      visibleSubtree: false,
      hasOpenExplicit: false,
      lastActiveOwn: false,
      lastActiveOf: false,
      liveDescendants: false,
      spinOffTip: false,
      continuationOf: false,
      vacatedOrigin: false,
      formalMembers: false,
      progressOf: false,
      memberIssuesOfSession: false,
      resolveCwd: false,
      roots: false,
    })
    this.off = source.subscribe((event) => this.apply(event))
    // Bootstrap from the source snapshot (the cold path is silent — arms
    // snapshot, per the G3 finding — so construction itself emits nothing).
    this.bootstrap()
    stats.reset()
  }

  // ------------------------------------------------------------ write path

  /** One publication, one action, one notification pass. */
  apply(event: RowSourceEvent): void {
    if (event.type === 'replace') {
      this.issues.clear()
      this.sessions.clear()
      this.worktrees.clear()
      this.childrenByParent.clear()
      this.parentOf.clear()
      this.explicitByIssue.clear()
      this.resolvedByIssue.clear()
      this.sessionHome.clear()
      this.issuesByWorktree.clear()
      this.lanePaths.clear()
      this.originOf.clear()
      this.spinOffChildren.clear()
      this.dependentsOf.clear()
      this.outgoingDeps.clear()
      this.prefixByRepoId.clear()
      this.issuesByRepo.clear()
      for (const record of event.rows) this.tableApply(record)
      for (const id of this.issues.keys()) this.ingestIssue(id)
      for (const id of this.sessions.keys()) this.ingestSession(id)
      for (const id of this.worktrees.keys()) this.ingestWorktree(id)
      this.resolveAllUnbound()
      this.stats.notifications += 1
      return
    }
    let touched = false
    for (const record of event.rows) {
      if (this.tableApply(record)) touched = true
    }
    if (touched) {
      for (const record of event.rows) this.ingestRecord(record)
      this.resolveAllUnbound()
    }
    this.stats.notifications += 1
  }

  /** Table ingest: same reference is a no-op; `undefined` evicts. */
  private tableApply(record: RowRecord): boolean {
    switch (record.kind) {
      case 'issue': {
        const prev = this.issues.get(record.id)
        if (record.value === undefined) {
          if (prev === undefined) return false
          this.issues.delete(record.id)
          return true
        }
        if (prev !== undefined && prev.value === record.value) return false
        if (prev !== undefined) prev.value = record.value as SliceIssue
        else this.issues.set(record.id, new IssueModel(this, record.value as SliceIssue))
        return true
      }
      case 'session': {
        const prev = this.sessions.get(record.id)
        if (record.value === undefined) {
          if (prev === undefined) return false
          this.sessions.delete(record.id)
          return true
        }
        if (prev !== undefined && prev.value === record.value) return false
        if (prev !== undefined) prev.value = record.value as SliceSession
        else this.sessions.set(record.id, new SessionModel(record.value as SliceSession))
        return true
      }
      case 'worktree': {
        const prev = this.worktrees.get(record.id)
        if (record.value === undefined) {
          if (prev === undefined) return false
          this.worktrees.delete(record.id)
          return true
        }
        if (prev !== undefined && prev.value === record.value) return false
        if (prev !== undefined) prev.value = record.value as SliceWorktree
        else this.worktrees.set(record.id, new WorktreeModel(record.value as SliceWorktree))
        return true
      }
    }
  }

  private ingestRecord(record: RowRecord): void {
    if (record.kind === 'issue') this.ingestIssue(record.id)
    else if (record.kind === 'session') this.ingestSession(record.id)
    else this.ingestWorktree(record.id)
  }

  private bootstrap(): void {
    for (const record of this.source.snapshot('issue')) this.tableApply(record)
    for (const record of this.source.snapshot('session')) this.tableApply(record)
    for (const record of this.source.snapshot('worktree')) this.tableApply(record)
    for (const id of this.issues.keys()) this.ingestIssue(id)
    for (const id of this.sessions.keys()) this.ingestSession(id)
    for (const id of this.worktrees.keys()) this.ingestWorktree(id)
    this.resolveAllUnbound()
  }

  // --------------------------------------------------------------- indexes

  /** Bucket add; counts only mutating writes. */
  private takeSeat(map: Map<string, readonly string[]>, bucket: string, id: string): boolean {
    const prev = map.get(bucket)
    if (prev !== undefined && prev.includes(id)) return false
    map.set(bucket, [...(prev ?? []), id])
    this.stats.indexUpdates += 1
    return true
  }

  /** Bucket remove; counts only mutating writes. */
  private dropSeat(map: Map<string, readonly string[]>, bucket: string, id: string): boolean {
    const prev = map.get(bucket)
    if (prev === undefined || !prev.includes(id)) return false
    const next = prev.filter((entry) => entry !== id)
    if (next.length === 0) map.delete(bucket)
    else map.set(bucket, next)
    this.stats.indexUpdates += 1
    return true
  }

  private ingestIssue(id: string): void {
    const issue = this.issues.get(id)?.value
    // R1 formal edge (live children only); evict orphans to roots.
    const nextEdge = issue === undefined ? null : parentEdgeOf(issue)
    const prevEdge = this.parentOf.get(id) ?? null
    if (prevEdge !== nextEdge) {
      if (prevEdge !== null) this.dropSeat(this.childrenByParent, prevEdge, id)
      if (nextEdge !== null) this.takeSeat(this.childrenByParent, nextEdge, id)
      if (nextEdge !== null) this.parentOf.set(id, nextEdge)
      else this.parentOf.delete(id)
      this.stats.indexUpdates += 1
    }
    if (issue === undefined) {
      const orphans = this.childrenByParent.get(id)
      if (orphans !== undefined) {
        this.childrenByParent.delete(id)
        this.stats.indexUpdates += 1
        for (const child of orphans) this.parentOf.delete(child)
      }
    }
    // R3 target seat + repo seat.
    this.moveSeat(
      this.issuesByWorktree,
      id,
      issue !== undefined && isLiveIssue(issue) && issue.worktreePath ? issue.worktreePath : null,
    )
    this.moveSeat(this.issuesByRepo, id, issue?.repoId ?? null)
    // R4 origin edge (kept at any liveness) + live-only adjacency.
    const nextOrigin = issue === undefined ? null : (spinOffOriginId(issue) ?? null)
    const prevOrigin = this.originOf.get(id) ?? null
    const liveSeat = issue !== undefined && isLiveIssue(issue) ? nextOrigin : null
    const prevSeat =
      prevOrigin !== null && (this.spinOffChildren.get(prevOrigin) ?? []).includes(id)
        ? prevOrigin
        : null
    if (prevSeat !== liveSeat) {
      if (prevSeat !== null) this.dropSeat(this.spinOffChildren, prevSeat, id)
      if (liveSeat !== null) this.takeSeat(this.spinOffChildren, liveSeat, id)
    }
    if (prevOrigin !== nextOrigin) {
      if (nextOrigin !== null) this.originOf.set(id, nextOrigin)
      else this.originOf.delete(id)
      this.stats.indexUpdates += 1
    }
    // Dependents re-derived from outgoing edges (the wire `dependents` is never read).
    const outgoing = issue === undefined ? null : (issue.deps?.map((edge) => ({ to: edge.id, type: edge.type })) ?? [])
    const prevOutgoing = this.outgoingDeps.get(id)
    const same =
      outgoing !== null &&
      prevOutgoing !== undefined &&
      outgoing.length === prevOutgoing.length &&
      outgoing.every((edge, index) => edge.to === prevOutgoing[index]?.to && edge.type === prevOutgoing[index]?.type)
    if (!same) {
      if (prevOutgoing !== undefined) {
        for (const edge of prevOutgoing) {
          const incoming = this.dependentsOf.get(edge.to)
          if (incoming !== undefined) {
            const next = incoming.filter((entry) => entry.id !== id)
            if (next.length === 0) this.dependentsOf.delete(edge.to)
            else this.dependentsOf.set(edge.to, next)
            this.stats.indexUpdates += 1
          }
        }
      }
      if (outgoing === null) {
        this.outgoingDeps.delete(id)
      } else {
        this.outgoingDeps.set(id, outgoing)
        for (const edge of outgoing) {
          const incoming = this.dependentsOf.get(edge.to) ?? []
          this.dependentsOf.set(edge.to, [...incoming, { id, type: edge.type }])
          this.stats.indexUpdates += 1
        }
      }
    }
    if (issue === undefined) {
      this.explicitByIssue.delete(id)
      this.resolvedByIssue.delete(id)
    }
  }

  private moveSeat(map: Map<string, readonly string[]>, id: string, seat: string | null): void {
    for (const [bucket, members] of [...map]) {
      if (bucket !== seat && members.includes(id)) this.dropSeat(map, bucket, id)
    }
    if (seat !== null) this.takeSeat(map, seat, id)
  }

  private ingestSession(id: string): void {
    const session = this.sessions.get(id)?.value
    const indexed = session !== undefined && session.headless !== true
    const nextExplicit = indexed && session?.issueId ? session.issueId : null
    const prev = this.sessionHome.get(id)
    if ((prev?.explicit ?? null) !== nextExplicit) {
      if (prev?.explicit) this.dropSeat(this.explicitByIssue, prev.explicit, id)
      if (nextExplicit) this.takeSeat(this.explicitByIssue, nextExplicit, id)
      this.sessionHome.set(id, { explicit: nextExplicit, resolved: prev?.resolved ?? null })
    }
    if (session === undefined) {
      const home = this.sessionHome.get(id)
      if (home?.resolved) {
        for (const issueId of this.issuesByWorktree.get(home.resolved) ?? []) {
          this.dropSeat(this.resolvedByIssue, issueId, id)
        }
      }
      this.sessionHome.delete(id)
      return
    }
    if (indexed && !session.issueId) {
      const resolved = this.resolveCwd(session.cwd)
      const home = this.sessionHome.get(id)
      if ((home?.resolved ?? null) !== resolved) {
        if (home?.resolved) {
          for (const issueId of this.issuesByWorktree.get(home.resolved) ?? []) {
            this.dropSeat(this.resolvedByIssue, issueId, id)
          }
        }
        if (resolved) {
          for (const issueId of this.issuesByWorktree.get(resolved) ?? []) {
            this.takeSeat(this.resolvedByIssue, issueId, id)
          }
        }
        this.sessionHome.set(id, { explicit: nextExplicit, resolved })
      }
    } else {
      const home = this.sessionHome.get(id)
      if (home?.resolved) {
        for (const issueId of this.issuesByWorktree.get(home.resolved) ?? []) {
          this.dropSeat(this.resolvedByIssue, issueId, id)
        }
        this.sessionHome.set(id, { explicit: nextExplicit, resolved: null })
      } else if (home && home.explicit !== nextExplicit) {
        this.sessionHome.set(id, { explicit: nextExplicit, resolved: null })
      }
    }
  }

  private ingestWorktree(id: string): void {
    const lane = this.worktrees.get(id)?.value
    if (lane === undefined) {
      if (this.lanePaths.delete(id)) this.stats.indexUpdates += 1
    } else {
      if (!this.lanePaths.has(id)) {
        this.lanePaths.set(id, true)
        this.stats.indexUpdates += 1
      }
      const repoId = lane.repoId ?? null
      if (repoId !== null) {
        const prefix = lane.prefix ?? null
        if ((this.prefixByRepoId.get(repoId) ?? null) !== prefix) {
          this.prefixByRepoId.set(repoId, prefix)
          this.stats.indexUpdates += 1
        }
      }
    }
  }

  /** Re-resolve every unbound session after lane/target moves (spec §2 R3). */
  private resolveAllUnbound(): void {
    for (const [id, home] of [...this.sessionHome]) {
      if (home.explicit !== null) continue
      const session = this.sessions.get(id)?.value
      if (session === undefined || session.headless === true || session.issueId) {
        if (home.resolved !== null) {
          for (const issueId of this.issuesByWorktree.get(home.resolved) ?? []) {
            this.dropSeat(this.resolvedByIssue, issueId, id)
          }
          this.sessionHome.set(id, { explicit: home.explicit, resolved: null })
        }
        continue
      }
      const resolved = this.resolveCwd(session.cwd)
      if (resolved === home.resolved) continue
      if (home.resolved !== null) {
        for (const issueId of this.issuesByWorktree.get(home.resolved) ?? []) {
          this.dropSeat(this.resolvedByIssue, issueId, id)
        }
      }
      if (resolved !== null) {
        for (const issueId of this.issuesByWorktree.get(resolved) ?? []) {
          this.takeSeat(this.resolvedByIssue, issueId, id)
        }
      }
      this.sessionHome.set(id, { explicit: home.explicit, resolved })
    }
  }

  /** Longest-prefix containment over lanes + issue worktree paths (spec §2 R3). */
  resolveCwd(cwd: string): string | null {
    const probe = normalizeRoot(cwd)
    let best: string | null = null
    for (const root of this.roots()) {
      if ((probe === root || probe.startsWith(`${root}/`)) && (best === null || root.length > best.length)) {
        best = root
      }
    }
    return best
  }

  private roots(): string[] {
    return [...this.lanePaths.keys(), ...this.issuesByWorktree.keys()]
  }

  // ----------------------------------------------------------------- reads

  /** Ownership read: explicit then resolved, shells/archived filtered (spec §2 R2/R3). */
  membersOf(issueId: string): SliceSession[] {
    const out: SliceSession[] = []
    const seen = new Set<string>()
    for (const bucket of [this.explicitByIssue.get(issueId), this.resolvedByIssue.get(issueId)]) {
      if (!bucket) continue
      for (const sid of bucket) {
        if (seen.has(sid)) continue
        seen.add(sid)
        const session = this.sessions.get(sid)?.value
        if (session !== undefined && session.agentKind !== 'shell' && !session.archived) {
          out.push(session)
        }
      }
    }
    return out
  }

  /** Unread rollup read: explicit seats minus shells, archived included (spec §3 R-VIS). */
  unreadMembersOf(issueId: string): SliceSession[] {
    const out: SliceSession[] = []
    for (const sid of this.explicitByIssue.get(issueId) ?? []) {
      const session = this.sessions.get(sid)?.value
      if (session !== undefined && session.agentKind !== 'shell') out.push(session)
    }
    return out
  }

  /** Prefix join for `displayRef` (spec §3 R-SUM). */
  prefixForRepo(repoId: string | null | undefined): string | null {
    if (repoId === null || repoId === undefined) return null
    return this.prefixByRepoId.get(repoId) ?? null
  }

  memberIssuesOfSession(sid: string): string[] {
    const home = this.sessionHome.get(sid)
    if (!home) return []
    const out: string[] = []
    if (home.explicit !== null) out.push(home.explicit)
    if (home.resolved !== null) {
      for (const issueId of this.issuesByWorktree.get(home.resolved) ?? []) {
        if (issueId !== home.explicit) out.push(issueId)
      }
    }
    return out
  }

  /** Visible formal subtree: self plus visible descendants (spec §3 R-ROLL). */
  visibleSubtree(rootId: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    const stack = [rootId]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      const model = this.issues.get(id)
      if (!model || this.visibleGuard.has(id)) continue
      if (!model.visible) continue
      out.push(id)
      stack.push(...(this.childrenByParent.get(id) ?? []))
    }
    return out
  }

  /** Issues with an open explicit session (spec §3 R-ROLL batch input). */
  hasOpenExplicit(issueId: string): boolean {
    for (const sid of this.explicitByIssue.get(issueId) ?? []) {
      const session = this.sessions.get(sid)?.value
      if (session !== undefined && openSession(session)) return true
    }
    return false
  }

  /** Latest explicit (non-archived) activity string for tip ranking. */
  lastActiveOwn(issueId: string): string | undefined {
    let latest: string | undefined
    for (const sid of this.explicitByIssue.get(issueId) ?? []) {
      const session = this.sessions.get(sid)?.value
      if (session === undefined || session.archived) continue
      if (latest === undefined || session.lastActiveAt > latest) latest = session.lastActiveAt
    }
    return latest
  }

  lastActiveOf(issueId: string): string {
    const issue = this.issues.get(issueId)?.value
    const latest = issue?.updatedAt ?? ''
    const seen = this.lastActiveOwn(issueId)
    return seen !== undefined && seen > latest ? seen : latest
  }

  /** Spin-off descendants, no liveness filter despite the name (spec §3 R-ROLL). */
  liveDescendants(originId: string): SliceIssue[] {
    const out: SliceIssue[] = []
    const seen = new Set<string>()
    const stack = [originId]
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const childId of this.spinOffChildren.get(id) ?? []) {
        if (seen.has(childId)) continue
        seen.add(childId)
        const child = this.issues.get(childId)?.value
        if (child === undefined) continue
        out.push(child)
        stack.push(childId)
      }
    }
    return out
  }

  /** Preferred continuation tip past this origin (spec §3 R-ROLL). */
  spinOffTip(originId: string): SliceIssue | null {
    const branches = new Map<string, SliceIssue[]>()
    for (const issue of this.liveDescendants(originId)) {
      const origin = spinOffOriginId(issue)
      if (!hasLeftMission(issue.stage, origin) && !(origin !== null && this.hasOpenExplicit(issue.id))) {
        continue
      }
      let branchRoot = issue
      let parentId = spinOffOriginId(branchRoot)
      while (parentId !== null && parentId !== originId) {
        const parent = this.issues.get(parentId)?.value
        if (parent === undefined) break
        branchRoot = parent
        parentId = spinOffOriginId(parent)
      }
      if (parentId !== originId) continue
      const list = branches.get(branchRoot.id) ?? []
      list.push(issue)
      branches.set(branchRoot.id, list)
    }
    const tips: SliceIssue[] = []
    for (const branch of branches.values()) {
      const tip = preferredTip(branch, (id) => this.hasOpenExplicit(id), (id) => this.lastActiveOf(id))
      if (tip !== null) tips.push(tip)
    }
    return preferredTip(tips, (id) => this.hasOpenExplicit(id), (id) => this.lastActiveOf(id))
  }

  /** Review-withdrawal input: continued elsewhere (spec §3 R-ROLL). */
  continuationOf(issue: SliceIssue): boolean {
    const extra = issue as unknown as { supersededBy?: unknown; duplicateOf?: unknown }
    if (typeof extra.supersededBy === 'string' || typeof extra.duplicateOf === 'string') return true
    if (this.hasOpenExplicit(issue.id)) return false
    return this.spinOffTip(issue.id) !== null
  }

  /** Sessionless but continued elsewhere: not a mission unit (spec §3 R-ROLL). */
  vacatedOrigin(issue: SliceIssue): boolean {
    for (const sid of this.explicitByIssue.get(issue.id) ?? []) {
      const session = this.sessions.get(sid)?.value
      if (session?.issueId === issue.id && session !== undefined && openSession(session)) return false
    }
    if (this.spinOffTip(issue.id) !== null) return true
    return (this.dependentsOf.get(issue.id) ?? []).some((edge) => edge.type === 'discovered-from')
  }

  /** Formal members: root plus the R1 closure (spec §3 R-ROLL). */
  formalMembers(rootId: string): string[] {
    const out = [rootId]
    const seen = new Set<string>([rootId])
    const stack = [rootId]
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const childId of this.childrenByParent.get(id) ?? []) {
        if (seen.has(childId)) continue
        seen.add(childId)
        out.push(childId)
        stack.push(childId)
      }
    }
    return out
  }

  /** Mission progress over the live formal subtree (spec §3 R-ROLL). */
  progressOf(rootId: string): { done: number; total: number } {
    const isLive = (id: string): boolean => {
      const issue = this.issues.get(id)?.value
      return issue !== undefined && !issue.archived && (issue.deletedAt === null || issue.deletedAt === undefined)
    }
    const formal = this.formalMembers(rootId).filter((id) => id !== rootId)
    const members = formal.filter((id) => {
      const issue = this.issues.get(id)?.value
      return (
        issue !== undefined && isLive(id) && issue.stage !== 'proposed' && !issueAbandoned(issue)
      )
    })
    // Units come from children when any qualify, else the root stands alone.
    const fromChildren = members.length > 0
    const units = (fromChildren ? members : isLive(rootId) ? [rootId] : []).filter((id) => {
      const issue = this.issues.get(id)?.value
      return issue !== undefined && !issueAbandoned(issue) && !this.vacatedOrigin(issue)
    })
    let done = 0
    for (const id of units) {
      const issue = this.issues.get(id)?.value
      if (issue !== undefined && issueFinished(issue)) done += 1
    }
    return { done, total: units.length }
  }

  // ---------------------------------------------------------------- locals

  /** Selection is a local (spec §3 R-SEL): latch + flip, zero data. */
  setSelection(id: string): void {
    const previous = this.locals.selectedIssueId
    if (previous === id) return
    const lane = this.worklist.laneOf(id)
    this.locals.selectedIssueId = id
    this.locals.selectedIssueWasFolded = (lane ?? 'open') === 'closed'
  }

  /** Coarse-tick: only time-sensitive rows re-derive (spec §5). */
  setCoarseNow(now: number): void {
    if (this.locals.coarseNow === now) return
    this.locals.coarseNow = now
  }

  // ------------------------------------------------------------------ read

  snapshot(): SliceSnapshot {
    const order = this.worklist.snapshotOrder()
    const rowsById: SliceSnapshot['rowsById'] = {}
    const collect = (id: string): void => {
      const row = this.issues.get(id)?.row
      if (row !== undefined && row !== null) rowsById[id] = row
    }
    for (const id of order.pinnedIds) collect(id)
    for (const group of order.groups) {
      for (const id of group.rowIds) collect(id)
      for (const id of group.closedIds) collect(id)
    }
    return { order, rowsById }
  }

  mountWeb(el: Element): () => void {
    this.webRoot?.unmount()
    const root = createRoot(el)
    this.webRoot = root
    // Propagate the harness log across this root (Arm contract).
    const log = currentCommitLog()
    const store = this
    root.render(
      createElement(CommitLogContext.Provider, { value: log }, createElement(MobxList, { store })),
    )
    return () => {
      root.unmount()
      if (this.webRoot === root) this.webRoot = null
    }
  }

  dispose(): void {
    this.off?.()
    this.off = null
    this.webRoot?.unmount()
    this.webRoot = null
    this.issues.clear()
    this.sessions.clear()
    this.worktrees.clear()
    this.childrenByParent.clear()
    this.parentOf.clear()
    this.explicitByIssue.clear()
    this.resolvedByIssue.clear()
    this.sessionHome.clear()
    this.issuesByWorktree.clear()
    this.lanePaths.clear()
    this.originOf.clear()
    this.spinOffChildren.clear()
    this.dependentsOf.clear()
    this.outgoingDeps.clear()
    this.prefixByRepoId.clear()
    this.issuesByRepo.clear()
  }

  /** Test hook: the live store (rebuild-style checks + the native host read through it). */
  handle(): ArmHandle {
    const store = this
    return {
      snapshot: () => store.snapshot(),
      stats: store.stats,
      dispose: () => store.dispose(),
      mountWeb: (el: Element) => store.mountWeb(el),
      mountNative: (): ReactElement => {
        throw new Error(
          '[mobx] mountNative is async — call preloadMobxNative() from ./arm first ' +
            '(react-native loads dynamically, the POD-1220 hazard)',
        )
      },
    }
  }
}
