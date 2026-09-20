/**
 * POD-4446 — the four slice relations, maintained by delta (spec §2).
 * Buckets hold IDS (objects live in the tables): content-only changes move
 * no bucket. R1 children by parent (live-child edges; orphans become roots),
 * R2 sessions by issue (explicit first), R3 by worktree prefix
 * (longest-prefix containment; attached elsewhere never shows), R4 the
 * discovered-from origin edge + adjacency, plus the repo-prefix join.
 * Evict deletes the row and every bucket holding it — never a tombstone.
 */

import type { SliceIssue, SliceSession } from '../../shared/src/slice-types'
import { assertNever, nullStats, type Delta, type DerivationStats } from './deltas'
import type { IssueTable, SessionTable, WorktreeTable } from './tables'

function isLiveIssue(issue: SliceIssue): boolean {
  return !issue.archived && issue.deletedAt == null
}

/** missionParentId (mission.ts:905): archived/deleted contribute no edge. */
function parentEdgeOf(issue: SliceIssue): string | null {
  if (!isLiveIssue(issue)) return null
  return issue.parentId ?? null
}

function isIndexedSession(session: SliceSession): boolean {
  return session.headless !== true
}

function originEdgeOf(issue: SliceIssue): string | null {
  return issue.deps?.find((dep) => dep.type === 'discovered-from')?.id ?? null
}

function normalizeRoot(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

export interface IndexTables {
  issues: IssueTable
  sessions: SessionTable
  worktrees: WorktreeTable
}

export class IndexSet {
  /** Honest bucket-write counter, wired by the store. */
  stats: DerivationStats = nullStats

  constructor(private readonly tables: IndexTables) {}
  /** R1: live child ids by parent id (parent may be archived/missing). */
  readonly childrenByParent = new Map<string, Set<string>>()
  /** R1 inverse: child id -> parent id (formal walk + staffed-subtree walk). */
  readonly parentOf = new Map<string, string>()
  /** R2: explicitly attached session ids by issue id (archived included,
   *  filtered at read — so the unread rollup sees the same seats). */
  readonly explicitByIssue = new Map<string, Set<string>>()
  /** R3: prefix-resolved session ids by issue id (archived included). */
  readonly resolvedByIssue = new Map<string, Set<string>>()
  /** Cached session home for diffing: explicit issue + resolved worktree. */
  private readonly sessionHome = new Map<string, { explicit: string | null; resolved: string | null }>()
  /** R3 targets: live issues with a worktreePath, by path. */
  private readonly issuesByWorktree = new Map<string, Set<string>>()
  /** R3 roots: lane paths + issue worktree paths. */
  private roots = new Set<string>()
  /** R4: origin issue id per issue. */
  readonly originOf = new Map<string, string>()
  /** R4 adjacency: origin id -> live issues naming it (spin-off branches). */
  readonly spinOffChildren = new Map<string, Set<string>>()
  /** displayRef join: repo prefix per repo id. */
  readonly prefixByRepoId = new Map<string, string | null>()
  /** Issues per repo id (prefix-change fan-out). */
  private readonly issuesByRepo = new Map<string, Set<string>>()
  /** Lane paths (worktree row ids) for R3 roots. */
  private readonly lanePaths = new Set<string>()

  // ------------------------------------------------------------ R1 + R4 + repo

  private ingestIssue(id: string): Delta[] {
    const issue = this.tables.issues.rows.get(id)
    const out: Delta[] = []
    // R1 edge.
    const nextEdge = issue === undefined ? null : parentEdgeOf(issue)
    const prevEdge = this.parentOf.get(id) ?? null
    if (prevEdge !== nextEdge) {
      if (prevEdge !== null) {
        this.childrenByParent.get(prevEdge)?.delete(id)
        this.stats.index()
      }
      if (nextEdge !== null) {
        let bucket = this.childrenByParent.get(nextEdge)
        if (bucket === undefined) {
          bucket = new Set()
          this.childrenByParent.set(nextEdge, bucket)
        }
        bucket.add(id)
        this.stats.index()
      }
      if (nextEdge === null) this.parentOf.delete(id)
      else this.parentOf.set(id, nextEdge)
      out.push({ kind: 'ChildrenChanged', childId: id, from: prevEdge, to: nextEdge })
    }
    // R3 target seat.
    const seatChanged = this.moveSeat(this.issuesByWorktree, id, issue !== undefined && isLiveIssue(issue) && issue.worktreePath != null ? issue.worktreePath : null)
    if (seatChanged) {
      this.rebuildRoots()
      out.push(...this.resolveAllUnbound((sid) => this.tables.sessions.rows.get(sid)))
    }
    // Repo seat (prefix fan-out).
    this.moveSeat(this.issuesByRepo, id, issue?.repoId ?? null)
    // R4 edge (kept at any liveness) + adjacency seat (live issues only,
    // like spinOffChildren in mission.ts).
    const nextOrigin = issue === undefined ? null : originEdgeOf(issue)
    const prevOrigin = this.originOf.get(id) ?? null
    const liveSeat = issue !== undefined && isLiveIssue(issue) ? nextOrigin : null
    const prevSeat =
      prevOrigin !== null && this.spinOffChildren.get(prevOrigin)?.has(id) === true
        ? prevOrigin
        : null
    if (prevSeat !== liveSeat) {
      if (prevSeat !== null) {
        const siblings = this.spinOffChildren.get(prevSeat)
        if (siblings !== undefined) {
          siblings.delete(id)
          if (siblings.size === 0) this.spinOffChildren.delete(prevSeat)
        }
      }
      if (liveSeat !== null) {
        let siblings = this.spinOffChildren.get(liveSeat)
        if (siblings === undefined) {
          siblings = new Set()
          this.spinOffChildren.set(liveSeat, siblings)
        }
        siblings.add(id)
      }
      this.stats.index()
    }
    if (prevOrigin !== nextOrigin) {
      if (nextOrigin === null) this.originOf.delete(id)
      else this.originOf.set(id, nextOrigin)
      this.stats.index()
      out.push({ kind: 'OriginChanged', id })
    }
    if (issue === undefined) {
      this.explicitByIssue.delete(id)
      this.resolvedByIssue.delete(id)
      // Orphaned children surface as roots (buildIssueTree rule, spec R1).
      const orphans = this.childrenByParent.get(id)
      if (orphans !== undefined) {
        this.childrenByParent.delete(id)
        this.stats.index()
        for (const child of orphans) {
          this.parentOf.delete(child)
          out.push({ kind: 'ChildrenChanged', childId: child, from: id, to: null })
        }
      }
    }
    return out
  }

  private moveSeat(map: Map<string, Set<string>>, id: string, seat: string | null): boolean {
    let changed = false
    for (const [key, bucket] of map) {
      if (key !== seat && bucket.delete(id)) {
        changed = true
        if (bucket.size === 0) map.delete(key)
      }
    }
    if (seat !== null) {
      let bucket = map.get(seat)
      if (bucket === undefined) {
        bucket = new Set()
        map.set(seat, bucket)
      }
      if (!bucket.has(id)) {
        bucket.add(id)
        changed = true
      }
    }
    if (changed) this.stats.index()
    return changed
  }

  // ------------------------------------------------------------ R2 + R3

  private ingestSession(id: string): Delta[] {
    const session = this.tables.sessions.rows.get(id)
    const out: Delta[] = []
    const prev = this.sessionHome.get(id)
    const prevExplicit = prev?.explicit ?? null
    const prevResolved = prev?.resolved ?? null
    const nextExplicit =
      session !== undefined && isIndexedSession(session) && session.issueId != null
        ? session.issueId
        : null
    if (prevExplicit !== nextExplicit) {
      if (prevExplicit !== null) this.dropSeat(this.explicitByIssue, prevExplicit, id)
      if (nextExplicit !== null) this.takeSeat(this.explicitByIssue, nextExplicit, id)
      out.push(...this.membershipChanged(prevExplicit, nextExplicit))
    }
    if (session !== undefined && isIndexedSession(session) && session.issueId == null) {
      const resolved = this.resolveCwd(session.cwd)
      if (prevResolved !== resolved) {
        if (prevResolved !== null) {
          for (const issueId of this.issuesByWorktree.get(prevResolved) ?? []) {
            if (this.dropSeat(this.resolvedByIssue, issueId, id)) {
              out.push({ kind: 'MembershipChanged', issueId })
            }
          }
        }
        if (resolved !== null) {
          for (const issueId of this.issuesByWorktree.get(resolved) ?? []) {
            if (this.takeSeat(this.resolvedByIssue, issueId, id)) {
              out.push({ kind: 'MembershipChanged', issueId })
            }
          }
        }
        this.sessionHome.set(id, { explicit: nextExplicit, resolved })
      } else {
        this.sessionHome.set(id, { explicit: nextExplicit, resolved: prevResolved })
      }
    } else {
      if (prevResolved !== null) {
        for (const issueId of this.issuesByWorktree.get(prevResolved) ?? []) {
          if (this.dropSeat(this.resolvedByIssue, issueId, id)) {
            out.push({ kind: 'MembershipChanged', issueId })
          }
        }
      }
      if (session === undefined) this.sessionHome.delete(id)
      else this.sessionHome.set(id, { explicit: nextExplicit, resolved: null })
    }
    return out
  }

  private membershipChanged(prev: string | null, next: string | null): Delta[] {
    const out: Delta[] = []
    if (prev !== null && prev !== next) out.push({ kind: 'MembershipChanged', issueId: prev })
    if (next !== null && next !== prev) out.push({ kind: 'MembershipChanged', issueId: next })
    return out
  }

  private takeSeat(map: Map<string, Set<string>>, key: string, id: string): boolean {
    let bucket = map.get(key)
    if (bucket === undefined) {
      bucket = new Set()
      map.set(key, bucket)
    }
    if (bucket.has(id)) return false
    bucket.add(id)
    this.stats.index()
    return true
  }

  private dropSeat(map: Map<string, Set<string>>, key: string, id: string): boolean {
    const bucket = map.get(key)
    if (bucket === undefined || !bucket.delete(id)) return false
    if (bucket.size === 0) map.delete(key)
    this.stats.index()
    return true
  }

  /** Re-resolve every unbound session (lane / worktree-path change). */
  resolveAllUnbound(getSession: (id: string) => SliceSession | undefined): Delta[] {
    const out: Delta[] = []
    for (const [id, home] of this.sessionHome) {
      if (home.explicit !== null) continue
      const session = getSession(id)
      const resolved =
        session !== undefined && isIndexedSession(session) && session.issueId == null
          ? this.resolveCwd(session.cwd)
          : null
      if (resolved === home.resolved) continue
      if (home.resolved !== null) {
        for (const issueId of this.issuesByWorktree.get(home.resolved) ?? []) {
          if (this.dropSeat(this.resolvedByIssue, issueId, id)) {
            out.push({ kind: 'MembershipChanged', issueId })
          }
        }
      }
      if (resolved !== null) {
        for (const issueId of this.issuesByWorktree.get(resolved) ?? []) {
          if (this.takeSeat(this.resolvedByIssue, issueId, id)) {
            out.push({ kind: 'MembershipChanged', issueId })
          }
        }
      }
      this.sessionHome.set(id, { explicit: home.explicit, resolved })
    }
    return out
  }

  /** Unread-rollup member objects: explicit seats minus shells (archived
   *  included — indexSessionsByIssue skips shells only). */
  unreadMembersOf(issueId: string): SliceSession[] {
    const out: SliceSession[] = []
    for (const sid of this.explicitByIssue.get(issueId) ?? []) {
      const session = this.tables.sessions.rows.get(sid)
      if (session !== undefined && session.agentKind !== 'shell') out.push(session)
    }
    return out
  }

  /** Issues holding a session id in either membership bucket. */
  memberIssuesOfSession(sessionId: string): string[] {
    const out: string[] = []
    for (const [issueId, bucket] of this.explicitByIssue) {
      if (bucket.has(sessionId)) out.push(issueId)
    }
    for (const [issueId, bucket] of this.resolvedByIssue) {
      if (bucket.has(sessionId)) out.push(issueId)
    }
    return out
  }

  /** Longest-prefix containment of a cwd against lane + issue-worktree roots. */
  private resolveCwd(cwd: string): string | null {
    const probe = normalizeRoot(cwd)
    let best: string | null = null
    for (const root of this.roots) {
      if (probe === root || probe.startsWith(`${root}/`)) {
        if (best === null || root.length > best.length) best = root
      }
    }
    return best
  }

  // ------------------------------------------------------------ lanes

  /** Lane upsert/remove. Returns summary deltas for prefix-join changes. */
  private ingestWorktree(id: string): Delta[] {
    const lane = this.tables.worktrees.rows.get(id)
    const out: Delta[] = []
    if (lane === undefined) this.lanePaths.delete(id)
    else this.lanePaths.add(id)
    this.rebuildRoots()
    const repoId = lane?.repoId ?? null
    if (repoId !== null) {
      const prefix = lane?.prefix ?? null
      if ((this.prefixByRepoId.get(repoId) ?? null) !== prefix) {
        this.prefixByRepoId.set(repoId, prefix)
        for (const issueId of this.issuesByRepo.get(repoId) ?? []) {
          out.push({ kind: 'SummaryChanged', id: issueId })
        }
      }
    }
    return out
  }

  notePrefix(repoId: string, prefix: string | null): void {
    this.prefixByRepoId.set(repoId, prefix)
  }

  prefixForRepo(repoId: string | null | undefined): string | null {
    if (repoId == null) return null
    return this.prefixByRepoId.get(repoId) ?? null
  }

  issuesOfRepo(repoId: string): Set<string> {
    return this.issuesByRepo.get(repoId) ?? new Set()
  }

  private rebuildRoots(): void {
    const roots = new Set<string>(this.lanePaths)
    for (const path of this.issuesByWorktree.keys()) roots.add(path)
    this.roots = roots
  }

  rebuildRootsAfterIssue(): void {
    this.rebuildRoots()
  }

  /** Bulk build for replace: no deltas, the store derives everything after. */
  rebuildAll(
    issues: Iterable<[string, SliceIssue]>,
    sessions: Iterable<[string, SliceSession]>,
    lanes: Iterable<string>,
    laneInfo: (path: string) => { repoId?: string | null; prefix?: string | null },
  ): void {
    this.childrenByParent.clear()
    this.parentOf.clear()
    this.explicitByIssue.clear()
    this.resolvedByIssue.clear()
    this.sessionHome.clear()
    this.sessionHome.clear()
    this.issuesByWorktree.clear()
    this.originOf.clear()
    this.spinOffChildren.clear()
    this.prefixByRepoId.clear()
    this.issuesByRepo.clear()
    this.lanePaths.clear()
    for (const path of lanes) {
      this.lanePaths.add(path)
      const info = laneInfo(path)
      if (info.repoId != null) this.prefixByRepoId.set(info.repoId, info.prefix ?? null)
    }
    for (const [id, issue] of issues) {
      const edge = parentEdgeOf(issue)
      if (edge !== null) {
        this.parentOf.set(id, edge)
        let bucket = this.childrenByParent.get(edge)
        if (bucket === undefined) {
          bucket = new Set()
          this.childrenByParent.set(edge, bucket)
        }
        bucket.add(id)
      }
      if (isLiveIssue(issue) && issue.worktreePath != null) {
        let bucket = this.issuesByWorktree.get(issue.worktreePath)
        if (bucket === undefined) {
          bucket = new Set()
          this.issuesByWorktree.set(issue.worktreePath, bucket)
        }
        bucket.add(id)
      }
      if (issue.repoId != null) {
        let bucket = this.issuesByRepo.get(issue.repoId)
        if (bucket === undefined) {
          bucket = new Set()
          this.issuesByRepo.set(issue.repoId, bucket)
        }
        bucket.add(id)
      }
      const origin = originEdgeOf(issue)
      if (origin !== null) this.originOf.set(id, origin)
      if (origin !== null && isLiveIssue(issue)) {
        let siblings = this.spinOffChildren.get(origin)
        if (siblings === undefined) {
          siblings = new Set()
          this.spinOffChildren.set(origin, siblings)
        }
        siblings.add(id)
      }
    }
    this.rebuildRoots()
    for (const [id, session] of sessions) {
      if (!isIndexedSession(session)) {
        this.sessionHome.set(id, { explicit: null, resolved: null })
        continue
      }
      if (session.issueId != null) {
        let bucket = this.explicitByIssue.get(session.issueId)
        if (bucket === undefined) {
          bucket = new Set()
          this.explicitByIssue.set(session.issueId, bucket)
        }
        bucket.add(id)
        this.sessionHome.set(id, { explicit: session.issueId, resolved: null })
      } else {
        const resolved = this.resolveCwd(session.cwd)
        this.sessionHome.set(id, { explicit: null, resolved })
        if (resolved !== null) {
          for (const issueId of this.issuesByWorktree.get(resolved) ?? []) {
            let bucket = this.resolvedByIssue.get(issueId)
            if (bucket === undefined) {
              bucket = new Set()
              this.resolvedByIssue.set(issueId, bucket)
            }
            bucket.add(id)
          }
        }
      }
    }
  }

  /** One apply(delta): updates outputs in place, emits typed deltas. */
  apply(delta: Delta): Delta[] {
    switch (delta.kind) {
      case 'IssueChanged':
      case 'IssueRemoved':
        return this.ingestIssue(delta.id)
      case 'SessionChanged':
      case 'SessionRemoved':
        return this.ingestSession(delta.id)
      case 'WorktreeChanged':
      case 'WorktreeRemoved': {
        const out = this.ingestWorktree(delta.id)
        out.push(
          ...this.resolveAllUnbound((id) => this.tables.sessions.rows.get(id)),
        )
        return out
      }
      case 'MembershipChanged':
      case 'ChildrenChanged':
      case 'OriginChanged':
      case 'SummaryChanged':
      case 'RollupChanged':
      case 'VisibilityChanged':
      case 'OrderChanged':
      case 'GroupChanged':
      case 'RowChanged':
      case 'SelectionChanged':
      case 'ClockChanged':
        return []
      default:
        return assertNever(delta)
    }
  }
}
