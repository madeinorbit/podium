import type { SettingsOwner } from './settings-source'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { attachHeaderSource } from './header-source'
import { compareStructural, Reaction } from 'mobx'
import { _observerFinalizationRegistry } from 'mobx-react-lite'
import { createWorklistPool, type WorklistPoolHandle } from './create'
import type { MobxPool } from './pool'
import { createEngineLocals, type LocalsEngine } from './shared/engine-locals'
import {
  createRowSource,
  type PoolOwnedKind,
  type RowSourceReplica,
  type RowSourceRuntime,
} from './shared/row-source'
import { createPoolTransactions, type PoolTransactions, type PoolTransactionsPorts } from './write/transactions'
import { measureWorklistPoolDelivery, observeWorklistPoolPerf } from './sidebar-perf'
import type { PoolSummaryFields } from './source-registry'

/** React's scalar/layout readers share MobX tracking without eagerly loading
 * the graph in legacy mode. Rows use observer directly; this seam is for the
 * palette and project controls, which need only a small section projection.
 * Optional diagnostics let the structural harness observe this real boundary;
 * the app keeps the existing reaction name and MobX equality by default. */
export function createPoolProjection<T>(pool: MobxPool, read: (pool: MobxPool) => T,
  options: { name?: string; equals?: (before: T, next: T) => boolean } = {}) {
  const state = projectionState(pool, read, options)
  const view = {
    /** Hidden owners retain their last paint but release every dependency.
     * The owner pulls one current snapshot when it becomes visible again. */
    setActive(active: boolean): void {
      if (state.active === active) return
      state.active = active
      state.dirty = true
      if (!active) {
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
        if (state.snapshot === null) throw new Error('An inactive projection has no painted snapshot')
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
      const before = state.snapshot, error = state.error, version = state.version
      if (state.active) observeProjection(state)
      // Lazy reader construction can publish observable initialization during
      // tracking. Settle those real changes before attaching an imperative watch.
      while (state.active && state.dirty) refreshProjection(state)
      _observerFinalizationRegistry.unregister(state)
      const listener = () => wake()
      state.listeners.add(listener)
      // Imperative readers paint before subscribing. A lazy source can finish
      // initialization during that read; publish its newer snapshot at attachment.
      if ((before !== null || error !== null || state.version !== version) && (state.snapshot !== before || state.error !== error))
        wake()
      return () => {
        state.listeners.delete(listener)
        releaseProjection(state)
      }
    },
  }
  return view
}

interface ProjectionState<T> {
  readonly pool: MobxPool
  readonly name: string
  readonly equals: (before: T, next: T) => boolean
  read: (pool: MobxPool) => T
  snapshot: { value: T } | null
  error: { cause: unknown } | null
  dirty: boolean
  active: boolean
  version: number
  reaction: Reaction | null
  readonly listeners: Set<() => void>
}

// These helpers stay outside createPoolProjection: reaction closures must not
// share a context with the view, or they would retain the finalization target.
function projectionState<T>(pool: MobxPool, read: (pool: MobxPool) => T,
  options: { name?: string; equals?: (before: T, next: T) => boolean }): ProjectionState<T> {
  return {
    pool,
    name: options.name ?? 'pool projection',
    equals: options.equals ?? compareStructural,
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
  state.reaction = new Reaction(state.name, () => {
    state.dirty = true
    state.version++
    // Filter before notifying React or imperative consumers: equal projections
    // must not trigger owner renders, even when an observed input changes.
    if (state.listeners.size) {
      const before = state.snapshot, error = state.error
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
  if (state.error === null && (state.snapshot === null || !state.equals(state.snapshot.value, next)))
    state.snapshot = { value: next }
}

function releaseProjection<T>(state: ProjectionState<T>): void {
  if (state.listeners.size) return
  state.reaction?.dispose()
  state.reaction = null
}

/** Structural seam satisfied by the app's StoreProvider runtime. */
export type WorklistRuntime = RowSourceRuntime &
  LocalsEngine & { readonly replica: RowSourceReplica; readonly ui?: RoutedUiState }

/** What the transaction log needs from the runtime beyond the row feed. */
type TransactionsRuntime = WorklistRuntime & {
  readonly principal: { userId: string }
  readonly outbox: PoolTransactionsPorts['outbox']
  readonly subscribeOutboxOutcomes: PoolTransactionsPorts['outcomes']
  readonly enqueueOverlayed: PoolTransactionsPorts['enqueue']
  readonly spawnPlaceholders: NonNullable<PoolTransactionsPorts['spawns']>['current']
  readonly subscribeSpawnPlaceholders: NonNullable<PoolTransactionsPorts['spawns']>['subscribe']
  /** Routes the runtime's queued actions through the log (POD-5432). */
  readonly attachPoolWriter: (writer: Pick<PoolTransactions, 'write'>) => () => void
}

/** The transaction log over the app's runtime, as `owns` builds it (harnesses
 * reuse this exact wiring). */
export function createRuntimeTransactions(runtime: WorklistRuntime): PoolTransactions {
  const rt = runtime as Partial<TransactionsRuntime>
  const subscribeAddressed = runtime.replica.subscribeAddressedBatch?.bind(runtime.replica)
  if (!rt.principal || !rt.outbox || !rt.subscribeOutboxOutcomes || !rt.enqueueOverlayed ||
    !rt.spawnPlaceholders || !rt.subscribeSpawnPlaceholders || !rt.attachPoolWriter || !subscribeAddressed) {
    throw new Error('Pool transactions require the runtime outbox, outcome, enqueue, spawn and writer seams')
  }
  return createPoolTransactions({
    userId: rt.principal.userId,
    outbox: rt.outbox,
    outcomes: rt.subscribeOutboxOutcomes,
    enqueue: rt.enqueueOverlayed,
    addressed: subscribeAddressed,
    spawns: { current: rt.spawnPlaceholders, subscribe: rt.subscribeSpawnPlaceholders },
  })
}

/** Route the runtime's queued actions through the log; returns the detach. */
export function attachRuntimeWriter(runtime: WorklistRuntime, transactions: PoolTransactions): () => void {
  return (runtime as TransactionsRuntime).attachPoolWriter(transactions)
}

/**
 * The pool over the app's runtime. Without `owns` a read-only attachment:
 * optimism and every write still belong to the runtime's ledger (`overlaid`
 * feed). With `owns` (POD-5432; the pool host's default) the pool owns the
 * optimism of those row kinds: its transaction log (POD-5431) paints them
 * (`pooled` feed), the ledger paints the rest, and every queued action of the
 * runtime routes through the log (`attachPoolWriter`), as `pool.mutate` and
 * the model setters do. The ledger keeps painting legacy screens from the
 * same outbox records.
 */
export function createRuntimeWorklistPool(runtime: WorklistRuntime, options: { preferences?: boolean; settings?: boolean; header?: boolean; summaries?: PoolSummaryFields; owns?: readonly PoolOwnedKind[] } = {}): WorklistPoolHandle & { readonly transactions?: PoolTransactions } {
  const owned = new Set(options.owns ?? [])
  const transactions = owned.size > 0 ? createRuntimeTransactions(runtime) : null
  let rows: ReturnType<typeof createRowSource>
  try {
    rows = createRowSource(runtime, runtime.replica,
      transactions === null ? { mode: 'overlaid' } : { mode: 'pooled', pending: transactions.pending, owned })
  } catch (error) {
    transactions?.dispose()
    throw error
  }
  let stopWriter: (() => void) | undefined
  let locals: ReturnType<typeof createEngineLocals> | undefined
  let handle: WorklistPoolHandle | undefined
  let stopHeader: (() => void) | undefined
  let stopPerf: (() => void) | undefined
  try {
    locals = createEngineLocals(runtime)
    handle = createWorklistPool(
      {
        ...rows.source,
        // The pool's display reader follows first-in-replica order. The
        // replica's unique-only resolver keeps its existing ambiguity rule.
        ...(rows.source.issueIdsByRef ? { issueIdByRef: (ref: string) => rows.source.issueIdsByRef!(ref)[0] } : {}),
        subscribe: (listener) =>
          rows.source.subscribe((event) => {
            measureWorklistPoolDelivery(runtime, () => listener(event))
          }),
      },
      locals.source,
      // POD-5423: the worklist's lanes are filed only while a screen that
      // draws them holds them (its pool screen's attachment) or reads them.
      { header: options.header, settings: options.settings, summaries: options.summaries, worklist: 'demand' },
    )
    if (options.preferences || options.settings) {
      if (!runtime.ui) throw new Error('Preferences require the existing runtime UI owner')
      handle.pool.attachPreferences(runtime.ui)
    }
    if (options.settings) {
      const owner = runtime as unknown as Partial<SettingsOwner> & Pick<SettingsOwner, 'readLocal'>
      if (typeof owner.onList !== 'function' || !Array.isArray(owner.readLocal('machines')) || owner.readLocal('settingsTab') === undefined) {
        throw new Error('Settings require the existing runtime catalog and window owner')
      }
      // The shared row-source seam exposes only its repo inputs. The provider
      // runtime also owns the catalog/window fields checked above.
      handle.pool.attachSettings(runtime as WorklistRuntime & SettingsOwner)
    }
    if (options.header) stopHeader = attachHeaderSource(handle.pool, runtime as Parameters<typeof attachHeaderSource>[1])
    stopPerf = observeWorklistPoolPerf(runtime, handle.pool)
    if (transactions !== null) {
      transactions.bind(rows)
      handle.pool.attachTransactions(transactions, owned.has('session'))
      stopWriter = attachRuntimeWriter(runtime, transactions)
    }
  } catch (error) {
    stopWriter?.()
    stopHeader?.()
    handle?.dispose()
    locals?.dispose()
    transactions?.dispose()
    rows.dispose()
    throw error
  }
  const attached = handle
  let disposed = false
  return {
    pool: attached.pool,
    ...(transactions === null ? {} : { transactions }),
    dispose(): void {
      if (disposed) return
      disposed = true
      // First: no action may reach a log that is going away.
      stopWriter?.()
      stopHeader?.()
      stopPerf?.()
      try {
        attached.dispose()
      } finally {
        transactions?.dispose()
        locals?.dispose()
        rows.dispose()
      }
    },
  }
}
