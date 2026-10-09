import { omitGone } from './lookup'
import { worklistView } from './worklist/view-model'
import { sessionPaneView } from './session-pane-view'
import { shellViews } from './shell-views'
import { attachPreferenceSource } from './preference-source'
import type { SessionPhaseChange } from '@podium/client-core/sound'
import { attachSettingsSource } from './settings-source'
import { optimisticDraftSortKey } from '@podium/client-core/values'
import type { IssueViewModel } from '@podium/client-core/replica'
import { asUserId } from '@podium/model'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { Reaction, runInAction } from 'mobx'
import { _observerFinalizationRegistry } from 'mobx-react-lite'
import { createWorklistPool, type WorklistPoolHandle } from './create'
import { attachHeaderSource } from './header-source'
import type { MobxPool } from './pool'
import type { SettingsOwner } from './settings-source'
import { createEngineLocals, type LocalsEngine } from './shared/engine-locals'
import {
  createRowSource,
  type RowSourceReplica,
  type RowSourceRuntime,
} from './shared/row-source'
import type { PoolSummaryFields } from './source-registry'
import {
  createPoolTransactions,
  type PoolTransactions,
  type PoolTransactionsPorts,
} from './write/transactions'

/** Readers return identities owned by their memoized row/band projections.
 * Small scalar tuples may opt into an explicit equality function. */
export const samePoolProjection = Object.is

/** React's scalar/layout readers share MobX tracking without eagerly loading
 * the graph before pool startup. Rows use observer directly; this seam is for the
 * palette and project controls, which need only a small section projection.
 * Optional diagnostics let the structural harness observe this real boundary;
 * the app uses reference equality by default. */
export function createPoolProjection<T>(
  pool: MobxPool,
  read: (pool: MobxPool) => T,
  options: {
    name?: string
    equals?: (before: T, next: T) => boolean
    /** Visited folds retain lazy dependencies, without reading hidden changes. */
    retainWhileInactive?: boolean
  } = {},
) {
  const state = projectionState(pool, read, options)
  const view = {
    /** Hidden owners retain their last paint. A visited fold can also retain
     * its lazy graph: invalidation only marks it dirty until it is revealed. */
    setActive(active: boolean): void {
      if (state.active === active) return
      state.active = active
      state.dirty = true
      if (!active && !state.retainWhileInactive) {
        state.reaction?.dispose()
        state.reaction = null
        _observerFinalizationRegistry.unregister(state)
      }
    },
    getSnapshot(nextRead = state.read): T {
      if (state.read !== nextRead) {
        state.read = nextRead
        state.dirty = true
      }
      if (!state.active) {
        if (state.snapshot === null)
          throw new Error('An inactive projection has no painted snapshot')
        return state.snapshot.value
      }
      if (observeProjection(state) && !state.listeners.size) {
        // React can abandon a render before subscribing. Use the same cleanup
        // as observer components, including its fallback on engines without GC hooks.
        _observerFinalizationRegistry.register(view, state, state)
      }
      refreshProjection(state)
      if (state.error !== null) throw state.error.cause
      return state.snapshot!.value
    },
    subscribe(wake: () => void): () => void {
      const before = state.snapshot,
        error = state.error,
        version = state.version
      if (state.active) observeProjection(state)
      // Lazy reader construction can publish observable initialization during
      // tracking. Settle those real changes before attaching an imperative watch.
      while (state.active && state.dirty) refreshProjection(state)
      _observerFinalizationRegistry.unregister(state)
      const listener = () => wake()
      state.listeners.add(listener)
      // Imperative readers paint before subscribing. A lazy source can finish
      // initialization during that read; publish its newer snapshot at attachment.
      if (
        (before !== null || error !== null || state.version !== version) &&
        (state.snapshot !== before || state.error !== error)
      )
        wake()
      return () => {
        state.listeners.delete(listener)
        releaseProjection(state)
        if (state.reaction !== null && !state.listeners.size)
          _observerFinalizationRegistry.register(view, state, state)
      }
    },
    /** The hook's owner releases retained dependencies when it unmounts. */
    dispose(): void {
      state.reaction?.dispose()
      state.reaction = null
      state.dirty = true
      _observerFinalizationRegistry.unregister(state)
    },
  }
  return view
}

interface ProjectionState<T> {
  readonly pool: MobxPool
  readonly name: string
  readonly equals: (before: T, next: T) => boolean
  readonly retainWhileInactive: boolean
  read: (pool: MobxPool) => T
  snapshot: { value: T } | null
  error: { cause: unknown } | null
  dirty: boolean
  active: boolean
  version: number
  reaction: Reaction | null
  readonly listeners: Set<() => void>
}

/** MobX checks computed staleness before calling a Reaction's invalidator.
 * A hidden retained fold must pause before that check, otherwise marking the
 * snapshot dirty would already have recomputed its entire row graph. */
class ProjectionReaction<T> extends Reaction {
  constructor(private readonly state: ProjectionState<T>, invalidate: () => void) {
    super(state.name, invalidate)
  }

  override runReaction_(): void {
    if (!this.state.active && this.state.retainWhileInactive) {
      this.isScheduled = false
      this.state.dirty = true
      this.state.version++
      return
    }
    super.runReaction_()
  }
}

// These helpers stay outside createPoolProjection: reaction closures must not
// share a context with the view, or they would retain the finalization target.
function projectionState<T>(
  pool: MobxPool,
  read: (pool: MobxPool) => T,
  options: {
    name?: string
    equals?: (before: T, next: T) => boolean
    retainWhileInactive?: boolean
  },
): ProjectionState<T> {
  return {
    pool,
    name: options.name ?? 'pool projection',
    equals: options.equals ?? samePoolProjection,
    retainWhileInactive: options.retainWhileInactive ?? false,
    read,
    snapshot: null,
    error: null,
    dirty: true,
    active: true,
    version: 0,
    reaction: null,
    listeners: new Set(),
  }
}

function observeProjection<T>(state: ProjectionState<T>): boolean {
  if (state.reaction !== null) return false
  state.dirty = true
  state.reaction = new ProjectionReaction(state, () => {
    state.dirty = true
    state.version++
    // Filter before notifying React or imperative consumers: equal projections
    // must not trigger owner renders, even when an observed input changes.
    if (state.active && state.listeners.size) {
      const before = state.snapshot,
        error = state.error
      refreshProjection(state)
      if (state.snapshot !== before || state.error !== error)
        for (const listener of [...state.listeners]) listener()
    }
  })
  return true
}

function refreshProjection<T>(state: ProjectionState<T>): void {
  if (!state.dirty) return
  state.dirty = false
  state.error = null
  let next!: T
  state.reaction!.track(() => {
    try {
      next = state.read(state.pool)
    } catch (cause) {
      state.error = { cause }
    }
  })
  if (
    state.error === null &&
    (state.snapshot === null || !state.equals(state.snapshot.value, next))
  )
    state.snapshot = { value: next }
}

function releaseProjection<T>(state: ProjectionState<T>): void {
  if (state.listeners.size) return
  if (!state.active && state.retainWhileInactive) return
  state.reaction?.dispose()
  state.reaction = null
}

/** Structural seam satisfied by the app's StoreProvider runtime. */
export type WorklistRuntime = RowSourceRuntime &
  LocalsEngine & {
    readonly replica: RowSourceReplica
    readonly ui?: RoutedUiState
    attachWorklistSelection?(selection: { readonly selectedId: string | null; select(id: string | null): void }): () => void
    attachSessionPhases?(read: () => readonly SessionPhaseChange[]): () => void
  }

const spawnPools = new WeakMap<object, MobxPool>()

/** What the transaction log needs from the runtime beyond the row feed. */
type TransactionsRuntime = WorklistRuntime & {
  readonly principal: { userId: string }
  readonly subscribeOutboxOutcomes: PoolTransactionsPorts['outcomes']
  readonly outbox: PoolTransactionsPorts['outbox'] & { enqueue: import('@podium/client-core/engine').EngineOutbox['enqueue']; retireAwaiting(id: import('@podium/model').MutationId): void }
  /** Routes the runtime's queued actions through the log (POD-5432). */
  readonly attachPoolWriter: (writer: PoolTransactions) => () => void
}

/** The transaction log over the app's runtime; fixtures reuse this wiring. */
export function createRuntimeTransactions(runtime: WorklistRuntime): PoolTransactions {
  const rt = runtime as Partial<TransactionsRuntime>
  const subscribeAddressed = runtime.replica.subscribeAddressedBatch?.bind(runtime.replica)
  if (!rt.principal || !rt.outbox || !rt.subscribeOutboxOutcomes ||
    !rt.attachPoolWriter || !subscribeAddressed) {
    throw new Error('Pool transactions require the runtime principal, outbox, outcome and addressed writer seams')
  }
  return createPoolTransactions({
    userId: rt.principal.userId,
    outbox: rt.outbox,
    outcomes: rt.subscribeOutboxOutcomes,
    enqueue: async (kind, input, opts) => { await rt.outbox!.enqueue(kind, input, opts) },
    retire: id => rt.outbox!.retireAwaiting(id),
    addressed: subscribeAddressed,
    spawn: {
      api: (runtime as unknown as { access: { trpc: import('@podium/client-core').PodiumClientApi } }).access.trpc,
      userId: asUserId(rt.principal.userId),
      notices: (runtime as unknown as { spawnNotices: import('@podium/client-core/engine').StoreNotices }).spawnNotices,
      graceMs: (runtime as unknown as { spawnGraceMs?: number }).spawnGraceMs,
      sortKey: target => runInAction(() => {
        const pool = spawnPools.get(runtime)
        if (!pool) throw new Error('Pool spawn placement is not attached')
        const issues = pool.queries.indexed({ kind: 'spawnIssues', repoPath: target.repoPath, ...(target.repoId ? { repoId: target.repoId } : {}) })
          // untracked-read: spawn-sort-peek
          .map(id => omitGone(pool.row('issue', id, 'peek'))).filter(row => row && typeof row !== 'symbol')
        return optimisticDraftSortKey(issues as unknown as IssueViewModel[], target.repoPath, target.repoId)
      }),
    },
  })
}

/** Route the runtime's queued actions through the log; returns the detach. */
export function attachRuntimeWriter(
  runtime: WorklistRuntime,
  transactions: PoolTransactions,
): () => void {
  return (runtime as TransactionsRuntime).attachPoolWriter(transactions)
}

/** The principal's pool owns all client optimism and routes queued runtime
 * actions through its transaction log. The outbox is the single durable queue. */
export function createRuntimeWorklistPool(
  runtime: WorklistRuntime,
  options: {
    sessionPane?: boolean
    shell?: boolean
    preferences?: boolean
    settings?: boolean
    header?: boolean
    summaries?: PoolSummaryFields
  } = {},
): WorklistPoolHandle & { readonly transactions: PoolTransactions } {
  const transactions = createRuntimeTransactions(runtime)
  let rows: ReturnType<typeof createRowSource>
  try {
    rows = createRowSource(runtime, runtime.replica,
      { pending: transactions.pending })
  } catch (error) {
    transactions.dispose()
    throw error
  }
  let stopWriter: (() => void) | undefined
  let locals: ReturnType<typeof createEngineLocals> | undefined
  let handle: WorklistPoolHandle | undefined
  let stopSelection: (() => void) | undefined
  let stopHeader: (() => void) | undefined
  let stopSounds: (() => void) | undefined
  try {
    locals = createEngineLocals(runtime)
    handle = createWorklistPool(
      {
        ...rows.source,
        // The pool's display reader follows first-in-replica order. The
        // replica's unique-only resolver keeps its existing ambiguity rule.
        ...(rows.source.issueIdsByRef
          ? { issueIdByRef: (ref: string) => rows.source.issueIdsByRef!(ref)[0] }
          : {}),
        subscribe: (listener) => rows.source.subscribe(listener),
      },
      locals.source,
      // POD-5423: the worklist's lanes are filed only while a screen that
      // draws them holds them (its pool screen's attachment) or reads them.
      {
        header: options.header,
        settings: options.settings,
        summaries: options.summaries,
        worklist: 'demand',
      },
      runtime.attachWorklistSelection ? 'worklist' : 'locals',
    )
    stopSelection = runtime.attachWorklistSelection?.(worklistView(handle.pool))
    // This module loads behind the host's graph import. Register the screen
    // companions before it publishes the pool; eager hooks acquire only types.
    if (options.sessionPane) sessionPaneView(handle.pool)
    if (options.shell) shellViews(handle.pool)
    if (options.preferences || options.settings) {
      if (!runtime.ui) throw new Error('Preferences require the existing runtime UI owner')
      attachPreferenceSource(handle.pool, runtime.ui)
    }
    if (options.settings) {
      const owner = runtime as unknown as Partial<SettingsOwner> & Pick<SettingsOwner, 'readLocal'>
      if (
        typeof owner.onList !== 'function' ||
        !Array.isArray(owner.readLocal('machines')) ||
        owner.readLocal('settingsTab') === undefined
      ) {
        throw new Error('Settings require the existing runtime catalog and window owner')
      }
      // The shared row-source seam exposes only its repo inputs. The provider
      // runtime also owns the catalog/window fields checked above.
      attachSettingsSource(handle.pool, runtime as WorklistRuntime & SettingsOwner)
    }
    if (options.header)
      stopHeader = attachHeaderSource(
        handle.pool,
        runtime as Parameters<typeof attachHeaderSource>[1],
      )
    spawnPools.set(runtime, handle.pool)
    const phasePool = handle.pool
    stopSounds = runtime.attachSessionPhases?.(() => phasePool.sessionPhaseChanges.get())
    transactions.bind(rows)
    handle.pool.attachTransactions(transactions, true)
    stopWriter = attachRuntimeWriter(runtime, transactions)
  } catch (error) {
    stopSelection?.()
    stopSounds?.()
    stopWriter?.()
    stopHeader?.()
    handle?.dispose()
    locals?.dispose()
    transactions.dispose()
    rows.dispose()
    throw error
  }
  const attached = handle
  let disposed = false
  return {
    pool: attached.pool,
    transactions,
    dispose(): void {
      if (disposed) return
      disposed = true
      // First: no action may reach a log that is going away.
      stopWriter?.()
      stopSelection?.()
      stopSounds?.()
      spawnPools.delete(runtime)
      stopHeader?.()
      try {
        attached.dispose()
      } finally {
        transactions.dispose()
        locals?.dispose()
        rows.dispose()
      }
    },
  }
}
