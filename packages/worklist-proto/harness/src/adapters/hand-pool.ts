/**
 * POD-4933 — the hand-rolled pool's harness adapter: helpers that exist only
 * for the test harness, on top of the pool's public product API.
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
 *   fences, gates and lanes run, wrapping the product arm's pool creation
 *   and mounts and adding the harness snapshot / rebuild / drain hooks;
 * - `harnessWritableHandPoolArm`: the same with the write layer attached
 *   (optimism-aware rebuild), for the write gates.
 *
 * The hand pool needs no `tracked()` helper: unlike MobX there is no
 * out-of-reaction enforcement, so a harness read outside a cell is a plain
 * read (the graph's `track` no-ops with no running cell).
 */

import { createElement, lazy, type ReactElement, Suspense } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type {
  CheckableArm,
  CheckableArmHandle,
  LazyArmHandle,
  LocalsSource,
  RowSource,
} from '../../../shared/src/arm'
import { DISABLED_READ_FENCE, type ReadFence } from '../../../shared/src/instrument/reads'
import { CommitLogContext, currentCommitLog } from '../../../shared/src/row-shell'
import { sliceRowOf } from '../../../shared/src/row-view'
import type { SliceSnapshot } from '../../../shared/src/slice-types'
import type { RowRecord } from '../../../shared/src/stats'
import type { WriteTransport } from '../../../shared/src/write-contract'
import { HandPool, type PoolLazyOptions } from '../../../arms/hand/pool/pool'
import { PoolList } from '../../../arms/hand/pool/react/list'
import { rebuildSnapshot } from '../../../arms/hand/pool/rebuild'
import { sliceOrderOf } from '../../../arms/hand/pool/worklist/groups'
import { createHandWriteApi, type HandWriteApi } from '../../../arms/hand/pool/write/edit'
import type { SliceIssue } from '../../../shared/src/slice-types'

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

/** Loaded on first native mount only: the node lanes cannot parse `react-native`. */
const HarnessPoolNativeList = lazy(() => import('../../../arms/hand/pool/native/list'))

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

function editableOf(value: SliceIssue): { title: string; stage: string; readAt: string | null } {
  return { title: value.title, stage: value.stage, readAt: (value.readAt ?? null) as string | null }
}

/**
 * The harness hand arm over the product pool: a `CheckableArm` +
 * `LazyArmHandle` for the fences, gates and lanes. It creates the product
 * pool exactly as the product arm does (seed + feed/locals subscriptions),
 * mounts the product lists, and adds the harness snapshot / rebuild / drain
 * hooks on top of the pool's public API.
 */
export const harnessHandPoolArm = {
  create(
    source: RowSource,
    locals: LocalsSource,
    reads: ReadFence = DISABLED_READ_FENCE,
    loader: Omit<PoolLazyOptions, 'load'> = {},
  ): HarnessHandPoolHandle {
    const row = source.row?.bind(source)
    if (row === undefined) {
      throw new Error(
        '[pool] the feed has no per-row read (RowSource.row): a lazy pool cannot load a cold row',
      )
    }
    const pool = new HandPool(reads, locals.get(), undefined, { ...loader, load: row })
    pool.apply({
      type: 'replace',
      rows: [
        ...source.snapshot('session'),
        ...source.snapshot('issue'),
        ...source.snapshot('worktree'),
      ],
    })
    const offRows = source.subscribe((event) => pool.apply(event))
    const offLocals = locals.subscribe((changed) => pool.applyLocals(locals.get(), changed))
    const roots = new Set<Root>()
    return {
      pool,
      stats: pool.stats,
      snapshot: () => snapshotPool(pool),
      rebuildFromScratch: () => rebuildSnapshot(source, locals, residentIssueIdsOf(pool)),
      pendingLoads: () => poolPendingLoads(pool),
      // A row that REDRAWS can reach a cold row (a view cell created in
      // render asks for its cold inputs), so a settle flushes this arm's
      // redraws, lands what they queued, and repeats until a redraw queues
      // nothing (G2, as the MobX arm).
      settleLoads: () => {
        for (let round = 0; ; round += 1) {
          if (roots.size > 0) flushSync(() => {})
          if (poolPendingLoads(pool) === 0) return
          if (round >= REDRAW_ROUNDS) {
            throw new Error(`[pool] loads did not settle in ${REDRAW_ROUNDS} redraw rounds`)
          }
          drainPoolLoads(pool)
        }
      },
      drainLoads: () => drainPoolLoads(pool),
      dispose(): void {
        offRows()
        offLocals()
        for (const root of roots) root.unmount()
        roots.clear()
        pool.dispose()
      },
      mountWeb(el: Element): () => void {
        const root = createRoot(el)
        roots.add(root)
        root.render(
          createElement(
            CommitLogContext.Provider,
            { value: currentCommitLog() },
            createElement(PoolList, { pool }),
          ),
        )
        return () => {
          if (!roots.delete(root)) return
          root.unmount()
        }
      },
      mountNative(): ReactElement {
        return createElement(Suspense, { fallback: null }, createElement(HarnessPoolNativeList, { pool }))
      },
    }
  },
} satisfies CheckableArm

/**
 * The harness writable hand arm: the product pool with the write layer
 * attached, for the write gates. The optimism-aware rebuild overlays the
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
      const base = harnessHandPoolArm.create(source, locals, reads, loader)
      const pool = base.pool
      const write = createHandWriteApi(pool, transport)
      write.bootstrap(source)
      const offRemote = source.subscribe((event) => {
        for (const row of event.rows) {
          if (row.kind !== 'issue' || row.value === undefined) continue
          write.handleRemote('issue', row.id, editableOf(row.value as SliceIssue))
        }
      })
      const offReceipts = transport.subscribe((event) => {
        if (event.type === 'accepted') write.handleAccepted(event.txId)
        else if (event.type === 'rejected')
          write.reject({ txId: event.txId, error: event.error })
        else write.handleSuperseded(event.txId)
      })
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
      const originalDispose = base.dispose.bind(base)
      return {
        ...base,
        pool,
        write,
        rebuildFromScratch: () => rebuildSnapshot(pendingSource, locals),
        dispose(): void {
          offRemote()
          offReceipts()
          write.dispose()
          originalDispose()
        },
      }
    },
  }
}
