/** Incremental normalized issue models. Reuse is keyed by current projection,
 * user markers, git observation, repo row, derived view and member sessions.
 * Every pass visits only current projections, so evict and rescope cannot
 * resurrect a cached row. */
import type {
  IssueGitStateProjection,
  IssueProjection,
  IssueUserStateWire,
  RepoProjection,
} from '@podium/model'
import { recordIssueRowBuild } from '../perf/store-stats'
import {
  buildIssueViewModel,
  deriveIssueViewsSnapshot,
  type IssueViewModel,
  type IssueViewsSnapshot,
} from './issue-view-models'
import type { IssueView } from './issue-views'
import type { Replica } from './replica'

export type CachedIssueViewsSnapshot = IssueViewsSnapshot & {
  projectionRows: readonly IssueProjection[]
  userStateRows: readonly IssueUserStateWire[]
}

/** What one model was built from — the whole reuse key (see the note). The
 *  member sessions are not here: a retained `view` fixes the member id list, and
 *  the rows behind those ids are compared against the snapshot that built the
 *  model, which the projection already holds. */
interface ModelInputs {
  projection: IssueProjection
  userState: IssueUserStateWire | undefined
  gitState: IssueGitStateProjection | undefined
  repo: RepoProjection | undefined
  view: IssueView
  deps: IssueViewsSnapshot['issues'][number]['deps']
}

export interface IssueModelsProjection {
  sourceSnapshot: CachedIssueViewsSnapshot
  snapshot: CachedIssueViewsSnapshot
  projectionRows: readonly IssueProjection[]
  userStateRows: readonly IssueUserStateWire[]
  index: Map<string, IssueViewModel>
  all: IssueViewModel[]
  /** Per-id build inputs, rewritten each pass. Never a row store — see the note
   *  on evict/rescope safety. */
  inputs: Map<string, ModelInputs>
}

interface IssueViewsStore {
  /** Cleared on every relevant replica notification. */
  snapshot: CachedIssueViewsSnapshot | null
  /** The last snapshot derived, RETAINED across that invalidation — the next
   *  derivation hands it back so unchanged issues keep their view objects. Read
   *  only as a source of identities to re-offer, never as data (POD-1055). */
  lastSnapshot: CachedIssueViewsSnapshot | null
  /** Retained across snapshots so unchanged issue models keep their identity. */
  models: IssueModelsProjection | null
  modelBuilds: number
  modelRowBuilds: number
  listeners: Set<() => void>
}

const stores = new WeakMap<Replica, IssueViewsStore>()

function storeFor(replica: Replica): IssueViewsStore {
  const existing = stores.get(replica)
  if (existing) return existing
  const store: IssueViewsStore = {
    snapshot: null,
    lastSnapshot: null,
    models: null,
    modelBuilds: 0,
    modelRowBuilds: 0,
    listeners: new Set(),
  }
  stores.set(replica, store)

  const invalidate = (): void => {
    store.snapshot = null
    for (const listener of [...store.listeners]) listener()
  }
  // The view joins all of these kinds. Prefer the kernel's one batch seam so a
  // multi-kind delta wakes the projection once; older replicas fall back to
  // their already-coalesced per-kind subscriptions.
  const relevantKinds = new Set([
    'issueUserStates',
    'issueGitStates',
    'issueProjections',
    'issueDeps',
    'repos',
    'sessions',
  ])
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
    replica.subscribeRows('issueUserStates', invalidate)
    replica.subscribeRows('issueGitStates', invalidate)
    replica.subscribeRows('issueProjections', invalidate)
    replica.subscribeRows('issueDeps', invalidate)
    replica.subscribeRows('repos', invalidate)
    replica.subscribeRows('sessions', invalidate)
  }
  return store
}

/** Register invalidation before the runtime's store binding can publish to
 *  synchronous readers. This only subscribes; snapshots and models stay lazy. */
export function initializeIssueViewCache(replica: Replica): void {
  storeFor(replica)
}

function deriveSnapshot(
  replica: Replica,
  previous: CachedIssueViewsSnapshot | null,
): CachedIssueViewsSnapshot {
  const snapshot = deriveIssueViewsSnapshot(replica, previous ?? undefined)
  return {
    ...snapshot,
    projectionRows: replica.rows('issueProjections'),
    userStateRows: replica.rows('issueUserStates'),
  }
}

export function snapshotFor(replica: Replica): CachedIssueViewsSnapshot {
  const store = storeFor(replica)
  if (store.snapshot === null) {
    store.snapshot = deriveSnapshot(replica, store.lastSnapshot)
    store.lastSnapshot = store.snapshot
  }
  return store.snapshot
}

export function subscribeToIssueViews(replica: Replica, onChange: () => void): () => void {
  const store = storeFor(replica)
  store.listeners.add(onChange)
  return () => store.listeners.delete(onChange)
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

/**
 * The one model input a retained `IssueView` does NOT stand for.
 *
 * `deriveIssueRollups` reads each member session's `phase` and `lastActiveAt`
 * off the row, and those live outside the view — a view is stable while its
 * member ID LIST is, which says nothing about the sessions behind the ids. The
 * ids are the same list in both snapshots (the caller has already established
 * `prior.view === view`), so this walks that one list rather than the world.
 */
function sameMemberSessions(
  view: IssueView,
  previous: IssueViewsSnapshot,
  next: IssueViewsSnapshot,
): boolean {
  if (previous === next) return true
  for (const id of view.memberSessionIds) {
    if (previous.sessionById.get(id) !== next.sessionById.get(id)) return false
  }
  return true
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

export function modelsFor(
  replica: Replica,
  suppliedProjectionRows?: readonly IssueProjection[],
  suppliedUserStateRows?: readonly IssueUserStateWire[],
): IssueModelsProjection {
  const store = storeFor(replica)
  const sourceSnapshot = snapshotFor(replica)
  const projectionRows = suppliedProjectionRows ?? sourceSnapshot.projectionRows
  const userStateRows = suppliedUserStateRows ?? sourceSnapshot.userStateRows
  const current = store.models
  if (
    current?.sourceSnapshot === sourceSnapshot &&
    current.projectionRows === projectionRows &&
    current.userStateRows === userStateRows
  ) {
    return current
  }

  // Derive structural state from the optimistic projections too: a new draft
  // has no truth row yet, and a close/reparent must paint before its echo.
  const snapshot: CachedIssueViewsSnapshot =
    projectionRows === sourceSnapshot.projectionRows &&
    userStateRows === sourceSnapshot.userStateRows
      ? sourceSnapshot
      : {
          ...deriveIssueViewsSnapshot(
            replica, current?.snapshot, projectionRows, userStateRows,
            (id) => sourceSnapshot.issueInputById.get(id)?.stage,
          ),
          projectionRows,
          userStateRows,
        }
  store.modelBuilds++
  const userStateById = new Map(userStateRows.map((row) => [row.entityId, row]))
  const models = new Map<string, IssueViewModel>()
  const inputs = new Map<string, ModelInputs>()
  for (const projection of projectionRows) {
    const userState = userStateById.get(projection.id)
    const gitState = snapshot.gitStateByIssueId.get(projection.id)
    const repo = projection.repoId ? snapshot.repoById.get(projection.repoId) : undefined
    const view = snapshot.views.get(projection.id)
    const deps = snapshot.issueInputById.get(projection.id)?.deps ?? []
    const prior = current === null ? undefined : current.inputs.get(projection.id)
    if (
      current !== null &&
      prior !== undefined &&
      view !== undefined &&
      prior.projection === projection &&
      prior.userState === userState &&
      prior.gitState === gitState &&
      prior.repo === repo &&
      prior.view === view &&
      sameVisibleValue(prior.deps, deps) &&
      sameMemberSessions(view, current.snapshot, snapshot)
    ) {
      const reused = current.index.get(projection.id)
      if (reused !== undefined) {
        models.set(projection.id, reused)
        inputs.set(projection.id, prior)
        continue
      }
    }
    store.modelRowBuilds++
    recordIssueRowBuild(replica)
    if (view === undefined) continue
    const next = buildIssueViewModel(snapshot, projection, userState)
    if (next === undefined) continue
    const previous = current?.index.get(projection.id)
    models.set(projection.id, previous && sameVisibleValue(previous, next) ? previous : next)
    inputs.set(projection.id, { projection, userState, gitState, repo, view, deps })
  }

  const unchanged = current !== null && sameIndex(current.index, models)
  const projection: IssueModelsProjection = {
    sourceSnapshot,
    snapshot,
    projectionRows,
    userStateRows,
    index: unchanged ? current.index : models,
    all: unchanged ? current.all : [...models.values()],
    inputs,
  }
  store.models = projection
  return projection
}

/** Imperative shared readers for stores that already own the notification boundary. */
export function issueViewModelIndex(
  replica: Replica,
  projectionRows?: readonly IssueProjection[],
  userStateRows?: readonly IssueUserStateWire[],
): Map<string, IssueViewModel> {
  return modelsFor(replica, projectionRows, userStateRows).index
}

export function allIssueViewModels(
  replica: Replica,
  projectionRows?: readonly IssueProjection[],
  userStateRows?: readonly IssueUserStateWire[],
): IssueViewModel[] {
  return modelsFor(replica, projectionRows, userStateRows).all
}

export function issueViewModelById(
  replica: Replica,
  issueId: string,
  projectionRows?: readonly IssueProjection[],
  userStateRows?: readonly IssueUserStateWire[],
): IssueViewModel | undefined {
  return modelsFor(replica, projectionRows, userStateRows).index.get(issueId)
}

/**
 * Bounded diagnostic used by the real-store performance harness.
 *
 * `builds` counts PASSES through {@link modelsFor} that missed the memo;
 * `rowBuilds` counts individual models actually constructed. The second is the
 * POD-1053 regression gate: a one-row patch that moves `rowBuilds` by more than
 * one has put the O(project) fan-out back.
 */
export function issueViewModelProjectionStats(replica: Replica): {
  builds: number
  rowBuilds: number
} {
  const store = storeFor(replica)
  return { builds: store.modelBuilds, rowBuilds: store.modelRowBuilds }
}
