/**
 * React bindings for the replica-side issue views [ADR 4 D7.3].
 *
 * The replica is the notification boundary and `issue-view-cache.ts` is the
 * shared projection cache. Every issue surface reads the same snapshot and,
 * after a notification, the same flat model map/array. That keeps a session
 * update from rebuilding one O(world) model per mounted surface.
 *
 * The cache itself is React-free and lives next door, because the published
 * worklist slice reads the same models and must not import React (POD-1053).
 * This file is the binding and nothing else.
 */

import type { IssueId, IssueProjection, IssueWire } from '@podium/model'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  type IssueModelsProjection,
  modelsFor,
  snapshotFor,
  subscribeToIssueViews,
} from './issue-view-cache'
import type { IssueViewModel, IssueViewsSnapshot } from './issue-view-models'
import { buildIssueBoard, type IssueSessionRollups, type IssueView } from './issue-views'
import type { Replica } from './replica'

export {
  allIssueViewModels,
  issueViewModelById,
  issueViewModelIndex,
  issueViewModelProjectionStats,
} from './issue-view-cache'
export type { IssueViewModel, IssueViewsSnapshot } from './issue-view-models'

/** The derived issue world, shared and cached between relevant notifications. */
export function useIssueViews(replica: Replica): IssueViewsSnapshot {
  const getSnapshot = useCallback(() => snapshotFor(replica), [replica])
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToIssueViews(replica, onChange),
    [replica],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** One issue's view + its session rollups. */
export function useIssueView(
  replica: Replica,
  issueId: IssueId,
): { view: IssueView | undefined; rollups: IssueSessionRollups } {
  const snapshot = useIssueViews(replica)
  return useMemo(
    () => ({ view: snapshot.views.get(issueId), rollups: snapshot.rollupsFor(issueId) }),
    [snapshot, issueId],
  )
}

/** The board, grouped by stage. */
export function useIssueBoard(
  replica: Replica,
  stages: readonly string[],
): Map<string, IssueView[]> {
  const snapshot = useIssueViews(replica)
  return useMemo(() => buildIssueBoard(snapshot.views, snapshot.issues, stages), [snapshot, stages])
}

function useIssueModelsSelection<T>(
  replica: Replica,
  select: (projection: IssueModelsProjection) => T,
  projectionRows?: readonly IssueProjection[],
  legacyRows?: readonly IssueWire[],
): T {
  const getSnapshot = useCallback(
    () => select(modelsFor(replica, projectionRows, legacyRows)),
    [legacyRows, projectionRows, replica, select],
  )
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToIssueViews(replica, onChange),
    [replica],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const selectIssueModelIndex = (projection: IssueModelsProjection): Map<string, IssueViewModel> =>
  projection.index
const selectAllIssueModels = (projection: IssueModelsProjection): IssueViewModel[] => projection.all

/** Every issue's flat render model, keyed by id. The Map is shared by all readers. */
export function useIssueViewModels(
  replica: Replica,
  projectionRows?: readonly IssueProjection[],
  legacyRows?: readonly IssueWire[],
): Map<string, IssueViewModel> {
  return useIssueModelsSelection(replica, selectIssueModelIndex, projectionRows, legacyRows)
}

/** Every issue's flat render model in replica order. The array is shared too. */
export function useAllIssueViewModels(
  replica: Replica,
  projectionRows?: readonly IssueProjection[],
  legacyRows?: readonly IssueWire[],
): IssueViewModel[] {
  return useIssueModelsSelection(replica, selectAllIssueModels, projectionRows, legacyRows)
}

/** One issue's flat render model. Unchanged peer models retain identity. */
export function useIssueViewModel(
  replica: Replica,
  issueId: IssueId,
  projectionRows?: readonly IssueProjection[],
  legacyRows?: readonly IssueWire[],
): IssueViewModel | undefined {
  const select = useCallback(
    (projection: IssueModelsProjection) => projection.index.get(issueId),
    [issueId],
  )
  return useIssueModelsSelection(replica, select, projectionRows, legacyRows)
}
