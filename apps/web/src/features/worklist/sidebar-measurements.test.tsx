import {
  beginSwitch,
  captureSidebarSwitchInput,
  createSidebarPerf,
  getRecentSwitchTraces,
  markSwitch,
  resetSwitchTraces,
} from '@podium/client-core/perf'
import { asSessionId } from '@podium/model/browser'
import { SWITCH_TRACE_MARKS } from '@podium/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { memo } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarPerfReadout } from './SidebarPerfPanel'

afterEach(() => {
  cleanup()
  resetSwitchTraces()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('sidebar measurement boundary', () => {
  it('counts committed row bodies without counting memo skips or panel samples', async () => {
    vi.resetModules()
    const { bindSidebarRowMeasurements, measureSidebarRow } =
      await import('./sidebar-measurements')
    const perf = createSidebarPerf()
    const stop = bindSidebarRowMeasurements({ owner: {}, perf })
    const Row = memo(measureSidebarRow(({ text }: { text: string }) => <div>{text}</div>))
    try {
      const view = render(<Row text="one" />)
      expect(perf.read().idle.rows).toBe(1)
      for (let i = 0; i < 20; i++) perf.read()
      view.rerender(<Row text="one" />)
      expect(perf.read().idle.rows).toBe(1)
      view.rerender(<Row text="two" />)
      expect(perf.read().idle.rows).toBe(2)
    } finally {
      stop()
    }
  })

  it('captures real DOM click/keyboard routing through paint, scopes sidebar samples, and detaches', async () => {
    const { observeSidebarInputs } = await import('./sidebar-measurements')
    let at = 100
    const perf = createSidebarPerf(() => at)
    const paints: Array<() => void> = []
    const stop = observeSidebarInputs(perf, (done) => paints.push(done))
    render(
      <>
        <div data-sidebar-shell>
          <button type="button">Row</button>
        </div>
        <button type="button">Other</button>
        <div data-perf-panel>
          <button type="button">Panel</button>
        </div>
      </>,
    )
    fireEvent.click(screen.getByText('Row'))
    perf.record({ rows: 1 })
    expect(perf.read().idle.rows).toBe(0)
    at = 200
    paints.splice(0).forEach((done) => {
      done()
    })
    fireEvent.keyDown(screen.getByText('Row'), { key: 'Enter' })
    fireEvent.click(screen.getByText('Row'), { detail: 0 })
    at = 300
    paints.splice(0).forEach((done) => {
      done()
    })
    expect(perf.read().input.count).toBe(2)
    fireEvent.click(screen.getByText('Other'))
    fireEvent.click(screen.getByText('Panel'))
    paints.splice(0).forEach((done) => {
      done()
    })
    expect(perf.read().input.count).toBe(2)
    stop()
    fireEvent.click(screen.getByText('Row'))
    expect(paints).toHaveLength(0)
    perf.record({ rows: 1 })
    expect(perf.read().idle.rows).toBe(1)
  })

  it('crosses two animation frames and cancels outstanding callbacks on close', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let id = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
    const { createPaintBoundary } = await import('./sidebar-measurements')
    const boundary = createPaintBoundary()
    const done = vi.fn()
    boundary.afterPaint(done)
    frames.get(1)?.(1)
    expect(done).not.toHaveBeenCalled()
    frames.get(2)?.(2)
    expect(done).toHaveBeenCalledOnce()
    boundary.afterPaint(done)
    boundary.dispose()
    expect(frames.has(3)).toBe(false)
  })

  it('reports disconnected sources honestly and shows a planted one-row timer', () => {
    const perf = createSidebarPerf(() => 60_000)
    const props = {
      report: perf.read(),
      heap: null,
      onClose: () => {},
    }
    const view = render(<SidebarPerfReadout {...props} />)
    expect(screen.getByTestId('perf-idle').textContent).toBe('Waiting for pool counters')
    expect(screen.getByTestId('perf-memory').textContent).toContain('unavailable')
    perf.pool(true, 12)
    perf.record({ rows: 1, start: 1, end: 2 })
    view.rerender(<SidebarPerfReadout {...props} report={perf.read()} />)
    expect(screen.getByTestId('perf-idle').textContent).toContain('1 rows redrawn')
    expect(screen.getByTestId('perf-memory').textContent).toContain('12')
    expect(screen.getByTestId('perf-check').textContent).toContain('Off')
  })

  it('starts the reused switch trace at the captured input and preserves the paint mark', () => {
    const sessionId = asSessionId('synthetic-sidebar-input')
    const paint = captureSidebarSwitchInput(performance.now() - 50)
    beginSwitch({ sessionId })
    markSwitch(sessionId, SWITCH_TRACE_MARKS.chatInteractable)
    expect(getRecentSwitchTraces()).toHaveLength(0)
    act(() => paint())
    const [trace] = getRecentSwitchTraces()
    expect(trace?.totalMs).toBeGreaterThanOrEqual(50)
    expect(trace?.marks.some((mark) => mark.name === 'sidebar:input-paint')).toBe(true)
  })
})
