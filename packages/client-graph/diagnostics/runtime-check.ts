/** Only the opted-in app attachment imports this module. No subscriptions or
 * comparison in mount/render: the first and subsequent runs are timer jobs.
 */
import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import { beginSidebarCheck, reportSidebarCheck, sidebarPerfFor } from '@podium/client-core/perf'
import { runInAction } from 'mobx'
import type { MobxPool } from '../src/pool'
import type { SidebarState } from '../src/worklist/sidebar'
import { checkSidebar, type SidebarCheckResult } from './sidebar-check'

export function startSidebarCheck(
  runtime: { getSnapshot(): Store<PodiumClientApi> },
  pool: MobxPool,
  options: { intervalMs?: number; state?: (store: Store<PodiumClientApi>) => SidebarState; report?: (result: SidebarCheckResult) => void } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 5000
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Sidebar check interval must be positive')
  let disposed = false, checks = 0
  reportSidebarCheck(runtime, { state: 'waiting', differences: 0, checkedAt: null })
  const tick = (): void => {
    if (disposed) return
    const endCheck = beginSidebarCheck(runtime)
    const start = performance.now()
    try {
      reportSidebarCheck(runtime, { state: 'checking', differences: 0, checkedAt: null })
      const result = runInAction(() => {
        const store = runtime.getSnapshot()
        return checkSidebar(pool, store, options.state?.(store))
      })
      checks += 1
      reportSidebarCheck(runtime, { state: result.differences > 0 ? 'different' : result.pending > 0 ? 'waiting' : 'match',
        differences: result.differences, checkedAt: pool.clock.current, checks, first: result.first })
      options.report?.(result)
      sidebarPerfFor(runtime)?.record({ rows: result.rows, derivations: 1, start, end: performance.now() })
    } catch {
      // Do not leak exceptions carrying live data into the console or report.
      reportSidebarCheck(runtime, { state: 'error', differences: 0, checkedAt: pool.clock.current, checks })
    } finally { endCheck() }
    if (!disposed) timer = setTimeout(tick, intervalMs)
  }
  let timer = setTimeout(tick, intervalMs)
  return () => {
    if (disposed) return
    disposed = true
    clearTimeout(timer)
    reportSidebarCheck(runtime, { state: 'off', differences: 0, checkedAt: null })
  }
}
