/**
 * POD-4442 — the arm contract all three round-two arms implement (spec §3 UI
 * contract, §7 oracle projection). Deliberately minimal: arms keep their
 * idiomatic APIs underneath and adapt at this boundary.
 */

import type { ReactElement } from 'react'
import type { ReadFence } from './instrument/reads'
import type { LocalsKey, SliceLocals, SliceSnapshot } from './slice-types'
import type { ArmStats, RowRecord, RowSourceEvent } from './stats'

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
 * POD-4608 (L1e) — the locals as the arms see them: selection and the coarse
 * clock, mirroring {@link RowSource}. Views are functions of the rows and the
 * locals; this is the locals half.
 *
 * `get()` is the value as of the last notification: an arm never sees a local
 * move without being told which one. Its identity changes only when a value
 * does. Each notification names WHICH keys changed, so a tick wakes only
 * clock consumers (`coarseNow`) and a click only selection consumers
 * (`selectedIssueId`, `selectedIssueWasFolded`). Notifications are coalesced
 * like row events: one per drain, carrying the union of the keys that moved,
 * never a key whose value came back to where it was.
 *
 * Implementations: `createLocalsSource` / `fixedLocals` / `settableLocals`
 * (`locals-source.ts`) and the engine-backed `createEngineLocals`
 * (`harness/src/engine-locals.ts`). Each counts its traffic in
 * `LocalsSourceStats` (`stats.ts`).
 */
export interface LocalsSource {
  get(): SliceLocals
  subscribe(listener: (changed: ReadonlySet<LocalsKey>) => void): () => void
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
   * Every row in the list MUST render through
   * `RowShell` (`shared/src/row-shell.tsx`): `<RowShell row={view}
   * component={Row} />`, where `Row` takes exactly `{ row: RowView }`
   * (POD-4547). The shell is how the G4 count harness observes per-row
   * commits and how the capability rule is enforced. Round-two arms and
   * the legacy control use the unenforcing `CommitBoundary` instead.
   * Outside the harness both are a pass-through.
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
  /**
   * `reads` (POD-4557) is the reads-per-change fence. The harness has already
   * passed `source` through it, so every row value arrives borrowed and
   * counted. A round-three arm MUST store those borrowed row objects (never a
   * copy), read its entity tables only through `reads.wrapTables(...)` and its
   * relation buckets only through `reads.wrapRelations(...)`. Timing runs pass
   * `DISABLED_READ_FENCE`, whose wrappers are the identity. Round-two arms and
   * the legacy control predate it and may ignore it.
   *
   * `locals` (POD-4608) is the locals channel. A round-three arm MUST follow
   * it: a selection click (#3) and a clock tick (#8) are locals-only — the row
   * source emits nothing for them — so an arm that reads `locals.get()` only
   * at creation paints a stale selection and stale time-dependent rows. It
   * MUST wake only the consumers of the keys a notification names. Round-two
   * arms and the legacy control read `locals.get()` where they used the value
   * before and may ignore `subscribe`.
   */
  create(source: RowSource, locals: LocalsSource, reads?: ReadFence): ArmHandle
}
