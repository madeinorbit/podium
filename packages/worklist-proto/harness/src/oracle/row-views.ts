/**
 * POD-4563 (L6a) — the ROW VIEW oracle: every field of every visible row's
 * `RowView` (`shared/src/row-view.ts`), projected from the legacy derivation.
 *
 * WHY. The exact-commit fence (`assertCommits`, `count-harness.tsx`) needs the
 * set of rows whose RENDERED input changed. `SliceSnapshot` is the parity
 * projection and omits what a row draws beyond it — the selection, the
 * spin-off origin tick, the recency and working stamps — so round two needed
 * an "allowed over-commit" list (the #4 origin tick) and a click that
 * committed two rows looked like two over-commits. The row view is the whole
 * input of a round-three row component (`RowShell` hands it nothing else), so
 * "rows whose view changed" is exactly "rows that must commit", with no
 * allowance list.
 *
 * Every field comes from the same legacy derivation `projectSnapshot` uses:
 * the `SliceRow` half IS `projectSnapshot`'s row, and the rest cites the
 * legacy source it mirrors (the field docs in `row-view.ts` name them).
 */

import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import {
  type IssueNavigationModel,
  isSessionWorking,
  issueAbandoned,
  issueClosedFoldAt,
  issueDisplayTitle,
} from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { isRowSeat, type RowOriginTick, type RowView } from '@podium/client-graph/shared/row-view'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import {
  type LegacyDerivation,
  legacyDerivationFromStore,
  projectSnapshot,
  visibleIssueRows,
} from './oracle'

/** Every visible row's view, keyed by issue id. */
export type RowViews = Record<string, RowView>

/**
 * `workingSinceMs` (`apps/web/src/features/worklist/time-indicators.tsx:34-43`,
 * which this package cannot import): the earliest `agentState.since` (else
 * `lastActiveAt`) among the row's own working seats, or null.
 */
function workingSinceOf(sessions: readonly SessionMeta[]): number | null {
  let earliest: number | null = null
  for (const session of sessions) {
    if (!isRowSeat(session) || !isSessionWorking(session)) continue
    const at = Date.parse(session.agentState?.since ?? session.lastActiveAt)
    if (!Number.isFinite(at)) continue
    if (earliest === null || at < earliest) earliest = at
  }
  return earliest
}

/**
 * `legacyOriginTick` (`UnifiedIssueRow.tsx:450-460`) over every issue model,
 * visible or not; the title follows the row's own display-title rule, as the
 * `RowOriginTick` contract says.
 */
function originTickOf(
  issue: IssueNavigationModel,
  byId: ReadonlyMap<string, IssueNavigationModel>,
  derivation: LegacyDerivation,
): RowOriginTick | null {
  // `deps` is absent on a freshly created issue's model (the #6a write).
  const dep = issue.deps?.find((edge) => edge.type === 'discovered-from')
  if (dep === undefined) return null
  const origin = byId.get(dep.id)
  if (origin === undefined) return null
  return {
    id: origin.id,
    seq: origin.seq,
    title: issueDisplayTitle(origin, derivation.sessions, derivation.allWorktreePaths),
    ref: origin.displayRef ?? `#${origin.seq}`,
  }
}

/** Project an already-run legacy derivation onto every visible row's view. */
export function projectRowViews(derivation: LegacyDerivation, locals: SliceLocals): RowViews {
  const snapshot = projectSnapshot(derivation, locals)
  const byId = new Map<string, IssueNavigationModel>()
  for (const model of derivation.models) byId.set(model.id, model)
  const views: RowViews = {}
  for (const row of visibleIssueRows(derivation, locals)) {
    const id = row.issue.id
    const base = snapshot.rowsById[id]
    if (base === undefined) throw new Error(`[row-views] no oracle row for ${id}`)
    views[id] = {
      ...base,
      selected: locals.selectedIssueId === id,
      originTick: originTickOf(row.issue, byId, derivation),
      activityAt: row.activityAt,
      workingSince: workingSinceOf(row.sessions),
      pinned: row.issue.pinned === true,
      sortKey: row.issue.sortKey ?? null,
      createdAt: row.issue.createdAt,
      seq: row.issue.seq,
      foldAt: issueClosedFoldAt(row.issue),
      dismissed: base.closed && (issueAbandoned(row.issue) || row.issue.tuckedAt != null),
    }
  }
  return views
}

/** The row views the current app would draw for a live engine store, derived
 *  and projected at `locals.coarseNow` (one clock, POD-4559). */
export function rowViewsFromStore(store: Store<PodiumClientApi>, locals: SliceLocals): RowViews {
  return projectRowViews(legacyDerivationFromStore(store, locals.coarseNow), locals)
}
