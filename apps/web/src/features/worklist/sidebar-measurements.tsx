import {
  cancelSidebarSwitchInput,
  captureSidebarSwitchInput,
  recordStoreRowRedraw,
  type SidebarPerf,
} from '@podium/client-core/perf'
import type { JSX } from 'react'
import { useLayoutEffect } from 'react'
import { sidebarDataLayer } from '@/lib/sidebar-data-layer'

let requested: boolean | undefined
/** Called beside the data-layer latch at boot, never flipped under mounted hooks. */
export function initializeSidebarMeasurements(): void {
  if (requested !== undefined) return
  requested =
    sidebarDataLayer() === 'pool' || new URLSearchParams(location.search).get('perfPanel') === '1'
}
export function sidebarMeasurementsRequested(): boolean {
  return requested ?? false
}

let active: { owner: object; mode: 'legacy' | 'pool'; perf: SidebarPerf } | null = null
export function bindSidebarRowMeasurements(binding: NonNullable<typeof active>): () => void {
  active = binding
  return () => {
    if (active === binding) active = null
  }
}

/** An opt-in wrapper around the REAL row body, preserving its hooks and memo
 * boundary. It counts committed renders (including no-DOM-change redraws), and
 * works in production React without the development-only Profiler callback.
 * The boot latch makes the hook sequence fixed until the page is reloaded. */
export function measureSidebarRow<P>(Row: (props: P) => JSX.Element): (props: P) => JSX.Element {
  function MeasuredRow(props: P): JSX.Element {
    const binding = active
    const start = binding ? performance.now() : undefined
    const element = Row(props)
    const end = start === undefined ? undefined : performance.now()
    useLayoutEffect(() => {
      if (!binding || active !== binding || start === undefined || end === undefined) return
      if (binding.mode === 'legacy') recordStoreRowRedraw(binding.owner, start, end)
      else binding.perf.record({ rows: 1, start, end })
    })
    return element
  }
  return function SidebarRow(props: P): JSX.Element {
    return requested ? MeasuredRow(props) : Row(props)
  }
}

/** Two rAFs cross the first browser paint; only gesture/update work schedules
 * these. The panel's own sampling never schedules a sidebar paint. */
export function createPaintBoundary() {
  const frames = new Set<number>()
  return {
    afterPaint(done: () => void): void {
      const first = requestAnimationFrame(() => {
        frames.delete(first)
        const second = requestAnimationFrame(() => {
          frames.delete(second)
          done()
        })
        frames.add(second)
      })
      frames.add(first)
    },
    dispose(): void {
      for (const frame of frames) cancelAnimationFrame(frame)
      frames.clear()
    },
  }
}

export function observeSidebarInputs(
  perf: SidebarPerf,
  afterPaint: (done: () => void) => void,
): () => void {
  const input = (event: Event): void => {
    // Panel interactions never count as sidebar work. All other app input
    // excludes the causal input→paint interval from the idle bucket.
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('[data-perf-panel]')) return
    const sidebar =
      target?.closest('[data-sidebar-shell], .worklist-column, [data-testid="sidebar-rail"]') !==
        null && target !== null
    const now = performance.now()
    const stamp =
      event.timeStamp > performance.timeOrigin
        ? event.timeStamp - performance.timeOrigin
        : event.timeStamp
    const at = stamp > 0 && stamp <= now ? stamp : now
    const token = perf.beginInput()
    const markPaint = sidebar ? captureSidebarSwitchInput(at) : null
    afterPaint(() => {
      perf.endInput(token, at, sidebar)
      markPaint?.()
    })
  }
  window.addEventListener('click', input, true)
  window.addEventListener('keydown', input, true)
  return () => {
    window.removeEventListener('click', input, true)
    window.removeEventListener('keydown', input, true)
    cancelSidebarSwitchInput()
  }
}
