/**
 * POD-4760 + POD-4944 — the MobX pool's harness adapter: helpers that exist
 * only for the test harness, on top of the pool's public product API.
 *
 * The product pool (`arms/mobx/pool/pool.ts`) keeps only what production
 * needs: tables, relations, visibility maintenance, the load window
 * (`hydrate`), and `dispose`. It never configures MobX (see `enforce.ts`:
 * tests apply it through `mobx-trap.ts`) and it has no out-of-reaction
 * reader, no drain loop, and no settling snapshot.
 *
 * This module owns those harness pieces:
 * - `tracked()`: the transient-reaction reader the harness uses for
 *   out-of-reaction reads (moved from `pool.ts`);
 * - the drain helpers (`settlePoolLoads`, `poolPendingLoads`,
 *   `residentIssueIdsOf`) and the settling snapshot (`snapshotPool`);
 * - `harnessMobxPoolArm`: the full `CheckableArm` + `LazyArmHandle` the
 *   fences, gates and lanes run. It wraps the product arm's handle
 *   (`mobxPoolArm.create`) — the ONE entry point — and adds only the
 *   harness snapshot / rebuild / drain hooks plus the flush bookkeeping;
 * - `harnessWritableMobxPoolArm`: the same over the product write arm
 *   (`writableMobxPoolArm(...).create(...)`), with the optimism-aware
 *   rebuild on top.
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
import type { SliceSnapshot } from '../../../shared/src/slice-types'
import type { RowRecord } from '../../../shared/src/stats'
import type { WriteTransport } from '../../../shared/src/write-contract'
import { mobxPoolArm } from '../../../arms/mobx/pool/arm'
import type { MobxPool, PoolLazyOptions, WriteSeam } from '../../../arms/mobx/pool/pool'
import { rebuildSnapshot } from '../../../arms/mobx/pool/rebuild'
import { rowViewOf } from '../../../arms/mobx/pool/models'
import { sliceOrderOf } from '../../../arms/mobx/pool/worklist/groups'
import { sliceRowOf } from '../../../shared/src/row-view'
import type { MobxWriteApi } from '../../../arms/mobx/pool/write/edit'
import { writableMobxPoolArm } from '../../../arms/mobx/pool/write/arm'
import type { SliceIssue } from '../../../shared/src/slice-types'

/** Load rounds the harness drain allows before it gives up (a load that never lands). */
const MAX_LOAD_ROUNDS = 64

/** Redraw-then-load rounds the harness arm's drain allows before it gives up. */
const REDRAW_ROUNDS = 64

/**
 * Run `read` inside a transient reaction and return its result, so reads made
 * outside any reaction (the harness's snapshot) are tracked reads and never
 * trip `computedRequiresReaction` / `observableRequiresReaction`.
 *
 * Moved from `arms/mobx/pool/pool.ts` (POD-4760): only the harness reads
 * outside a reaction.
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

/** Rows queued for a load and not yet landed (the fence's pending probe). */
export function poolPendingLoads(pool: MobxPool): number {
  return pool.residency?.queued() ?? 0
}

/**
 * Close the load window until nothing is queued: every queued row, and every
 * row those rows' installation queues in turn. Returns the windows closed.
 */
export function settlePoolLoads(pool: MobxPool): number {
  const residency = pool.residency
  if (residency === null) return 0
  let rounds = 0
  while (residency.hasQueued()) {
    if (rounds >= MAX_LOAD_ROUNDS) {
      throw new Error(`[pool] loads did not settle in ${MAX_LOAD_ROUNDS} load rounds`)
    }
    pool.hydrate()
    rounds += 1
  }
  return rounds
}

/** The resident issue ids (the rebuild's residency input; the rebuild ignores it). */
export function residentIssueIdsOf(pool: MobxPool): ReadonlySet<string> {
  return new Set(tracked(() => pool.issueIds))
}

/**
 * The slice output: every visible issue's row, grouped with closed folds and
 * no selection. Settled: a visible row that is cold is asked for (it loads,
 * as a drawn row does), and reading the rows queues the cold rows they reach;
 * those are loaded and the rows read again until nothing is queued, as a
 * reader that waits out its loading state would see them.
 *
 * Moved from `MobxPool.snapshot()` (POD-4760): settling reads are harness-only.
 */
export function snapshotPool(pool: MobxPool): SliceSnapshot {
  for (let round = 0; ; round += 1) {
    const snapshot = tracked(() => {
      const rowsById: SliceSnapshot['rowsById'] = {}
      for (const id of pool.worklist.order) {
        const view = rowViewOf(pool.issue(id))
        if (view === undefined) {
          pool.resident('issue', id)
          continue
        }
        rowsById[id] = sliceRowOf(view)
      }
      return { order: sliceOrderOf(pool.groups.layout), rowsById }
    })
    if (pool.residency?.hasQueued() !== true) return snapshot
    if (round >= MAX_LOAD_ROUNDS) {
      throw new Error(`[pool] snapshot() did not settle in ${MAX_LOAD_ROUNDS} load rounds`)
    }
    pool.hydrate()
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

/** The harness handle: the live pool beside the full checker + lazy hooks. */
export type HarnessMobxPoolHandle = CheckableArmHandle & LazyArmHandle & {
  /** The live pool (tests; the copy sweep reaches the tables through it). */
  readonly pool: MobxPool
}

/** The harness writable handle: the live pool and the write api. */
export type HarnessWritableMobxPoolHandle = CheckableArmHandle & LazyArmHandle & {
  readonly pool: MobxPool
  readonly write: MobxWriteApi
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
    _reads: ReadFence = DISABLED_READ_FENCE,
    loader: Omit<PoolLazyOptions, 'load'> = {},
    writes?: WriteSeam,
  ): HarnessMobxPoolHandle {
    const base = mobxPoolArm.create(source, locals, _reads, loader, writes)
    const pool = base.pool
    let webMounts = 0
    const originalMountWeb = base.mountWeb.bind(base)
    const originalDispose = base.dispose.bind(base)
    return {
      pool,
      stats: base.stats,
      snapshot: () => snapshotPool(pool),
      rebuildFromScratch: () => rebuildSnapshot(source, locals, residentIssueIdsOf(pool)),
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

/**
 * The harness writable MobX arm: the product pool with the write layer
 * attached, for the write gates. It creates the pool through the product
 * write arm (`writableMobxPoolArm(...).create(...)`, the ONE writable entry
 * point — including its feed and receipt wiring) and adds only what the
 * harness needs: the settling snapshot, the drain hooks, the flush
 * bookkeeping, and the optimism-aware rebuild, which overlays the pending
 * display onto the feed's server rows before deriving, so a gate with
 * pending edits outstanding compares the live pending view with a pending
 * rebuild — never with server truth.
 */
export function harnessWritableMobxPoolArm(
  transport: WriteTransport,
  loader: Omit<PoolLazyOptions, 'load'> = {},
): CheckableArm {
  return {
    create(source: RowSource, locals: LocalsSource, reads?: ReadFence): HarnessWritableMobxPoolHandle {
      const product = writableMobxPoolArm(transport, loader).create(source, locals, reads)
      const pool = product.pool
      const write = product.write
      let webMounts = 0
      const originalMountWeb = product.mountWeb.bind(product)
      const originalDispose = product.dispose.bind(product)
      const pendingSource: RowSource = {
        ...source,
        snapshot: (kind: RowRecord['kind']): RowRecord[] => {
          const rows = source.snapshot(kind)
          if (kind !== 'issue') return rows
          return rows.map((record) => {
            if (record.value === undefined) return record
            const pending = write.pendingDisplay('issue', record.id) as
              | Partial<SliceIssue>
              | undefined
            if (pending === undefined) return record
            return { ...record, value: { ...record.value, ...pending } }
          })
        },
        ...(source.row === undefined
          ? {}
          : {
              row: ((kind: 'issue' | 'session', id: string) => {
                const value = source.row!(kind, id)
                if (kind !== 'issue' || value === undefined) return value
                const pending = write.pendingDisplay('issue', id) as
                  | Partial<SliceIssue>
                  | undefined
                return pending === undefined ? value : { ...value, ...pending }
              }) as RowSource['row'],
            }),
      }
      return {
        pool,
        write,
        stats: product.stats,
        snapshot: () => snapshotPool(pool),
        rebuildFromScratch: () => rebuildSnapshot(pendingSource, locals),
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
        mountNative: () => product.mountNative(),
      }
    },
  }
}
