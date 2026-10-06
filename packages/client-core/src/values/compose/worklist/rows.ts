/** Value types retained for worklist consumers. Legacy whole-list construction is a test fixture. */
import type { SessionView } from '../../../session-values'
import type { UnifiedWorkRow } from './row-types'

/** One entry in the WORKING section (move-out semantics): a fully-working issue
 *  or worktree row, or an individual working session lifted out of a partially-
 *  working row. */
export type WorkingEntry =
  | { kind: 'issue'; row: Extract<UnifiedWorkRow, { kind: 'issue' }> }
  | { kind: 'worktree'; row: Extract<UnifiedWorkRow, { kind: 'worktree' }> }
  | { kind: 'session'; session: SessionView }

export interface UnifiedWorkPartition {
  /** WORKING rows/sessions, preserving the unified list's manual row order. */
  working: WorkingEntry[]
  /** The WORK list (banded order), minus whatever moved to WORKING. */
  work: UnifiedWorkRow[]
}
