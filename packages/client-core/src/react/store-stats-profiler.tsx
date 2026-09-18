import { Profiler, type ReactNode } from 'react'
import { recordStoreReactCommit } from '../perf/store-stats'
import { useStoreHandle } from './provider'

/** Explicit diagnostic boundary. Mount inside StoreProvider around ONE measured
 * subtree. React profiling builds/dev only; production React may omit callbacks.
 * No automatic wrapper is added to the product tree. */
export function StoreStatsProfiler({ children }: { children: ReactNode }) {
  const handle = useStoreHandle()
  return (
    <Profiler id="store-stats" onRender={() => recordStoreReactCommit(handle)}>
      {children}
    </Profiler>
  )
}
