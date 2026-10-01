import { bindSidebarPerf, createSidebarPerf } from '@podium/client-core/perf'
import type { MobxPool } from '@podium/client-graph/pool'
import { startSidebarCheck } from '@podium/client-graph/diagnostics/runtime-check'
import { checkSidebar } from '@podium/client-graph/diagnostics/sidebar-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@podium/client-graph/diagnostics/sidebar-check', () => ({ checkSidebar: vi.fn() }))
const result = { differences: 0, first: null, pending: 0, rows: 4, sections: 2 }
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

describe('periodic sidebar diagnostic', () => {
  it('runs only on the timer, counts separately, and stops with its owner', () => {
    vi.useFakeTimers()
    vi.mocked(checkSidebar).mockReturnValue(result)
    const runtime = { getSnapshot: vi.fn(() => ({})) } as unknown as Parameters<typeof startSidebarCheck>[0]
    const pool = { clock: { current: 42 } } as MobxPool
    const perf = createSidebarPerf()
    const close = bindSidebarPerf(runtime, perf)
    const stop = startSidebarCheck(runtime, pool, { intervalMs: 1000 })
    try {
      expect(runtime.getSnapshot).not.toHaveBeenCalled()
      for (let read = 0; read < 50; read += 1) perf.read()
      expect(checkSidebar).not.toHaveBeenCalled()
      vi.advanceTimersByTime(999)
      expect(checkSidebar).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(checkSidebar).toHaveBeenCalledExactlyOnceWith(pool, {}, undefined)
      expect(perf.read()).toMatchObject({ idle: { rows: 0, derivations: 0 }, checkWork: { rows: 4, derivations: 1 }, check: { state: 'match', checks: 1 } })
      vi.advanceTimersByTime(1000)
      expect(checkSidebar).toHaveBeenCalledTimes(2)
      stop(); stop()
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(10_000)
      expect(checkSidebar).toHaveBeenCalledTimes(2)
      expect(perf.read().check.state).toBe('off')
    } finally { stop(); close() }
  })

  it('reports loading, the first difference, and errors without exception text', () => {
    vi.useFakeTimers()
    const runtime = { getSnapshot: () => ({}) } as unknown as Parameters<typeof startSidebarCheck>[0]
    const perf = createSidebarPerf(), close = bindSidebarPerf(runtime, perf)
    const pool = { clock: { current: 42 } } as MobxPool
    const stop = startSidebarCheck(runtime, pool)
    try {
      vi.mocked(checkSidebar).mockReturnValue({ ...result, pending: 1 })
      vi.advanceTimersByTime(5000)
      expect(perf.read().check.state).toBe('waiting')
      const first = { section: 'pinned', sectionIndex: 0, rowIndex: 0, expectedId: 'one', actualId: 'two', field: 'id' }
      vi.mocked(checkSidebar).mockReturnValue({ ...result, differences: 1, first })
      vi.advanceTimersByTime(5000)
      expect(perf.read().check).toMatchObject({ state: 'different', first })
      vi.mocked(checkSidebar).mockImplementation(() => { throw new Error('private title') })
      vi.advanceTimersByTime(5000)
      expect(perf.read().check.state).toBe('error')
      expect(JSON.stringify(perf.read())).not.toContain('private title')
    } finally { stop(); close() }
  })
})
