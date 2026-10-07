import { rowViewOf } from '../../../shared/src/row-snapshots'
import { worklistGroups } from '@podium/client-graph/worklist/groups'
/**
 * POD-4760 + POD-4944 + POD-4945 — the MobX pool's harness adapter: helpers
 * that exist only for the test harness, on top of the pool's public product
 * API.
 *
 * The product pool (`arms/mobx/pool/pool.ts`) keeps only what production
 * needs: tables, relations, visibility maintenance, the load window
 * (`hydrate`, which reports how many rows it installed), and `dispose`. It
 * never configures MobX (tests apply `mobx-enforce.ts` through
 * `mobx-trap.ts`), it has no out-of-reaction reader, no drain loop, no
 * settling snapshot, and no stats: the harness owns all of those here.
 *
 * This module owns those harness pieces:
 * - `tracked()`: the transient-reaction reader the harness uses for
 *   out-of-reaction reads;
 * - the drain helpers (`settlePoolLoads`, `poolPendingLoads`,
 *   `visibleOrderOf`) and the settling snapshot (`snapshotPool`);
 * - `harnessMobxPoolArm`: the full `CheckableArm` + `LazyArmHandle` the
 *   fences, gates and lanes run. It wraps the product arm's handle
 *   (`mobxPoolArm.create`, the ONE entry point) and adds only the
 *   harness snapshot / rebuild / drain hooks plus the flush bookkeeping;
 * - POD-5432: the arm that owns optimism is this same arm on the `owned`
 *   feed, its pool given the feeds' transaction log (`feeds.attachPool`);
 *   its rows already carry the pending changes, so no rebuild overlay.
 *
 * The load queue is observed from outside (POD-4945): the adapter wraps the
 * window's `schedule`, so an armed window means loads are pending
 * (`poolPendingLoads`), and drains by closing windows until one installs
 * nothing (`pool.hydrate()` reports its installed rows). The product
 * `Residency` exposes no queue depth.
 */

import { flushSync } from 'react-dom'
import { autorun } from 'mobx'
import type {
  CheckableArm,
  CheckableArmHandle,
  LazyArmHandle,
  LocalsSource,
  RowSource,
} from '../../../shared/src/arm'
import { DISABLED_READ_FENCE, type ReadFence } from '../../../shared/src/instrument/reads'
import { compareRank } from '@podium/client-graph/shared/row-view'
import type { SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import type { ArmStats } from '../../../shared/src/stats'
import { mobxPoolArm } from '../../../arms/mobx/pool/arm'
import type { MobxPool, PoolLazyOptions } from '@podium/client-graph/pool'
import { rebuildSnapshot } from './mobx-rebuild'
import { burstMemoryCensus } from '../burst-memory-census'

import { sliceOrderOf, type Layout } from '@podium/client-graph/worklist/groups'
import { sliceRowOf } from '@podium/client-graph/shared/row-view'
import type { Schedule } from '@podium/client-graph/residency'

/** Load rounds the harness drain allows before it gives up (a load that never lands). */
const MAX_LOAD_ROUNDS = 64

/** Redraw-then-load rounds the harness arm's drain allows before it gives up. */
const REDRAW_ROUNDS = 64

/**
 * Run `read` inside a transient reaction and return its result, so reads made
 * outside any reaction (the harness's snapshot) are tracked reads and never
 * trip `computedRequiresReaction` / `observableRequiresReaction`.
 *
 * Only the harness reads outside a reaction.
 */
export function tracked<T>(read: () => T): T {
  let result: { value: T } | null = null
  let failure: { error: unknown } | null = null
  const stop = autorun(() => {
    try {
      result = { value: read() }
    } catch (error) {
      failure = { error }
    }
  })
  stop()
  if (failure !== null) throw (failure as { error: unknown }).error
  if (result === null)
    throw new Error('[pool] tracked() ran inside a batch; read after the action ends')
  return (result as { value: T }).value
}

/**
 * Give the harness fence a reader over the pool's live graph. Probe sequences
 * capture it even when counting is disabled. Their out-of-reaction reads,
 * including collection iteration, run in transient reactions like snapshots.
 * The fence's counted wrapper stays in the harness; product reads use the
 * pool's existing graph.
 */
function captureRelations(pool: MobxPool, reads: ReadFence): void {
  reads.wrapRelations({
    one: (from, id, relation) => tracked(() => pool.relations.one(from, id, relation)),
    many: (from, id, relation) => tracked(() => [...pool.relations.many(from, id, relation)]),
    size: (from, id, relation) => tracked(() => pool.relations.size(from, id, relation)),
    subset: (from, id, relation, subset) =>
      tracked(() => [...pool.relations.subset(from, id, relation, subset)]),
  })
}

/** The window's default timer (what the product pool uses without one). */
const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

/**
 * Armed load windows per pool, counted by the schedule wrapper its `create`
 * installed: the pool arms its window exactly while loads are queued, so an
 * armed window means loads are pending. The product `Residency` exposes no
 * queue depth; this is the harness's outside way to observe it (POD-4945).
 */
const armedByPool = new WeakMap<object, () => number>()

/**
 * The loader with its timer wrapped to count armed windows. Wrapping is
 * transparent: the inner schedule still arms and fires, and its cancel still
 * cancels; only the count is added.
 */
function watchWindows(
  loader: Omit<PoolLazyOptions, 'load'>,
): { loader: Omit<PoolLazyOptions, 'load'>; armed: () => number } {
  let armed = 0
  const inner = loader.schedule ?? defaultSchedule
  const schedule: Schedule = (run, ms) => {
    armed += 1
    let done = false
    const cancel = inner(
      () => {
        if (done) return
        done = true
        armed -= 1
        run()
      },
      ms,
    )
    return () => {
      if (done) return
      done = true
      armed -= 1
      cancel()
    }
  }
  return { loader: { ...loader, schedule }, armed: () => armed }
}

/**
 * Loads queued for a load and not yet landed (the fence's pending probe):
 * 1 while the pool's window is armed, else 0. A count of rows would need a
 * product queue accessor; the fence only refuses a step that leaves loads,
 * so armed-or-not answers it.
 */
export function poolPendingLoads(pool: MobxPool): number {
  return (armedByPool.get(pool)?.() ?? 0) > 0 ? 1 : 0
}

/**
 * Close the load window until a window installs nothing: every queued row,
 * and every row those rows' installation queues in turn. Returns the windows
 * that installed rows.
 */
export function settlePoolLoads(pool: MobxPool): number {
  if (pool.residency === null) return 0
  let rounds = 0
  while (pool.hydrate() > 0) {
    rounds += 1
    if (rounds >= MAX_LOAD_ROUNDS) {
      throw new Error(`[pool] loads did not settle in ${MAX_LOAD_ROUNDS} load rounds`)
    }
  }
  return rounds
}

/** Every id in the grouped layout: the pinned section, then each group's open lane and closed fold. */
function layoutIds(layout: Layout): string[] {
  return [
    ...layout.pinnedIds,
    ...layout.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
  ]
}

/**
 * The visible ids in L1b rank order, read from the group lanes (the product
 * `VisibleCollection` maintains them but exposes no copy): the layout's ids
 * sorted by each row's cached rank. What the deleted `worklist.order` read.
 * A plain read: call inside `tracked()` (or any reaction), like any other
 * observable read — it must never create its own reaction, so it stays
 * usable inside derivations.
 */
export function visibleOrderOf(pool: MobxPool): readonly string[] {
  const layout = worklistGroups(pool).layout
  const ids = layoutIds(layout)
  const ranks = new Map<string, ReturnType<ReturnType<typeof worklistGroups>['rankOf']>>()
  for (const id of ids) ranks.set(id, worklistGroups(pool).rankOf(id))
  return ids.sort((a, b) => compareRank(ranks.get(a)!, ranks.get(b)!))
}

/**
 * The slice output: every visible issue's row, grouped with closed folds and
 * no selection. Settled: a visible row that is cold is asked for (it loads,
 * as a drawn row does), and reading the rows queues the cold rows they reach;
 * those are loaded and the rows read again until a window installs nothing,
 * as a reader that waits out its loading state would see them.
 *
 * Rows are read in L1b rank order (as the old `worklist.order` walk did), so
 * `rowsById` keeps rank-ordered keys; the order itself comes from the group
 * lanes. Settling reads are harness-only. A row gone from the feed (its load
 * never lands) is simply absent from the rows, rather than failing the
 * snapshot.
 */
export function snapshotPool(pool: MobxPool): SliceSnapshot {
  for (let round = 0; ; round += 1) {
    const snapshot = tracked(() => {
      const layout = worklistGroups(pool).layout
      const rowsById: SliceSnapshot['rowsById'] = {}
      for (const id of visibleOrderOf(pool)) {
        const view = rowViewOf(pool.issue(id))
        if (view === undefined) {
          pool.resident('issue', id)
          continue
        }
        rowsById[id] = sliceRowOf(view)
      }
      burstMemoryCensus('inside-parity-reaction', pool)
      return { order: sliceOrderOf(layout), rowsById }
    })
    if (pool.hydrate() === 0) return snapshot
    if (round >= MAX_LOAD_ROUNDS) {
      throw new Error(`[pool] snapshot() did not settle in ${MAX_LOAD_ROUNDS} load rounds`)
    }
  }
}

/**
 * The harness drain over a product-mounted pool: flush the mounted roots,
 * then close the load window, until nothing is queued.
 */
function settleWithFlush(pool: MobxPool, isMounted: () => boolean): void {
  for (let round = 0; ; round += 1) {
    if (isMounted()) flushSync(() => {})
    if (poolPendingLoads(pool) === 0) return
    if (round >= REDRAW_ROUNDS) {
      throw new Error(`[pool] loads did not settle in ${REDRAW_ROUNDS} redraw rounds`)
    }
    settlePoolLoads(pool)
  }
}

/**
 * The arm contract's counters, satisfied with zeros (POD-4945): the product
 * arm keeps no stats. Tests count from outside (the borrowed rows and the
 * work meter), never from product code.
 */
function zeroStats(): ArmStats {
  return {
    rowsDerived: 0,
    rollupsDerived: 0,
    indexUpdates: 0,
    notifications: 0,
    reset(): void {},
  }
}

/** The harness handle: the live pool beside the full checker + lazy hooks. */
export type HarnessMobxPoolHandle = CheckableArmHandle & LazyArmHandle & {
  /** The live pool (tests; the copy sweep reaches the tables through it). */
  readonly pool: MobxPool
}


/**
 * The harness MobX arm over the product pool: a `CheckableArm` +
 * `LazyArmHandle` for the fences, gates and lanes. It creates the pool
 * through the product arm (`mobxPoolArm.create`, the ONE entry point) and
 * adds only what the harness needs on top of the returned product handle:
 * the settling snapshot, the rebuild, the drain hooks, and the
 * mounted-roots flush bookkeeping (kept here by wrapping `mountWeb`, so the
 * product handle needs no test-only seam).
 */
export const harnessMobxPoolArm = {
  create(
    source: RowSource,
    locals: LocalsSource,
    reads: ReadFence = DISABLED_READ_FENCE,
    loader: Omit<PoolLazyOptions, 'load'> = {},
  ): HarnessMobxPoolHandle {
    const watched = watchWindows(loader)
    const base = mobxPoolArm.create(source, locals, watched.loader)
    const pool = base.pool
    captureRelations(pool, reads)
    armedByPool.set(pool, watched.armed)
    let webMounts = 0
    const originalMountWeb = base.mountWeb.bind(base)
    const originalDispose = base.dispose.bind(base)
    return {
      pool,
      stats: zeroStats(),
      snapshot: () => snapshotPool(pool),
      rebuildFromScratch: () => rebuildSnapshot(source, locals),
      settleLoads: () => settleWithFlush(pool, () => webMounts > 0),
      pendingLoads: () => poolPendingLoads(pool),
      dispose(): void {
        webMounts = 0
        originalDispose()
      },
      mountWeb(el: Element): () => void {
        webMounts += 1
        const unmount = originalMountWeb(el)
        let done = false
        return () => {
          if (done) return
          done = true
          webMounts -= 1
          unmount()
        }
      },
      mountNative: () => base.mountNative(),
    }
  },
} satisfies CheckableArm

