import type { LiveStore } from '@podium/client-core/live'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionPhaseChange } from '@podium/client-core/sound'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { asUserId, layoutRowId } from '@podium/model'
import { type IObservableValue, observable, Reaction, runInAction, untracked } from 'mobx'
import { _observerFinalizationRegistry } from 'mobx-react-lite'
import { DeadlineClock } from './clock'
import { createWorklistPool, type WorklistPoolHandle } from './create'
import { attachHeaderSource } from './header-source'
import { omitGone } from './lookup'
import type { MobxPool } from './pool'
import { attachPreferenceSource } from './preference-source'
import { sessionPaneView } from './session-pane-view'
import type { SettingsOwner } from './settings-source'
import { attachSettingsSource } from './settings-source'
import { createEngineLocals, type LocalsEngine } from './shared/engine-locals'
import { createRowSource, type RowSourceReplica, type RowSourceRuntime } from './shared/row-source'
import { shellViews } from './shell-views'
import type { PoolSummaryFields } from './source-registry'
import { draftSortKey } from './write/launch-rows'
import { startEffects } from './write/start-effects'
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
  constructor(
    private readonly state: ProjectionState<T>,
    invalidate: () => void,
  ) {
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
    /** Historical corpus harness only; production supplies no manual clock. */
    fixtureClock?: { now(): number; subscribe(tick: (now: number) => void): () => void }
    readonly replica: RowSourceReplica
    readonly deviceState?: RoutedUiState
    readonly replicatedLayout?: import('@podium/client-core/ui').LayoutAccess
    /** This user's LiveStore (POD-5798); machine models read their live fields from it. */
    readonly live?: LiveStore
    attachSessionPhases?(read: () => readonly SessionPhaseChange[]): () => void
  }

/**
 * The pool each runtime's log paints into, once attached: observable, so the
 * log's launch read (a tracked read of the pool's effects) follows the
 * attachment. Spawn placement and the fresh-record guess read it too.
 */
const attachedPools = new WeakMap<object, IObservableValue<MobxPool | undefined>>()

function attachedPool(runtime: object): IObservableValue<MobxPool | undefined> {
  let pool = attachedPools.get(runtime)
  if (pool === undefined) {
    pool = observable.box<MobxPool | undefined>(undefined, { deep: false })
    attachedPools.set(runtime, pool)
  }
  return pool
}

/** Let go of `pool` as the runtime's attached pool, unless another took its place. */
function detachPool(runtime: object, pool: MobxPool | undefined): void {
  const attached = attachedPool(runtime)
  if (pool !== undefined && attached.get() === pool) runInAction(() => attached.set(undefined))
}

/** What the transaction log needs from the runtime beyond the row feed. */
type TransactionsRuntime = WorklistRuntime & {
  readonly principal: { userId: string }
  readonly subscribeOutboxOutcomes: PoolTransactionsPorts['outcomes']
  readonly outbox: PoolTransactionsPorts['outbox'] & {
    enqueue: import('@podium/client-core/engine').EngineOutbox['enqueue']
  }
  /** Routes the runtime's queued actions through the log (POD-5432). */
  readonly attachPoolWriter: (writer: PoolTransactions) => () => void
}

/** The transaction log over the app's runtime; fixtures reuse this wiring. */
export function createRuntimeTransactions(runtime: WorklistRuntime): PoolTransactions {
  const rt = runtime as Partial<TransactionsRuntime>
  const subscribeAddressed = runtime.replica.subscribeAddressedBatch?.bind(runtime.replica)
  if (
    !rt.principal ||
    !rt.outbox ||
    !rt.subscribeOutboxOutcomes ||
    !rt.attachPoolWriter ||
    !subscribeAddressed
  ) {
    throw new Error(
      'Pool transactions require the runtime principal, outbox, outcome and addressed writer seams',
    )
  }
  const transactions = createPoolTransactions({
    // THE STARTS' LAUNCH RECORDS (POD-6408, POD-6410, POD-6411): the attached
    // pool's own effect models, a tracked read the log watches, so the paint
    // reconciles after the publication that moved a record and reads what the
    // pool shows. Unknown while no pool is attached.
    launchEffects: () => {
      const pool = attachedPool(runtime).get()
      return pool === undefined ? undefined : startEffects(pool)
    },
    userId: rt.principal.userId,
    outbox: rt.outbox,
    outcomes: rt.subscribeOutboxOutcomes,
    enqueue: async (kind, input, opts) => {
      await rt.outbox!.enqueue(kind, input, opts)
    },
    addressed: subscribeAddressed,
    // A new record's placement guess (POD-6400): the held repos whose field
    // matches (an issue's repo by its path). Repos only: a handful of rows, read
    // when a create is reduced, never observed. Any other table answers none.
    // untracked-read: fresh-record-placement
    known: (entity, field, value) =>
      untracked(() => {
        const repos = entity === 'repo' ? attachedPool(runtime).get()?.tables.repo : undefined
        if (!repos) return []
        const ids: string[] = []
        for (const [id, row] of repos)
          if ((row as Record<string, unknown>)[field] === value) ids.push(id)
        return ids
      }),
    spawn: {
      userId: asUserId(rt.principal.userId),
      notices: (
        runtime as unknown as { spawnNotices: import('@podium/client-core/engine').StoreNotices }
      ).spawnNotices,
      sortKey: (target) =>
        runInAction(() => {
          const pool = attachedPool(runtime).get()
          if (!pool) throw new Error('Pool spawn placement is not attached')
          const issues = pool.queries
            .indexed({
              kind: 'spawnIssues',
              repoPath: target.repoPath,
              ...(target.repoId ? { repoId: target.repoId } : {}),
            })
            // untracked-read: spawn-sort-peek
            .map((id) => omitGone(pool.row('issue', id, 'peek')))
            .filter((row) => row && typeof row !== 'symbol')
          return draftSortKey(issues as unknown as IssueViewModel[], target.repoPath, target.repoId)
        }),
    },
  })
  return transactions
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
    rows = createRowSource(runtime, runtime.replica, { pending: transactions.pending })
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
        ...(runtime.fixtureClock ? { clock: new DeadlineClock(runtime.fixtureClock.now()) } : {}),
      },
      'worklist',
    )
    if (runtime.live) handle.pool.bindLive(runtime.live)
    const pool = handle.pool
    const principal = runtime.principal
    let stopLayout: () => void = () => {}
    if (runtime.replicatedLayout && principal) {
      const layout = runtime.replicatedLayout
      const readLayout = (key: string) => {
        const model = pool.model('userLayout', layoutRowId(asUserId(principal.userId), key))
        return model && typeof model !== 'symbol' && !('reason' in model) ? model.value : undefined
      }
      stopLayout = layout.attach(readLayout)
      pool.bindLayout({
        read: readLayout,
        ready: (key) =>
          typeof pool.model('userLayout', layoutRowId(asUserId(principal.userId), key)) !==
          'symbol',
        write: (key, value) => layout.set(key, value),
      })
    }
    const disposePool = handle.dispose.bind(handle)
    handle.dispose = () => {
      stopLayout()
      disposePool()
    }
    handle.pool.bindUi(runtime.ui)
    // This module loads behind the host's graph import. Register the screen
    // companions before it publishes the pool; eager hooks acquire only types.
    if (options.sessionPane) sessionPaneView(handle.pool)
    if (options.shell) shellViews(handle.pool)
    if (options.preferences || options.settings) {
      if (!runtime.deviceState) throw new Error('Preferences require the existing runtime UI owner')
      attachPreferenceSource(handle.pool, runtime.deviceState)
    }
    if (options.settings) {
      const owner = runtime as unknown as Partial<SettingsOwner> & Pick<SettingsOwner, 'readLocal'>
      if (
        typeof owner.onList !== 'function' ||
        !Array.isArray(owner.readLocal('machines')) ||
        owner.ui === undefined
      ) {
        throw new Error('Settings require the existing runtime catalog and window owner')
      }
      // The shared row-source seam exposes only its repo inputs. The provider
      // runtime also owns the catalog/window fields checked above.
      attachSettingsSource(handle.pool, runtime as WorklistRuntime & SettingsOwner, !options.header)
    }
    if (options.header)
      stopHeader = attachHeaderSource(
        handle.pool,
        runtime as Parameters<typeof attachHeaderSource>[1],
      )
    const phasePool = handle.pool
    stopSounds = runtime.attachSessionPhases?.(() => phasePool.sessionPhaseChanges.get())
    if (runtime.fixtureClock) {
      const stopClock = runtime.fixtureClock.subscribe((value) => handle!.pool.clock.advance(value))
      const previousStop = stopSounds
      stopSounds = () => {
        stopClock()
        previousStop?.()
      }
    }
    // One action: the bind paints the starts queued before a reload, which
    // place their task by this pool, and the log's launch watch first reads
    // this pool's effects with the feed bound to judge them by.
    const placed = handle.pool
    runInAction(() => {
      attachedPool(runtime).set(placed)
      transactions.bind(rows)
    })
    handle.pool.attachTransactions(transactions, true)
    stopWriter = attachRuntimeWriter(runtime, transactions)
  } catch (error) {
    stopSelection?.()
    stopSounds?.()
    stopWriter?.()
    stopHeader?.()
    detachPool(runtime, handle?.pool)
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
      stopHeader?.()
      // Let go of the pool before it empties its tables: the log's launch
      // watch then has nothing to judge, rather than every start gone.
      detachPool(runtime, attached.pool)
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
