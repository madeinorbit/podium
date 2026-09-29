/**
 * POD-4565 (Ma1) — the round-three MobX arm over the pool: a `CheckableArm`
 * (`shared/src/arm.ts`). See `../README.md` ("Round three: the pool") for the
 * idiom, the write path and how to add a field.
 *
 * `create` seeds the pool from the feed's snapshot (one `replace`), then
 * follows the feed (`RowSource`) and the locals channel (`LocalsSource`),
 * waking only what each notification names. Cold rows load through the
 * feed's per-row read (`RowSource.row`, POD-4567); a feed without one is
 * refused rather than silently holding every row. No JSX here: this module builds
 * the pool, and the lint fence keeps store modules out of component files.
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
import { MobxPool, type PoolLazyOptions, type WriteSeam } from './pool'
import { PoolList } from './react/list'
import { rebuildSnapshot } from './rebuild'

/** Redraw-then-load rounds `settleLoads` allows before it gives up. */
const SETTLE_ROUNDS = 64

/** Loaded on first native mount only: the node lanes cannot parse `react-native`. */
const PoolNativeList = lazy(() => import('./native/list'))

/** The pool is lazy: the shared fence's load hooks are required (G2, `LazyArmHandle`). */
export interface MobxPoolHandle extends CheckableArmHandle {
  /** The live pool (tests; the copy sweep reaches the tables through it). */
  readonly pool: MobxPool
  settleLoads: LazyArmHandle['settleLoads']
  pendingLoads: LazyArmHandle['pendingLoads']
}

export const mobxPoolArm = {
  create(
    source: RowSource,
    locals: LocalsSource,
    reads: ReadFence = DISABLED_READ_FENCE,
    /** Tests: the load window and its timer (default 50 ms, `setTimeout`). */
    loader: Omit<PoolLazyOptions, 'load'> = {},
    /** The write layer's pending display (`write/arm.ts`), read by the pool's one reader. */
    writes?: WriteSeam,
  ): MobxPoolHandle {
    const row = source.row?.bind(source)
    if (row === undefined) {
      throw new Error(
        '[pool] the feed has no per-row read (RowSource.row): a lazy pool cannot load a cold row',
      )
    }
    const pool = new MobxPool(reads, locals.get(), undefined, { ...loader, load: row }, writes)
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
      snapshot: () => pool.snapshot(),
      rebuildFromScratch: () => rebuildSnapshot(source, locals, pool.residentIssueIds()),
      // A change reaches a cold row when a row REDRAWS (its view reads the
      // row in render), so a settle flushes this arm's redraws, lands what
      // they queued, and repeats until a redraw queues nothing (G2).
      settleLoads: () => {
        for (let round = 0; ; round += 1) {
          if (roots.size > 0) flushSync(() => {})
          if (pool.pendingLoads() === 0) return
          if (round >= SETTLE_ROUNDS) {
            throw new Error(`[pool] loads did not settle in ${SETTLE_ROUNDS} redraw rounds`)
          }
          pool.settleLoads()
        }
      },
      pendingLoads: () => pool.pendingLoads(),
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
        return createElement(Suspense, { fallback: null }, createElement(PoolNativeList, { pool }))
      },
    }
  },
} satisfies CheckableArm
