import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import { bindSidebarPerf, createSidebarPerf, requestSidebarCheck } from '@podium/client-core/perf'
import type { MobxPool } from '@podium/client-graph/pool'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { startSidebarCheck } from '@podium/client-graph/diagnostics/runtime-check'
import { checkSidebar } from '@podium/client-graph/diagnostics/sidebar-check'
import { tracked } from '../../../../packages/worklist-proto/harness/src/adapters/mobx-pool'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startScenarioEngine } from '../../../../packages/worklist-proto/shared/src/scenarios'

vi.mock('@podium/client-graph/diagnostics/sidebar-check', async importOriginal => {
  const actual = await importOriginal<typeof import('@podium/client-graph/diagnostics/sidebar-check')>()
  return { ...actual, checkSidebar: vi.fn(actual.checkSidebar) }
})
const result = { differences: 0, first: null, pending: 0, rows: 4, sections: 2 }
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
beforeEach(() => { fakeTimers(); vi.mocked(checkSidebar).mockReturnValue(result) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals() })

function diagnostic(options: Parameters<typeof startSidebarCheck>[2] = { startup: false }) {
  const getAccess = vi.fn(() => ({}))
  const runtime = { get access() { return getAccess() }, getAccess } as unknown as Parameters<typeof startSidebarCheck>[0] & { getAccess: typeof getAccess }
  const pool = { clock: { current: 42 } } as MobxPool
  const perf = createSidebarPerf()
  const close = bindSidebarPerf(runtime, perf)
  const stop = startSidebarCheck(runtime, pool, options)
  return { runtime, pool, perf, stop, dispose: () => { stop(); close() } }
}

describe('on-demand sidebar diagnostic', () => {
  it('runs once with the startup switch on, then does no comparison during 60 seconds idle', () => {
    const { runtime, pool, perf, dispose } = diagnostic({ startup: true })
    try {
      expect(runtime.getAccess).not.toHaveBeenCalled()
      for (let read = 0; read < 50; read += 1) perf.read()
      vi.advanceTimersByTime(4999)
      expect(checkSidebar).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(checkSidebar).toHaveBeenCalledExactlyOnceWith(pool, {}, undefined)
      expect(perf.read()).toMatchObject({ idle: { rows: 0, derivations: 0 }, checkWork: { rows: 4, derivations: 1 }, check: { state: 'match', checks: 1 } })
      vi.advanceTimersByTime(60_000)
      expect(checkSidebar).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(runtime.getAccess).toHaveBeenCalledTimes(1)
      expect(perf.read().check).toMatchObject({ state: 'match', checks: 1 })
    } finally { dispose() }
  })

  it('runs only after an explicit request without the switch, coalesces clicks, and unregisters on disposal', () => {
    const { runtime, perf, stop, dispose } = diagnostic()
    try {
      vi.advanceTimersByTime(60_000)
      expect(checkSidebar).not.toHaveBeenCalled()
      expect(perf.read().check.state).toBe('ready')
      expect(requestSidebarCheck({})).toBe(false)
      expect(requestSidebarCheck(runtime)).toBe(true)
      expect(requestSidebarCheck(runtime)).toBe(false)
      expect(perf.read().check.state).toBe('queued')
      expect(checkSidebar).not.toHaveBeenCalled()
      vi.advanceTimersByTime(250)
      expect(checkSidebar).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(60_000)
      expect(checkSidebar).toHaveBeenCalledTimes(1)
      expect(requestSidebarCheck(runtime)).toBe(true)
      stop(); stop()
      expect(vi.getTimerCount()).toBe(0)
      expect(requestSidebarCheck(runtime)).toBe(false)
      vi.advanceTimersByTime(60_000)
      expect(checkSidebar).toHaveBeenCalledTimes(1)
      expect(perf.read().check.state).toBe('off')
    } finally { dispose() }
  })

  it.each([
    ['key', () => new KeyboardEvent('keydown', { code: 'KeyA' }), () => new KeyboardEvent('keyup', { code: 'KeyA' })],
    ['drag', () => new PointerEvent('pointerdown', { pointerId: 7 }), () => new PointerEvent('pointerup', { pointerId: 7 })],
    ['composition', () => new Event('compositionstart'), () => new Event('compositionend')],
  ] as const)('defers a startup check through an active %s and its quiet period', (_, begin, end) => {
    const { dispose } = diagnostic({ startup: true })
    try {
      vi.advanceTimersByTime(4900)
      window.dispatchEvent(begin())
      vi.advanceTimersByTime(1000)
      expect(checkSidebar).not.toHaveBeenCalled()
      window.dispatchEvent(end())
      vi.advanceTimersByTime(249)
      expect(checkSidebar).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(checkSidebar).toHaveBeenCalledTimes(1)
    } finally { dispose() }
  })

  it('waits for wheel/scroll/input activity, pending input dispatch and input-to-paint work', () => {
    const { runtime, perf, dispose } = diagnostic()
    const isInputPending = vi.fn(() => true)
    vi.stubGlobal('navigator', { scheduling: { isInputPending } })
    try {
      const token = perf.beginInput()
      requestSidebarCheck(runtime)
      vi.advanceTimersByTime(250)
      expect(checkSidebar).not.toHaveBeenCalled()
      perf.endInput(token, 0, false)
      vi.advanceTimersByTime(250)
      expect(checkSidebar).not.toHaveBeenCalled()
      expect(isInputPending).toHaveBeenCalledWith({ includeContinuous: true })
      isInputPending.mockReturnValue(false)
      for (const type of ['wheel', 'scroll', 'input']) {
        window.dispatchEvent(new Event(type))
        vi.advanceTimersByTime(200)
        expect(checkSidebar).not.toHaveBeenCalled()
      }
      vi.advanceTimersByTime(50)
      expect(checkSidebar).toHaveBeenCalledTimes(1)
    } finally { dispose() }
  })

  it('reports loading, settled differences with pending rows, matches and errors on request', () => {
    const report = vi.fn()
    const { runtime, perf, dispose } = diagnostic({ startup: false, report })
    const first = { section: 'pinned', sectionIndex: 0, rowIndex: 1, expectedId: 'settled', actualId: 'settled', field: 'color' }
    const mixed = { ...result, pending: 1, differences: 1, first }
    const run = () => { requestSidebarCheck(runtime); vi.advanceTimersByTime(250) }
    try {
      vi.mocked(checkSidebar).mockReturnValue({ ...result, pending: 1 })
      run()
      expect(perf.read().check.state).toBe('waiting')
      vi.mocked(checkSidebar).mockReturnValue(mixed)
      run()
      expect(perf.read().check).toMatchObject({ state: 'different', differences: 1, first })
      expect(report).toHaveBeenLastCalledWith(mixed)
      vi.mocked(checkSidebar).mockReturnValue(result)
      run()
      expect(perf.read().check).toMatchObject({ state: 'match', differences: 0, first: null })
      vi.mocked(checkSidebar).mockImplementation(() => { vi.advanceTimersByTime(200); throw new Error('private title') })
      run()
      expect(perf.read().check).toMatchObject({ state: 'error', durationMs: 200, first: null })
      expect(perf.read().checkWork.mainThreadMs).toBe(200)
      expect(JSON.stringify(perf.read())).not.toContain('private title')
    } finally { dispose() }
  })

  it('retains the last duration on late panel open after rolling work expires', () => {
    const { runtime, perf, dispose } = diagnostic()
    vi.mocked(checkSidebar).mockImplementation(() => { vi.advanceTimersByTime(450); return result })
    try {
      requestSidebarCheck(runtime)
      vi.advanceTimersByTime(250)
      expect(perf.read()).toMatchObject({ idle: { mainThreadMs: 0 }, checkWork: { mainThreadMs: 450 }, check: { durationMs: 450, checks: 1 } })
      vi.advanceTimersByTime(60_000)
      expect(perf.read().checkWork.mainThreadMs).toBe(0)
      const later = createSidebarPerf()
      const close = bindSidebarPerf(runtime, later)
      try {
        expect(later.read().check).toMatchObject({ state: 'match', durationMs: 450, checks: 1 })
      } finally { close() }
    } finally { dispose() }
  })

  it('a requested check reports a planted difference through the real strict comparator', async () => {
    vi.useRealTimers()
    const actual = await vi.importActual<typeof import('@podium/client-graph/diagnostics/sidebar-check')>('@podium/client-graph/diagnostics/sidebar-check')
    vi.mocked(checkSidebar).mockImplementation(actual.checkSidebar)
    const ctx = await startScenarioEngine(1)
    const handle = createRuntimeWorklistPool(ctx.engine)
    const state = (store: ReturnType<typeof referenceState>) => ({
      pinnedRepos: store.pins.repos, pinnedWorktrees: store.pins.worktrees, projectOrder: store.sidebarSettings.repoOrder,
    })
    let stop = () => {}, close = () => {}
    try {
      for (let round = 0; round < 64; round += 1) {
        tracked(() => actual.checkSidebar(handle.pool, referenceState(ctx.engine), state(referenceState(ctx.engine))))
        if (handle.pool.hydrate() === 0) break
      }
      expect(tracked(() => actual.checkSidebar(handle.pool, referenceState(ctx.engine), state(referenceState(ctx.engine))))).toMatchObject({ differences: 0, pending: 0 })
      const sections = handle.pool.sidebar.sections.bind(handle.pool.sidebar)
      vi.spyOn(handle.pool.sidebar, 'sections').mockImplementation(layout => ({ ...sections(layout), pinnedCollapsed: !sections(layout).pinnedCollapsed }))
      const perf = createSidebarPerf()
      close = bindSidebarPerf(ctx.engine, perf)
      stop = startSidebarCheck(ctx.engine, handle.pool, { startup: false, state })
      expect(requestSidebarCheck(ctx.engine)).toBe(true)
      expect(perf.read().check.state).toBe('queued')
      await vi.waitFor(() => expect(perf.read().check).toMatchObject({ state: 'different', differences: 1,
        first: { section: 'pinned', rowIndex: null, field: 'collapsed' } }))
    } finally { stop(); close(); handle.dispose(); ctx.engine.destroy() }
  })
})
