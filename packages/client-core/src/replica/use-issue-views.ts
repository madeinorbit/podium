/**
 * React bindings for the replica-side issue views [ADR 4 D7.3].
 *
 * The replica is the notification boundary and this module is the shared
 * projection cache. Every issue surface reads the same snapshot and, after a
 * notification, the same flat model map/array. That keeps a session update from
 * rebuilding one O(world) model per mounted surface.
 */

import type { IssueProjection, IssueWire, IssueId } from '@podium/model'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  buildIssueBoard,
  type IssueSessionRollups,
  type IssueView,
} from './issue-views'
import {
  buildIssueViewModels,
  deriveIssueViewsSnapshot,
  type IssueViewModel,
  type IssueViewsSnapshot,
} from './issue-view-models'
import type { Replica } from './replica'

export type { IssueViewModel, IssueViewsSnapshot } from './issue-view-models'

type CachedIssueViewsSnapshot = IssueViewsSnapshot & {
  projectionRows: readonly IssueProjection[]
  legacyRows: readonly IssueWire[]
}

interface IssueModelsProjection {
  snapshot: CachedIssueViewsSnapshot
  projectionRows: readonly IssueProjection[]
  legacyRows: readonly IssueWire[]
  index: Map<string, IssueViewModel>
  all: IssueViewModel[]
}

interface IssueViewsStore {
  /** Cleared on every relevant replica notification. */
  snapshot: CachedIssueViewsSnapshot | null
  /** Retained across snapshots so unchanged issue models keep their identity. */
  models: IssueModelsProjection | null
  modelBuilds: number
  listeners: Set<() => void>
}

const stores = new WeakMap<Replica, IssueViewsStore>()

function storeFor(replica: Replica): IssueViewsStore {
  const existing = stores.get(replica)
  if (existing) return existing
  const store: IssueViewsStore = { snapshot: null, models: null, modelBuilds: 0, listeners: new Set() }
  stores.set(replica, store)

  const invalidate = (): void => {
    store.snapshot = null
    for (const listener of [...store.listeners]) listener()
  }
  // The view joins all of these kinds. Prefer the kernel's one batch seam so a
  // multi-kind delta wakes the projection once; older replicas fall back to
  // their already-coalesced per-kind subscriptions.
  const relevantKinds = new Set(['issues', 'issueProjections', 'issueDeps', 'repos', 'sessions'])
  if (replica.subscribeRowBatch) {
    replica.subscribeRowBatch((changed) => {
      for (const kind of changed) {
        if (relevantKinds.has(kind)) {
          invalidate()
          break
        }
      }
    })
  } else {
    replica.subscribeRows('issues', invalidate)
    replica.subscribeRows('issueProjections', invalidate)
    replica.subscribeRows('issueDeps', invalidate)
    replica.subscribeRows('repos', invalidate)
    replica.subscribeRows('sessions', invalidate)
  }
  return store
}

function deriveSnapshot(replica: Replica): CachedIssueViewsSnapshot {
  const snapshot = deriveIssueViewsSnapshot(replica)
  return {
    ...snapshot,
    projectionRows: replica.rows('issueProjections'),
    legacyRows: replica.rows('issues'),
  }
}

function snapshotFor(replica: Replica): CachedIssueViewsSnapshot {
  const store = storeFor(replica)
  store.snapshot ??= deriveSnapshot(replica)
  return store.snapshot
}

function subscribeToIssueViews(replica: Replica, onChange: () => void): () => void {
  const store = storeFor(replica)
  store.listeners.add(onChange)
  return () => store.listeners.delete(onChange)
}

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

/** JSON-like comparison used to retain unchanged model objects across a world rebuild. */
function sameVisibleValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => sameVisibleValue(value, b[index]))
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  const bRecord = b as Record<string, unknown>
  return aKeys.every(
    (key) =>
      Object.hasOwn(bRecord, key) &&
      sameVisibleValue((a as Record<string, unknown>)[key], bRecord[key]),
  )
}

function sameIndex(
  previous: Map<string, IssueViewModel>,
  next: Map<string, IssueViewModel>,
): boolean {
  if (previous.size !== next.size) return false
  const previousEntries = previous.entries()
  for (const [nextId, nextModel] of next) {
    const previousEntry = previousEntries.next()
    if (previousEntry.done) return false
    const [previousId, previousModel] = previousEntry.value
    if (previousId !== nextId || previousModel !== nextModel) return false
  }
  return true
}

function modelsFor(
  replica: Replica,
  suppliedProjectionRows?: readonly IssueProjection[],
  suppliedLegacyRows?: readonly IssueWire[],
): IssueModelsProjection {
  const store = storeFor(replica)
  const snapshot = snapshotFor(replica)
  const projectionRows = suppliedProjectionRows ?? snapshot.projectionRows
  const legacyRows = suppliedLegacyRows ?? snapshot.legacyRows
  const current = store.models
  if (
    current?.snapshot === snapshot &&
    current.projectionRows === projectionRows &&
    current.legacyRows === legacyRows
  ) {
    return current
  }

  store.modelBuilds++
  const built = buildIssueViewModels(snapshot, projectionRows, legacyRows)
  const models = new Map<string, IssueViewModel>()
  for (const [id, next] of built) {
    const previous = current?.index.get(id)
    models.set(id, previous && sameVisibleValue(previous, next) ? previous : next)
  }

  const unchanged = current !== null && sameIndex(current.index, models)
  const projection: IssueModelsProjection = {
    snapshot,
    projectionRows,
    legacyRows,
    index: unchanged ? current.index : models,
    all: unchanged ? current.all : [...models.values()],
  }
  store.models = projection
  return projection
}

/** Imperative shared readers for stores that already own the notification boundary. */
export function issueViewModelIndex(
  replica: Replica,
  projectionRows?: readonly IssueProjection[],
  legacyRows?: readonly IssueWire[],
): Map<string, IssueViewModel> {
  return modelsFor(replica, projectionRows, legacyRows).index
}

export function allIssueViewModels(
  replica: Replica,
  projectionRows?: readonly IssueProjection[],
  legacyRows?: readonly IssueWire[],
): IssueViewModel[] {
  return modelsFor(replica, projectionRows, legacyRows).all
}

export function issueViewModelById(
  replica: Replica,
  issueId: string,
  projectionRows?: readonly IssueProjection[],
  legacyRows?: readonly IssueWire[],
): IssueViewModel | undefined {
  return modelsFor(replica, projectionRows, legacyRows).index.get(issueId)
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

/** Bounded diagnostic used by the real-store performance harness. */
export function issueViewModelProjectionStats(replica: Replica): { builds: number } {
  return { builds: storeFor(replica).modelBuilds }
}
