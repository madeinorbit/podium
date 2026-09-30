/**
 * POD-4565 (Ma1) + POD-4760 — the round-three MobX pool's product entry: it
 * builds the pool, follows the feed and the locals channel, and mounts the
 * product lists. See `../README.md` ("Round three: the pool") for the idiom,
 * the write path and how to add a field.
 *
 * Product-only: no snapshot, no rebuild, no drain hooks, no counters. The
 * harness owns those (`harness/src/adapters/mobx-pool.ts`), on top of the
 * pool's public API (`hydrate`, `dispose`). Strict MobX flags live only in
 * tests (`harness/src/mobx-enforce.ts` exports them,
 * `harness/src/mobx-trap.ts` applies them).
 *
 * `create` seeds the pool from the feed's snapshot (one `replace`), then
 * follows the feed (`RowSource`) and the locals channel (`LocalsSource`),
 * waking only what each notification names. Cold rows load through the
 * feed's per-row read (`RowSource.row`, POD-4567); a feed without one is
 * refused rather than silently holding every row. No JSX here: this module
 * builds the pool, and the lint fence keeps store modules out of component
 * files.
 */

import { createElement, lazy, type ReactElement, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import { CommitLogContext, currentCommitLog } from '../../../shared/src/row-shell'
import { MobxPool, type PoolLazyOptions, type WriteSeam } from './pool'
import { PoolList } from './react/list'

/** Loaded on first native mount only: the node lanes cannot parse `react-native`. */
const PoolNativeList = lazy(() => import('./native/list'))

/**
 * The product handle: the live pool, its lifecycle and its mounts. Harness
 * hooks (snapshot, rebuild, drain, contract counters) live in the harness
 * adapter and are not part of the product surface.
 */
export interface MobxPoolHandle {
  /** The live pool. */
  readonly pool: MobxPool
  dispose(): void
  mountWeb(el: Element): () => void
  mountNative(): ReactElement
}

export const mobxPoolArm = {
  create(
    source: RowSource,
    locals: LocalsSource,
    /** The load window and its timer (default 50 ms, `setTimeout`). */
    loader: Omit<PoolLazyOptions, 'load'> = {},
    /** The write layer's pending display (`write/overlay.ts`), read by the pool's one reader. */
    writes?: WriteSeam,
  ): MobxPoolHandle {
    const row = source.row?.bind(source)
    if (row === undefined) {
      throw new Error(
        '[pool] the feed has no per-row read (RowSource.row): a lazy pool cannot load a cold row',
      )
    }
    const pool = new MobxPool(locals.get(), undefined, { ...loader, load: row }, writes)
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
