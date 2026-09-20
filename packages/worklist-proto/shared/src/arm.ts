/**
 * POD-4442 — the arm contract all three round-two arms implement (spec §3 UI
 * contract, §7 oracle projection). Deliberately minimal: arms keep their
 * idiomatic APIs underneath and adapt at this boundary.
 */

import type { ReactElement } from 'react'
import type { SliceLocals, SliceSnapshot } from './slice-types'
import type { RowRecord, RowSourceEvent } from './stats'
import type { ArmStats } from './stats'

/**
 * The kernel's effective per-row row stream, as the arms see it. Owned by G3
 * (POD-4444); arms must read nothing beyond it — no legacy store, no replica
 * object, no view-model import.
 */
export interface RowSource {
  /** Current rows of one kind, in stream order. */
  snapshot(kind: RowRecord['kind']): RowRecord[]
  /** One callback per publication, coalesced: never a transient half-applied list. */
  subscribe(listener: (event: RowSourceEvent) => void): () => void
}

/**
 * One arm instance: a fresh store per principal. Evict is a delete, rescope is
 * one `replace`, disposal must leave no leak (methodology scenarios 11–13).
 */
export interface ArmHandle {
  /** Current slice output. Identity-stable for unchanged rows. */
  snapshot(): SliceSnapshot
  stats: ArmStats
  dispose(): void
  /**
   * Mount the arm's own windowed web list into `el`; returns the unmount.
   *
   * Every row component in the list MUST render inside
   * `RowShell` (`shared/src/row-shell.tsx`) keyed by its slice row id —
   * that shell is how the G4 count harness observes per-row commits.
   * Outside the harness the shell is a pass-through.
   *
   * Because `mountWeb` renders through its own root, it MUST propagate the
   * harness log explicitly: capture `currentCommitLog()` at mount and wrap
   * the tree in `<CommitLogContext.Provider value={log}>`. Context does not
   * cross the root boundary on its own, and the ambient fallback is only for
   * the mount instant — never for commits.
   */
  mountWeb(el: Element): () => void
  /** The arm's own native list element (React Native unit renderer). */
  mountNative(): ReactElement
}

export interface Arm {
  create(source: RowSource, locals: SliceLocals): ArmHandle
}
