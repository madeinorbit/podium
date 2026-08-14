/**
 * THE SHARED ISSUE VIEW-MODEL CACHE [ADR 4 D7.3] — one projection of the issue
 * world per replica notification, read by every surface and by the published
 * worklist slice.
 *
 * It lives here, and not in `use-issue-views.ts`, for one reason: the published
 * worklist (`viewmodels/slices/worklist/published.ts`) must read the SAME models
 * the React surfaces read, and it is platform-neutral — importing the hook
 * module would pull React into a slice mobile also derives. `use-issue-views.ts`
 * is now purely the React binding over this file.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REBUILD IS INCREMENTAL (POD-1053)
 * ---------------------------------------------------------------------------
 *
 * A one-field mutation on one issue does not change the replica at all — it is
 * an OVERLAY folded over server truth (`engine/overlay.ts`), and the fold hands
 * the store a new `issues` ARRAY whose rows are all the previous objects but
 * one. `modelsFor` used to key on that array identity alone, so a single tuck
 * rebuilt every issue view model in the project (1026 at the cardinalities
 * POD-1052 measured) and then deep-compared each one against the previous
 * generation to recover row identity. Measured ~9ms per press, paid at least
 * twice — once for the optimistic paint, once for the server echo.
 *
 * The dependency of ONE model is exactly three things, and `buildIssueViewModel`
 * takes precisely those: the snapshot (the replica-derived world), the row's
 * projection, and the row's retained legacy row. So when the snapshot is
 * unchanged, a row whose two input objects are identity-unchanged CANNOT have a
 * different model, and the previous one is reused without being rebuilt or
 * compared. The array that changed identity for one patched row costs one model.
 *
 * WHY THIS IS SAFE UNDER EVICT AND RESCOPE, which is the bar
 * `viewmodels/slices/publish.ts` sets for every cache in the client. The reuse
 * decision is keyed on OBJECT IDENTITY of inputs the CURRENT pass is holding,
 * and the pass iterates the CURRENT `projectionRows`. A row that left the
 * principal's slice is not in that iteration, so no amount of remembering can
 * put it back: this cache cannot hold a row past its visibility, only skip
 * rebuilding a row it was handed again unchanged. The per-id memory is discarded
 * and rewritten on every pass rather than accumulated.
 *
 * When the snapshot itself changes — any replica write, including the server
 * echo of our own mutation — every view object is new and every model must be
 * rebuilt. The `sameVisibleValue` deep compare then earns its keep by handing
 * back the PREVIOUS model object wherever nothing visible moved, which is what
 * lets the worklist slice skip its own derivation on the echo.
 */

import type { IssueProjection, IssueWire } from '@podium/model'
import {
  buildIssueViewModel,
  deriveIssueViewsSnapshot,
  type IssueViewModel,
  type IssueViewsSnapshot,
} from './issue-view-models'
import type { Replica } from './replica'

export type CachedIssueViewsSnapshot = IssueViewsSnapshot & {
  projectionRows: readonly IssueProjection[]
  legacyRows: readonly IssueWire[]
}

/** The two rows one model was built from — the whole reuse key (see the note). */
interface ModelInputs {
  projection: IssueProjection
  legacy: IssueWire | undefined
}

export interface IssueModelsProjection {
  snapshot: CachedIssueViewsSnapshot
  projectionRows: readonly IssueProjection[]
  legacyRows: readonly IssueWire[]
  index: Map<string, IssueViewModel>
  all: IssueViewModel[]
  /** Per-id build inputs, rewritten each pass. Never a row store — see the note
   *  on evict/rescope safety. */
  inputs: Map<string, ModelInputs>
}

interface IssueViewsStore {
  /** Cleared on every relevant replica notification. */
  snapshot: CachedIssueViewsSnapshot | null
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

export function snapshotFor(replica: Replica): CachedIssueViewsSnapshot {
  const store = storeFor(replica)
  store.snapshot ??= deriveSnapshot(replica)
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
  const legacyById = new Map(legacyRows.map((issue) => [issue.id, issue]))
  // Per-row reuse is available only while the replica-derived world stands
  // still: a new snapshot means new `IssueView` objects for every issue, so
  // every model genuinely differs and there is nothing to skip.
  const reusable = current?.snapshot === snapshot ? current : null
  const models = new Map<string, IssueViewModel>()
  const inputs = new Map<string, ModelInputs>()
  for (const projection of projectionRows) {
    const legacy = legacyById.get(projection.id)
    const prior = reusable?.inputs.get(projection.id)
    if (prior !== undefined && prior.projection === projection && prior.legacy === legacy) {
      const reused = reusable?.index.get(projection.id)
      if (reused !== undefined) {
        models.set(projection.id, reused)
        inputs.set(projection.id, prior)
        continue
      }
    }
    store.modelRowBuilds++
    const next = buildIssueViewModel(snapshot, projection, legacy)
    if (next === undefined) continue
    const previous = current?.index.get(projection.id)
    models.set(projection.id, previous && sameVisibleValue(previous, next) ? previous : next)
    inputs.set(projection.id, { projection, legacy })
  }

  const unchanged = current !== null && sameIndex(current.index, models)
  const projection: IssueModelsProjection = {
    snapshot,
    projectionRows,
    legacyRows,
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
