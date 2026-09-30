/** Prototype mounts over the product pool's lifecycle; never imported by apps. */
import { createElement, lazy, type ReactElement, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createWorklistPool, type WorklistPoolHandle } from '@podium/client-graph'
import type { LocalsSource, RowSource } from '@podium/client-graph/shared/source'
import type { PoolLazyOptions, WriteSeam } from '@podium/client-graph/pool'
import { CommitLogContext, currentCommitLog } from '../../../shared/src/row-shell'
import { PoolList } from './react/list'

const PoolNativeList = lazy(() => import('./native/list'))

export interface MobxPoolHandle extends WorklistPoolHandle {
  mountWeb(el: Element): () => void
  mountNative(): ReactElement
}

/** The demo UI and commit-log propagation belong to the prototype harness. */
export function mountMobxPool(handle: WorklistPoolHandle): MobxPoolHandle {
  const { pool } = handle
  const roots = new Set<Root>()
  return {
    pool,
    dispose(): void {
      for (const root of roots) root.unmount()
      roots.clear()
      handle.dispose()
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
}

export const mobxPoolArm = {
  create(
    source: RowSource,
    locals: LocalsSource,
    loader: Omit<PoolLazyOptions, 'load'> = {},
    writes?: WriteSeam,
  ): MobxPoolHandle {
    return mountMobxPool(createWorklistPool(source, locals, loader, writes))
  },
}
