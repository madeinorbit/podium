/**
 * POD-4446 — per-issue own-summary (spec R-SUM, own half): retained/live
 * split, activity stamp, display ref + title, band, repo key. Never walks
 * children (subtree aggregation is the rollup's job). Structurally excluded
 * issues hold no summary, so sessions on them recompute nothing.
 */

import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { assertNever, nullStats, type Delta, type DerivationStats } from './deltas'
import { IndexSet } from './indexes'
import {
  bandOf,
  displayRefOf,
  displayTitleOf,
  groupKeyOf,
  parseMs,
  sessionLive,
  sessionRetains,
  structurallyExcluded,
} from './rules'
import type { IssueTable, SessionTable } from './tables'

export interface OwnSummary {
  activityAt: number
  displayRef: string
  title: string
  band: 0 | 1 | 2
  repoKey: string
}

export interface SummaryTables {
  issues: IssueTable
  sessions: SessionTable
}

export class SummaryModule {
  /** Own-summaries by issue id (visible candidates only). */
  readonly summaries = new Map<string, OwnSummary>()
  /** Rows whose band can move with the coarse clock (deferUntil carriers). */
  readonly timeSensitive = new Set<string>()

  constructor(
    private readonly tables: SummaryTables,
    private readonly indexes: IndexSet,
    private readonly getNow: () => number,
    private readonly stats: DerivationStats = nullStats,
  ) {}

  /** Member sessions in bucket order, shells and archived excluded (the
   *  sessionsForIssueNav ownership read — archived never materialize). */
  membersOf(issueId: string): SliceSession[] {
    const out: SliceSession[] = []
    const seen = new Set<string>()
    for (const bucket of [
      this.indexes.explicitByIssue.get(issueId),
      this.indexes.resolvedByIssue.get(issueId),
    ]) {
      if (bucket === undefined) continue
      for (const sid of bucket) {
        if (seen.has(sid)) continue
        seen.add(sid)
        const session = this.tables.sessions.rows.get(sid)
        if (session !== undefined && session.agentKind !== 'shell' && !session.archived) {
          out.push(session)
        }
      }
    }
    return out
  }

  compute(issueId: string): OwnSummary | null {
    const issue = this.tables.issues.rows.get(issueId)
    if (issue === undefined || structurallyExcluded(issue)) return null
    this.stats.summaries()
    const now = this.getNow()
    const members = this.membersOf(issueId)
    const { retained } = splitMembers(members, now, issue)
    const peak = retained.reduce((max, s) => Math.max(max, parseMs(s.lastActiveAt) ?? 0), 0)
    return {
      activityAt: peak !== 0 ? peak : (parseMs(issue.updatedAt) ?? 0),
      displayRef: displayRefOf(issue, this.indexes.prefixForRepo(issue.repoId)),
      title: displayTitleOf(issue, members[0]),
      band: bandOf(issue, now),
      repoKey: groupKeyOf(issue),
    }
  }

  /** Recompute one issue; emit SummaryChanged iff the committed value moved. */
  refresh(issueId: string, out: Delta[]): void {
    const next = this.compute(issueId)
    const issue = this.tables.issues.rows.get(issueId)
    if (issue?.deferUntil != null) this.timeSensitive.add(issueId)
    else this.timeSensitive.delete(issueId)
    const prev = this.summaries.get(issueId)
    if (next === null) {
      if (prev !== undefined) {
        this.summaries.delete(issueId)
        out.push({ kind: 'SummaryChanged', id: issueId })
      }
      return
    }
    if (prev === undefined || JSON.stringify(prev) !== JSON.stringify(next)) {
      this.summaries.set(issueId, next)
      out.push({ kind: 'SummaryChanged', id: issueId })
    }
  }

  /** Issues whose membership touches a session (explicit or resolved home). */
  private memberIssuesOfSession(sessionId: string): string[] {
    return this.indexes.memberIssuesOfSession(sessionId)
  }

  apply(batch: Delta[]): Delta[] {
    const out: Delta[] = []
    const dirty = new Set<string>()
    for (const delta of batch) {
      switch (delta.kind) {
        case 'IssueChanged':
        case 'IssueRemoved':
        case 'MembershipChanged':
        case 'SummaryChanged':
          // SummaryChanged arrives from the prefix join (indexes): refresh is
          // idempotent, so re-deriving here terminates (one level, one pass).
          dirty.add(delta.kind === 'MembershipChanged' ? delta.issueId : delta.id)
          break
        case 'SessionChanged':
        case 'SessionRemoved':
          for (const issueId of this.memberIssuesOfSession(delta.id)) dirty.add(issueId)
          break
        case 'ClockChanged':
          // Bands are time-dependent; only deferUntil carriers can flip.
          for (const issueId of this.timeSensitive) dirty.add(issueId)
          break
        case 'WorktreeChanged':
        case 'WorktreeRemoved':
        case 'ChildrenChanged':
        case 'OriginChanged':
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
    for (const issueId of dirty) this.refresh(issueId, out)
    return out
  }

  /** Full derive for replace/bootstrap (no deltas; store derives after). */
  rebuildAll(): void {
    this.summaries.clear()
    this.timeSensitive.clear()
    for (const id of this.tables.issues.rows.keys()) {
      // Mirror refresh's sensitivity bookkeeping: a bootstrap that leaves
      // timeSensitive empty blinds every later tick to deferUntil carriers
      // (M2: bands went stale after boot + tick until the first incremental
      // refresh touched the row).
      if (this.tables.issues.rows.get(id)?.deferUntil != null) this.timeSensitive.add(id)
      const next = this.compute(id)
      if (next !== null) this.summaries.set(id, next)
    }
  }
}

/** Retained + live split, shared with the visible module (one computation). */
export function splitMembers(
  members: SliceSession[],
  now: number,
  issue: SliceIssue,
): { retained: SliceSession[]; live: SliceSession[] } {
  const retained = members.filter((s) => sessionRetains(s, now, issue))
  return { retained, live: retained.filter((s) => sessionLive(s, now, issue)) }
}
