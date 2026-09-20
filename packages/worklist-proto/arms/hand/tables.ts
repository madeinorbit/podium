/**
 * POD-4446 — normalised entity tables keyed by id (methodology §5.2).
 *
 * Values are BORROWED immutable row objects from the stream: stored by
 * reference, never spread or copied on the hot path. A `replace` event clears
 * and reseeds all three tables atomically; an `update` applies per row, with
 * `value: undefined` deleting the row (evict, no tombstone — spec §2).
 */

import type { SliceIssue, SliceSession, SliceWorktree } from '../../shared/src/slice-types'
import type { RowRecord } from '../../shared/src/stats'
import type { Delta } from './deltas'

export class IssueTable {
  readonly rows = new Map<string, SliceIssue>()

  apply(record: RowRecord): Delta | null {
    if (record.kind !== 'issue') return null
    if (record.value === undefined) {
      return this.rows.delete(record.id) ? { kind: 'IssueRemoved', id: record.id } : null
    }
    const previous = this.rows.get(record.id)
    // Borrowed identity: an unchanged object keeps its reference, so downstream
    // value comparisons stay cheap and honest.
    if (previous === record.value) return null
    this.rows.set(record.id, record.value as SliceIssue)
    return { kind: 'IssueChanged', id: record.id }
  }

  clear(): void {
    this.rows.clear()
  }
}

export class SessionTable {
  readonly rows = new Map<string, SliceSession>()

  apply(record: RowRecord): Delta | null {
    if (record.kind !== 'session') return null
    if (record.value === undefined) {
      return this.rows.delete(record.id) ? { kind: 'SessionRemoved', id: record.id } : null
    }
    const previous = this.rows.get(record.id)
    if (previous === record.value) return null
    this.rows.set(record.id, record.value as SliceSession)
    return { kind: 'SessionChanged', id: record.id }
  }

  clear(): void {
    this.rows.clear()
  }
}

export class WorktreeTable {
  /** Keyed by lane path (the stream's worktree row id). */
  readonly rows = new Map<string, SliceWorktree>()

  apply(record: RowRecord): Delta | null {
    if (record.kind !== 'worktree') return null
    if (record.value === undefined) {
      return this.rows.delete(record.id) ? { kind: 'WorktreeRemoved', id: record.id } : null
    }
    const previous = this.rows.get(record.id)
    if (previous === record.value) return null
    this.rows.set(record.id, record.value as SliceWorktree)
    return { kind: 'WorktreeChanged', id: record.id }
  }

  clear(): void {
    this.rows.clear()
  }
}
