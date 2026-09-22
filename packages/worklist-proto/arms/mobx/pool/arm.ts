/**
 * POD-4565 (Ma1) — the round-three MobX arm over the pool: a `CheckableArm`
 * (`shared/src/arm.ts`). See `../README.md` ("Round three: the pool") for the
 * idiom, the write path and how to add a field.
 *
 * `create` seeds the pool from the feed's snapshot (one `replace`), then
 * follows the feed (`RowSource`) and the locals channel (`LocalsSource`),
 * waking only what each notification names. No JSX here: this module builds
 * the pool, and the lint fence keeps store modules out of component files.
 */

import { createElement, lazy, type ReactElement, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CheckableArm, CheckableArmHandle, LocalsSource, RowSource } from '../../../shared/src/arm'
import { DISABLED_READ_FENCE, type ReadFence } from '../../../shared/src/instrument/reads'
import { CommitLogContext, currentCommitLog } from '../../../shared/src/row-shell'
import { MobxPool } from './pool'
import { PoolList } from './react/list'
import { rebuildSnapshot } from './rebuild'

/** Loaded on first native mount only: the node lanes cannot parse `react-native`. */
const PoolNativeList = lazy(() => import('./native/list'))

export interface MobxPoolHandle extends CheckableArmHandle {
  /** The live pool (tests; the copy sweep reaches the tables through it). */
  readonly pool: MobxPool
}

export const mobxPoolArm: CheckableArm & {
  create(source: RowSource, locals: LocalsSource, reads?: ReadFence): MobxPoolHandle
} = {
  create(source: RowSource, locals: LocalsSource, reads: ReadFence = DISABLED_READ_FENCE): MobxPoolHandle {
    const pool = new MobxPool(reads, locals.get())
    pool.apply({
      type: 'replace',
      rows: [...source.snapshot('session'), ...source.snapshot('issue'), ...source.snapshot('worktree')],
    })
    const offRows = source.subscribe((event) => pool.apply(event))
    const offLocals = locals.subscribe((changed) => pool.applyLocals(locals.get(), changed))
    const roots = new Set<Root>()
    return {
      pool,
      stats: pool.stats,
      snapshot: () => pool.snapshot(),
      rebuildFromScratch: () => rebuildSnapshot(source, locals),
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
        root.render(createElement(CommitLogContext.Provider, { value: currentCommitLog() }, createElement(PoolList, { pool })))
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
