import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
/** Only a pool-backed app attachment imports this module. Comparisons run once
 * per request, outside input handling; the opt-in switch requests one at startup.
 */
import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import {
  beginSidebarCheck,
  bindSidebarCheckRequest,
  reportSidebarCheck,
  sidebarPerfFor,
  type SidebarCheckReport,
} from '@podium/client-core/perf'
import { runInAction } from 'mobx'
import type { MobxPool } from '../src/pool'
import type { SidebarState } from '../src/worklist/sidebar'
import { checkSidebar, type SidebarCheckResult } from './sidebar-check'

const INPUT_QUIET_MS = 250
const inputEvents = ['pointerdown', 'pointerup', 'pointercancel', 'pointermove', 'keydown', 'keyup',
  'beforeinput', 'input', 'click', 'wheel', 'scroll', 'compositionstart', 'compositionend', 'blur'] as const

export function startSidebarCheck(
  runtime: { readonly access: Store<PodiumClientApi> },
  pool: MobxPool,
  options: { startup?: boolean; startupDelayMs?: number; state?: (store: Store<PodiumClientApi>) => SidebarState; report?: (result: SidebarCheckResult) => void } = {},
): () => void {
  const startupDelayMs = options.startupDelayMs ?? 5000
  if (!Number.isFinite(startupDelayMs) || startupDelayMs < 0) throw new Error('Sidebar check startup delay must be nonnegative')
  let disposed = false, queued = false, checks = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let earliestAt = 0, quietUntil = 0, composing = false
  const pointers = new Set<number>(), keys = new Set<string>()
  let report: SidebarCheckReport = { state: 'ready', differences: 0, checkedAt: null }
  const publish = (state: SidebarCheckReport['state']): void => reportSidebarCheck(runtime, { ...report, state })
  const inputPending = (): boolean => composing || pointers.size > 0 || keys.size > 0
    || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    || sidebarPerfFor(runtime)?.inputPending() === true
    || (typeof navigator !== 'undefined' && (navigator as Navigator & {
      scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean }
    }).scheduling?.isInputPending({ includeContinuous: true }) === true)

  const tick = (): void => {
    timer = undefined
    if (disposed || !queued) return
    const delay = Math.max(earliestAt, quietUntil) - performance.now()
    if (delay > 0 || inputPending()) {
      schedule(Math.max(INPUT_QUIET_MS, delay))
      return
    }
    queued = false
    publish('checking')
    const endCheck = beginSidebarCheck(runtime)
    const start = performance.now()
    let result: SidebarCheckResult | undefined
    try {
      result = runInAction(() => {
        const store = referenceState(runtime)
        return checkSidebar(pool, store, options.state?.(store))
      })
      checks += 1
      report = { state: result.differences > 0 ? 'different' : result.pending > 0 ? 'waiting' : 'match',
        differences: result.differences, checkedAt: pool.clock.current, checks, first: result.first }
      options.report?.(result)
    } catch {
      // Do not leak exceptions carrying live data into the console or report.
      report = { state: 'error', differences: 0, checkedAt: pool.clock.current, checks, first: null }
    } finally {
      const end = performance.now()
      report = { ...report, durationMs: end - start }
      sidebarPerfFor(runtime)?.record({ rows: result?.rows ?? 0, derivations: 1, start, end })
      endCheck()
      if (!disposed) publish(report.state)
    }
    // No follow-up timer: another comparison requires another explicit request.
  }
  const schedule = (delay: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(tick, delay)
  }
  const request = (delay = INPUT_QUIET_MS): boolean => {
    if (disposed || queued) return false
    queued = true
    earliestAt = performance.now() + delay
    publish('queued')
    schedule(delay)
    return true
  }
  const input = (event: Event): void => {
    if (event.type === 'pointerdown') pointers.add((event as PointerEvent).pointerId)
    if (event.type === 'pointerup' || event.type === 'pointercancel') pointers.delete((event as PointerEvent).pointerId)
    if (event.type === 'keydown') keys.add((event as KeyboardEvent).code)
    if (event.type === 'keyup') keys.delete((event as KeyboardEvent).code)
    if (event.type === 'compositionstart') composing = true
    if (event.type === 'compositionend') composing = false
    if (event.type === 'blur' && event.target === window) { pointers.clear(); keys.clear(); composing = false }
    quietUntil = performance.now() + INPUT_QUIET_MS
    if (queued) schedule(Math.max(INPUT_QUIET_MS, earliestAt - performance.now()))
  }
  if (typeof window !== 'undefined') {
    for (const event of inputEvents) window.addEventListener(event, input, { capture: true, passive: true })
  }
  const unbind = bindSidebarCheckRequest(runtime, () => request())
  publish('ready')
  if (options.startup !== false) request(startupDelayMs)
  return () => {
    if (disposed) return
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    unbind()
    if (typeof window !== 'undefined') {
      for (const event of inputEvents) window.removeEventListener(event, input, true)
    }
    reportSidebarCheck(runtime, { state: 'off', differences: 0, checkedAt: null })
  }
}
