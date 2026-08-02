/**
 * POD-330/POD-1496 — worklist row ORDER: where a row sits relative to its
 * siblings. Band first (explicit user state), then the persisted manual key,
 * then immutable creation order.
 *
 * The invariant that makes this a module and not a bag: rows in, an order out.
 * Nothing here reads a row's attention, status or fold membership — attention
 * is carried per-row by the square language, never by reordering (#64).
 */
import { isIssueDeferred, issueReturnedFromDefer } from '@podium/model'
import type { UnifiedWorkRow } from './row-types'

/** Band for the WORK list: pinned or returned-from-defer issues float to the top
 *  (0), snoozed issues sink to the bottom (2), everything else sits in the middle
 *  (1). Worktree rows have no such state, so they're always the middle band. */
export function unifiedRowBand(row: UnifiedWorkRow, now: number): number {
  if (row.kind === 'issue') {
    if (row.issue.pinned || issueReturnedFromDefer(row.issue, now)) return 0
    if (isIssueDeferred(row.issue, now)) return 2
  }
  return 1
}

/** Immutable creation order, newest first (#64): issue rows key on createdAt
 *  (seq breaks a same-instant tie, id keeps it deterministic). Worktree rows
 *  carry no creation stamp, so they sink below every issue row and order among
 *  themselves by path. Nothing here moves while agents work — the sidebar's
 *  order may only change when work is created (or the user pins/snoozes). */
export function compareCreationDesc(a: UnifiedWorkRow, b: UnifiedWorkRow): number {
  if (a.kind !== b.kind) return a.kind === 'issue' ? -1 : 1
  if (a.kind === 'issue' && b.kind === 'issue') {
    const dt = (Date.parse(b.issue.createdAt) || 0) - (Date.parse(a.issue.createdAt) || 0)
    if (dt !== 0) return dt
    if (a.issue.seq !== b.issue.seq) return b.issue.seq - a.issue.seq
    return a.issue.id.localeCompare(b.issue.id)
  }
  return a.kind === 'worktree' && b.kind === 'worktree'
    ? a.worktree.path.localeCompare(b.worktree.path)
    : 0
}

/** Manual order within a band (POD-168, R1): persisted `sortKey` ascending —
 *  keys are minted above the scope minimum on create, so new-at-top (R2) falls
 *  out naturally. A keyed row sorts before any unkeyed (legacy) row — a fresh
 *  issue still lands on top of a scope that predates keys — and unkeyed rows
 *  keep the old newest-first creation order among themselves. Keys are only
 *  ever meaningful against SIBLINGS (one key space per scope); cross-scope
 *  comparisons here are harmless because grouping happens downstream. */
export function compareManualOrder(a: UnifiedWorkRow, b: UnifiedWorkRow): number {
  if (a.kind === 'issue' && b.kind === 'issue') {
    const ka = a.issue.sortKey
    const kb = b.issue.sortKey
    if (ka && kb && ka !== kb) return ka < kb ? -1 : 1
    if (ka && !kb) return -1
    if (!ka && kb) return 1
  }
  return compareCreationDesc(a, b)
}

/** WORK-list order: band asc (pinned/returned top, snoozed bottom — explicit
 *  user actions only), then manual sortKey order (creation-desc fallback).
 *  Urgency, activity and updatedAt deliberately do NOT sort — attention is
 *  carried per-row by the square language / amber pill / motion meta, never by
 *  reordering, so rows hold still while agents work (#64). */
export function sortUnifiedWorkRows(rows: UnifiedWorkRow[], now: number): UnifiedWorkRow[] {
  return [...rows].sort((a, b) => {
    const db = unifiedRowBand(a, now) - unifiedRowBand(b, now)
    if (db !== 0) return db
    return compareManualOrder(a, b)
  })
}
