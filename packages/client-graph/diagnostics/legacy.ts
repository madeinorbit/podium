/** Diagnostic-only legacy derivation. Never imported by pool rows or app readers. */
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ReferenceState as Store } from '@podium/client-graph/diagnostics/reference-state'

import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import { sortUnifiedWorkRows, type IssueNavigationModel, type UnifiedIssueRow, type UnifiedWorkRow } from '@podium/client-core/values'
import { worklistSlice, type WorklistSlice } from '@podium/client-graph/diagnostics/reference/worklist'
import type { SessionView } from '@podium/client-core/session-values'
import type { SliceLocals } from '../src/shared/slice-types'

export interface LegacyDerivation {
  slice: WorklistSlice
  models: IssueNavigationModel[]
  sessions: SessionView[]
  allWorktreePaths: string[]
}

export function legacyDerivationFromStore(
  store: Store<PodiumClientApi>,
  coarseNow: number = store.coarseNow,
): LegacyDerivation {
  const replica = store.replica
  const projections = store.issueProjections ?? []
  const models = allIssueViewModels(replica, projections, store.issueUserStates)
  const slice = worklistSlice.derive(atClock(store, coarseNow))
  return { slice, models, sessions: store.sessions, allWorktreePaths: slice.allWorktreePaths }
}

/** The store as the derivation reads it, with its clock read as `coarseNow`. */
function atClock(store: Store<PodiumClientApi>, coarseNow: number): Store<PodiumClientApi> {
  if (store.coarseNow === coarseNow) return store
  return new Proxy(store, {
    get: (target, key, receiver) =>
      key === 'coarseNow' ? coarseNow : Reflect.get(target, key, receiver),
  })
}

function flattenIssueRows(rows: UnifiedWorkRow[]): UnifiedIssueRow[] {
  const out: UnifiedIssueRow[] = []
  const visit = (row: UnifiedWorkRow): void => {
    if (row.kind !== 'issue') return
    out.push(row)
    for (const child of row.startedByChildren ?? []) visit(child)
  }
  for (const row of rows) visit(row)
  return out
}

export function visibleIssueRows(
  derivation: LegacyDerivation,
  locals: SliceLocals,
): UnifiedIssueRow[] {
  return sortUnifiedWorkRows(flattenIssueRows(derivation.slice.work), locals.coarseNow).filter(
    (row): row is UnifiedIssueRow => row.kind === 'issue',
  )
}
