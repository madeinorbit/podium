/**
 * POD-4447 — worktree lane model. Lanes exist for R3 prefix ownership and the
 * repo facts grouping and `displayRef` need (spec §1); they are never
 * rendered (spec §6). Like sessions: a leaf box around the borrowed row.
 */

import { makeObservable, observableRef } from 'mobx'
import type { SliceWorktree } from '../../../shared/src/slice-types'

export class WorktreeModel {
  /** Borrowed immutable stream object; replaced, never mutated. */
  value: SliceWorktree

  constructor(value: SliceWorktree) {
    this.value = value
    makeObservable(this, {
      value: observableRef,
    })
  }
}
