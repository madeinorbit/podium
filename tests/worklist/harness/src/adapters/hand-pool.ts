/**
 * POD-4933 + POD-4944 — the hand-rolled pool's harness adapter: helpers that
 * exist only for the test harness, on top of the pool's public product API.
 *
 * The product pool (`arms/hand/pool/pool.ts`) keeps only what production
 * needs: tables, relations, visibility maintenance, the load window
 * (`hydrate`), and `dispose`. It has no drain loop, no pending probe, no
 * resident-ids helper and no settling snapshot.
 *
 * This module owns those harness pieces:
 * - the drain helpers (`settlePoolLoads`, `drainPoolLoads`,
 *   `poolPendingLoads`, `residentIssueIdsOf`) and the settling snapshot
 *   (`snapshotPool`);
 * - `harnessHandPoolArm`: the full `CheckableArm` + `LazyArmHandle` the
 *   fences, gates and lanes run. It wraps the product arm's handle
 *   (`handPoolArm.create`) — the ONE entry point — and adds only the
 *   harness snapshot / rebuild / drain hooks plus the flush bookkeeping;
 * - `harnessWritableHandPoolArm`: the same over the product write arm
 *   (`writableHandPoolArm(...).create(...)`), with the optimism-aware
 *   rebuild on top.
 *
 * The hand pool needs no `tracked()` helper: unlike MobX there is no
 * out-of-reaction enforcement, so a harness read outside a cell is a plain
 * read (the graph's `track` no-ops with no running cell).
 */

import { flushSync } from 'react-dom'
import type {
  CheckableArm,
  CheckableArmHandle,
  LazyArmHandle,
  LocalsSource,
  RowSource,
} from '../../../shared/src/arm'
import { DISABLED_READ_FENCE, type ReadFence } from '../../../shared/src/instrument/reads'
import { sliceRowOf } from '@podium/client-graph/shared/row-view'
import type { SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import type { RowRecord } from '../../../shared/src/stats'
import type { WriteTransport } from '@podium/client-graph/shared/write-contract'
import { handPoolArm } from '../../../arms/hand/pool/arm'
import type { HandPool, PoolLazyOptions } from '../../../arms/hand/pool/pool'
import { rebuildSnapshot } from '../../../arms/hand/pool/rebuild'
import { sliceOrderOf } from '../../../arms/hand/pool/worklist/groups'
import type { HandWriteApi } from '../../../arms/hand/pool/write/edit'
import { writableHandPoolArm } from '../../../arms/hand/pool/write/arm'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'

/** Load rounds the harness drain allows before it gives up (a load that never lands). */
const MAX_LOAD_ROUNDS = 64

/** Redraw-then-load rounds the harness arm's drain allows before it gives up. */
const REDRAW_ROUNDS = 64

/** Rows queued for a load and not yet landed (the fence's pending probe). */
export function poolPendingLoads(pool: HandPool): number {
  return pool.residency?.queued() ?? 0
}

/**
 * Land every pending load NOW, and whatever those loads queue in turn, until
 * nothing is queued: one commit per round, as the window would. The rows
 * installed are returned, so a caller can charge them to the change that
 * asked for them (the shared fence's drain hook, POD-4568's G2).
 *
 * Moved from `HandPool.drainLoads()` (POD-4933): the drain loop is
 * harness-only; production closes the window one batch at a time (`hydrate`).
 */
export function drainPoolLoads(pool: HandPool): number {
  const residency = pool.residency
  if (residency === null) return 0
  const before = residency.counters.hydrated
  for (let round = 0; residency.hasQueued(); round += 1) {
    if (round >= MAX_LOAD_ROUNDS) {
      throw new Error(`[pool] loads did not drain in ${MAX_LOAD_ROUNDS} rounds`)
    }
    pool.hydrate()
  }
  return residency.counters.hydrated - before
}

/**
 * Close the load window until nothing is queued: every queued row, and every
 * row those rows' installation queues in turn. Returns the rows installed.
 *
 * The harness arm's settle calls this after each redraw flush (see below);
 * direct callers that need only the drain (no redraw) call `drainPoolLoads`.
 */
export function settlePoolLoads(pool: HandPool): number {
  return drainPoolLoads(pool)
}

/** The resident issue ids, untracked (the rebuild's residency input). */
export function residentIssueIdsOf(pool: HandPool): ReadonlySet<string> {
  return new Set(pool.tables.issue.keys())
}

/**
 * The slice output: the VISIBLE rows in rank order, grouped with closed
 * folds and no selection. Settled: reading the rows (and deciding
 * visibility) queues the cold rows they reach, and those are loaded and the
 * rows read again until nothing is queued, as a reader that waits out its
 * loading state would see them.
 *
 * Moved from `HandPool.snapshot()` (POD-4933): settling reads are
 * harness-only.
 */
export function snapshotPool(pool: HandPool): SliceSnapshot {
  for (let round = 0; ; round += 1) {
    const rowsById: SliceSnapshot['rowsById'] = {}
    for (const id of pool.order()) {
      const view = pool.view(id)
      if (view === undefined) continue
      rowsById[id] = sliceRowOf(view)
    }
    if (pool.residency?.hasQueued() !== true) {
      return { order: sliceOrderOf(pool.groups.snapshot()), rowsById }
    }
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
function settleWithFlush(pool: HandPool, isMounted: () => boolean): void {
  for (let round = 0; ; round += 1) {
    if (isMounted()) flushSync(() => {})
    if (poolPendingLoads(pool) === 0) return
    if (round >= REDRAW_ROUNDS) {
      throw new Error(`[pool] loads did not settle in ${REDRAW_ROUNDS} redraw rounds`)
    }
    drainPoolLoads(pool)
  }
}

/** The harness handle: the live pool beside the full checker + lazy hooks. */
export type HarnessHandPoolHandle = CheckableArmHandle & LazyArmHandle & {
  /** The live pool (tests; the copy sweep reaches the tables through it). */
  readonly pool: HandPool
  /** Land every pending load now, no redraw; returns the rows installed. */
  drainLoads(): number
}

/** The harness writable handle: the live pool and the write api. */
export type HarnessWritableHandPoolHandle = CheckableArmHandle & LazyArmHandle & {
  readonly pool: HandPool
  readonly write: HandWriteApi
  drainLoads(): number
}

/**
 * The harness hand arm over the product pool: a `CheckableArm` +
 * `LazyArmHandle` for the fences, gates and lanes. It creates the pool
 * through the product arm (`handPoolArm.create`, the ONE entry point) and
 * adds only what the harness needs on top of the returned product handle:
 * the settling snapshot, the rebuild, the drain hooks, and the
 * mounted-roots flush bookkeeping (kept here by wrapping `mountWeb`, so the
 * product handle needs no test-only seam).
 */
export const harnessHandPoolArm = {
  create(
    source: RowSource,
    locals: LocalsSource,
    reads: ReadFence = DISABLED_READ_FENCE,
    loader: Omit<PoolLazyOptions, 'load'> = {},
  ): HarnessHandPoolHandle {
    const base = handPoolArm.create(source, locals, reads, loader)
    const pool = base.pool
    let webMounts = 0
    const originalMountWeb = base.mountWeb.bind(base)
    const originalDispose = base.dispose.bind(base)
    return {
      pool,
      stats: base.stats,
      snapshot: () => snapshotPool(pool),
      rebuildFromScratch: () => rebuildSnapshot(source, locals, residentIssueIdsOf(pool)),
      pendingLoads: () => poolPendingLoads(pool),
      // A row that REDRAWS can reach a cold row (a view cell created in
      // render asks for its cold inputs), so a settle flushes this arm's
      // redraws, lands what they queued, and repeats until a redraw queues
      // nothing (G2, as the MobX arm).
      settleLoads: () => settleWithFlush(pool, () => webMounts > 0),
      drainLoads: () => drainPoolLoads(pool),
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
 * The harness writable hand arm: the product pool with the write layer
 * attached, for the write gates. It creates the pool through the product
 * write arm (`writableHandPoolArm(...).create(...)`, the ONE writable entry
 * point — including its bootstrap and its feed and receipt wiring) and adds
 * only what the harness needs: the settling snapshot, the drain hooks, the
 * flush bookkeeping, and the optimism-aware rebuild, which overlays the
 * pending display onto the feed's server rows before deriving, so a gate with
 * pending edits outstanding compares the live pending view with a pending
 * rebuild — never with server truth.
 */
export function harnessWritableHandPoolArm(
  transport: WriteTransport,
  loader: Omit<PoolLazyOptions, 'load'> = {},
): CheckableArm {
  return {
    create(source: RowSource, locals: LocalsSource, reads?: ReadFence): HarnessWritableHandPoolHandle {
      const product = writableHandPoolArm(transport, loader).create(source, locals, reads)
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
            return { ...record, value: { ...(record.value as SliceIssue), ...pending } }
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
        drainLoads: () => drainPoolLoads(pool),
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
