/**
 * POD-4578 (Ha1) + POD-4933 — the round-three hand-rolled pool's product
 * entry: it builds the pool, follows the feed and the locals channel, and
 * mounts the product lists. See `../README.md` ("Round three: the pool") for
 * the idiom, the write path and how to add a field.
 *
 * Product-only: no snapshot, no rebuild, no drain hooks. The harness owns
 * those (`harness/src/adapters/hand-pool.ts`), on top of the pool's public
 * API (`hydrate`, `dispose`).
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
import { createRoot, type Root } from 'react-dom/client'
import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import { DISABLED_READ_FENCE, type ReadFence } from '../../../shared/src/instrument/reads'
import { CommitLogContext, currentCommitLog } from '../../../shared/src/row-shell'
import type { ArmStats } from '../../../shared/src/stats'
import { HandPool, type PoolLazyOptions } from './pool'
import { PoolList } from './react/list'

/** Loaded on first native mount only: the node lanes cannot parse `react-native`. */
const PoolNativeList = lazy(() => import('./native/list'))

/**
 * The product handle: the live pool, its stats, its lifecycle and its mounts.
 * Harness hooks (snapshot, rebuild, drain) live in the harness adapter and
 * are not part of the product surface.
 */
export interface HandPoolHandle {
  /** The live pool (tests; the copy sweep reaches the tables through it). */
  readonly pool: HandPool
  readonly stats: ArmStats
  dispose(): void
  mountWeb(el: Element): () => void
  mountNative(): ReactElement
}

export const handPoolArm = {
  create(
    source: RowSource,
    locals: LocalsSource,
    reads: ReadFence = DISABLED_READ_FENCE,
    /** The load window and its timer (default 50 ms, `setTimeout`). */
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
}
