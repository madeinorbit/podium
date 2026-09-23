/**
 * POD-4578 (Ha1) — the round-three hand-rolled arm over the pool: a
 * `CheckableArm` (`shared/src/arm.ts`). See `../README.md` ("Round three: the
 * pool") for the idiom, the write path and how to add a field.
 *
 * `create` seeds the pool from the feed's snapshot (one `replace`), then
 * follows the feed (`RowSource`) and the locals channel (`LocalsSource`),
 * waking only what each notification names. Cold rows (closed issues and
 * their sessions) load through the feed's per-row read (`RowSource.row`,
 * POD-4580); a feed without one is refused rather than silently holding
 * every row. No JSX here: this module builds the pool, and the lint fence
 * keeps store modules out of component files.
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
import { HandPool, type PoolLazyOptions } from './pool'
import { PoolList } from './react/list'
import { rebuildSnapshot } from './rebuild'

/** Redraw-then-load rounds `settleLoads` allows before it gives up. */
const SETTLE_ROUNDS = 64

/** Loaded on first native mount only: the node lanes cannot parse `react-native`. */
const PoolNativeList = lazy(() => import('./native/list'))

export interface HandPoolHandle extends CheckableArmHandle {
  /** The live pool (tests; the copy sweep reaches the tables through it). */
  readonly pool: HandPool
  /** Rows queued for a load that has not landed (POD-4580; the shared fence's hook, G2). */
  pendingLoads: LazyArmHandle['pendingLoads']
  /** The shared fence's hook (POD-4568, G2): redraw, land what that queued, repeat. */
  settleLoads: LazyArmHandle['settleLoads']
  /** Land every pending load now, no redraw; returns the rows installed (POD-4580). */
  drainLoads(): number
}

export const handPoolArm = {
  create(
    source: RowSource,
    locals: LocalsSource,
    reads: ReadFence = DISABLED_READ_FENCE,
    /** Tests: the load window and its timer (default 50 ms, `setTimeout`). */
    loader: Omit<PoolLazyOptions, 'load'> = {},
  ): HandPoolHandle {
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
      pendingLoads: () => pool.pendingLoads(),
      // A row that REDRAWS can reach a cold row (a view cell created in
      // render asks for its cold inputs), so a settle flushes this arm's
      // redraws, lands what they queued, and repeats until a redraw queues
      // nothing (G2, as the MobX arm).
      settleLoads: () => {
        for (let round = 0; ; round += 1) {
          if (roots.size > 0) flushSync(() => {})
          if (pool.pendingLoads() === 0) return
          if (round >= SETTLE_ROUNDS) {
            throw new Error(`[pool] loads did not settle in ${SETTLE_ROUNDS} redraw rounds`)
          }
          pool.drainLoads()
        }
      },
      drainLoads: () => pool.drainLoads(),
      snapshot: () => pool.snapshot(),
      rebuildFromScratch: () => rebuildSnapshot(source, locals, pool.residentIssueIds()),
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
