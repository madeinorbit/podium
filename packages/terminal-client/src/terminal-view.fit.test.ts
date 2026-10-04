// @vitest-environment happy-dom
//
// Unit-guards for the MEASUREMENT seam's zero-size / not-ready detection.
// The key invariant: when a container has zero dimensions (hidden tab, collapsed
// panel), a proposal must be `undefined` rather than a stale grid — a caller that
// received one would ask the agent for a size nobody is looking at.
//
// POD-3239 deleted `TerminalView.fit()`, which MEASURED AND APPLIED in one call.
// Applying a local measurement is what MODEL rule 2 forbids, so what is left is
// `proposeFit` / `proposeFitIn`, and the guards below moved onto them.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TerminalView } from './terminal-view'

beforeAll(() => {
  // xterm's renderer (and FitAddon) touch ResizeObserver; supply a no-op stub.
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** happy-dom cannot measure glyphs; supply the renderer's primitive measurement. */
function deviceCell(view: TerminalView, width: number, height: number) {
  const service = (
    view as unknown as {
      term: {
        _core: {
          _renderService: {
            readonly dimensions: { device: { cell: { width: number; height: number } } }
          }
        }
      }
    }
  ).term._core._renderService
  const dimensions = service.dimensions
  const cell = { width, height }
  vi.spyOn(service, 'dimensions', 'get').mockImplementation(() => ({
    ...dimensions,
    device: { ...dimensions.device, cell },
  }))
  return cell
}

describe('TerminalView.isFittable()', () => {
  it('keeps the DOM renderer when explicitly selected for a crop viewport', () => {
    const events: Array<{ event: string; reason?: unknown }> = []
    const view = new TerminalView({
      renderer: 'dom',
      diagnostics: (event, data) => events.push({ event, reason: data?.reason }),
    })
    view.mount(document.createElement('div'))

    expect(events).toContainEqual({ event: 'renderer:dom', reason: 'renderer-selected' })
    view.dispose()
  })

  it('returns false before mount', () => {
    const view = new TerminalView()
    expect(view.isFittable()).toBe(false)
  })

  it('returns false when mounted into a zero-size element (hidden tab)', () => {
    const el = document.createElement('div')
    // Default DOM elements in happy-dom have zero layout dimensions
    const view = new TerminalView()
    view.mount(el)
    expect(view.isFittable()).toBe(false)
    view.dispose()
  })

  it('returns true when mounted into an element with real dimensions', () => {
    const el = document.createElement('div')
    // happy-dom doesn't do real layout; stub the properties directly
    Object.defineProperty(el, 'clientWidth', { get: () => 800, configurable: true })
    Object.defineProperty(el, 'clientHeight', { get: () => 480, configurable: true })
    const view = new TerminalView()
    view.mount(el)
    expect(view.isFittable()).toBe(true)
    view.dispose()
  })
})

describe('the measurement seam’s readiness guard', () => {
  it('proposes a fitted grid without resizing the terminal', () => {
    const el = document.createElement('div')
    const view = new TerminalView()
    view.mount(el)
    const fa = (view as unknown as { fitAddon: { proposeDimensions(): unknown; fit(): void } })
      .fitAddon
    fa.proposeDimensions = () => ({ cols: 52, rows: 28 })
    let fitCalls = 0
    fa.fit = () => {
      fitCalls += 1
    }

    expect(view.proposeFit()).toEqual({ cols: 52, rows: 28 })
    expect(fitCalls).toBe(0)
    expect({ cols: view.cols(), rows: view.rows() }).toEqual({ cols: 80, rows: 24 })
    view.dispose()
  })

  it('proposes a grid for an outer crop viewport independently of the terminal host', () => {
    const host = document.createElement('div')
    const viewport = document.createElement('div')
    const view = new TerminalView()
    view.mount(host)
    const screen = host.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) throw new Error('xterm screen is unavailable')
    screen.getBoundingClientRect = () => ({ width: 800, height: 480 }) as DOMRect
    viewport.getBoundingClientRect = () => ({ width: 400, height: 240 }) as DOMRect
    deviceCell(view, 10, 20)

    expect(view.proposeFitIn(viewport)).toEqual({ cols: 40, rows: 12 })
    expect({ cols: view.cols(), rows: view.rows() }).toEqual({ cols: 80, rows: 24 })
    view.dispose()
  })

  it('settles a fractional viewport instead of alternating 113 and 114 columns after each resize', () => {
    const host = document.createElement('div')
    const viewport = document.createElement('div')
    viewport.style.padding = '12px 13px 20px'
    document.body.append(viewport)
    const view = new TerminalView({ renderer: 'dom', cols: 114, rows: 39 })
    view.mount(host)
    deviceCell(view, 9.03076171875, 20)
    const screen = host.querySelector<HTMLElement>('.xterm-screen')!
    // Real DOM renderer measurements from the POD-5560 scrollbar reproduction:
    // screen(113)=1020px, screen(114)=1030px, available width=1029.265625px.
    // The old division by current columns alternates forever at this fixed box.
    screen.getBoundingClientRect = () =>
      ({
        width: Math.round(view.cols() * 9.03076171875),
        height: view.rows() * 20,
      }) as DOMRect
    viewport.getBoundingClientRect = () => ({ width: 1055.265625, height: 824 }) as DOMRect

    const proposals = []
    for (let i = 0; i < 8; i++) {
      const grid = view.proposeFitIn(viewport)!
      proposals.push(grid)
      view.resize(grid.cols, grid.rows)
    }
    expect(proposals).toEqual(Array.from({ length: 8 }, () => ({ cols: 113, rows: 39 })))
    view.dispose()
    viewport.remove()
  })

  it('uses device density and fresh cell metrics without waiting for the resized screen to paint', () => {
    vi.stubGlobal('devicePixelRatio', 1.25)
    const host = document.createElement('div')
    const viewport = document.createElement('div')
    const view = new TerminalView({ renderer: 'dom' })
    view.mount(host)
    const cell = deviceCell(view, 11, 25)
    const screen = host.querySelector<HTMLElement>('.xterm-screen')!
    // Keep the old screen pixels even as an asynchronous server resize changes W.
    screen.getBoundingClientRect = () => ({ width: 704, height: 480 }) as DOMRect
    viewport.getBoundingClientRect = () => ({ width: 900, height: 500 }) as DOMRect

    expect(view.proposeFitIn(viewport)).toEqual({ cols: 102, rows: 25 })
    view.resize(102, 25)
    expect(view.proposeFitIn(viewport)).toEqual({ cols: 102, rows: 25 })
    // A new font/renderer measurement takes effect at the same viewport size.
    cell.width = 12.5
    cell.height = 31.25
    expect(view.proposeFitIn(viewport)).toEqual({ cols: 90, rows: 20 })
    view.dispose()
  })

  it.each([
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects an unready cell metric of %s', (metric) => {
    const host = document.createElement('div')
    const viewport = document.createElement('div')
    viewport.getBoundingClientRect = () => ({ width: 800, height: 480 }) as DOMRect
    const view = new TerminalView({ renderer: 'dom' })
    view.mount(host)
    const cell = deviceCell(view, metric, 20)
    expect(view.proposeFitIn(viewport)).toBeUndefined()
    cell.width = 10
    cell.height = metric
    expect(view.proposeFitIn(viewport)).toBeUndefined()
    view.dispose()
  })

  it('returns undefined when the container has zero dimensions', () => {
    const el = document.createElement('div')
    // zero clientWidth/clientHeight → FitAddon.proposeDimensions() returns undefined
    const view = new TerminalView()
    view.mount(el)
    const result = view.proposeFit()
    // Must signal not-ready; must NOT return a stale default grid
    expect(result).toBeUndefined()
    view.dispose()
  })

  it('returns a grid object when proposeDimensions yields real cols/rows', () => {
    const el = document.createElement('div')
    const view = new TerminalView()
    view.mount(el)

    // Patch FitAddon's proposeDimensions to return a valid measurement so we
    // can test the success path without real browser layout.
    const fa = (view as unknown as { fitAddon: { proposeDimensions(): unknown; fit(): void } })
      .fitAddon
    fa.proposeDimensions = () => ({ cols: 80, rows: 24 })
    fa.fit = () => {} // no-op; term.cols/rows won't change in headless

    const result = view.proposeFit()
    expect(result).toEqual({ cols: 80, rows: 24 })
    // …and it stayed a PROPOSAL: nothing was applied to the terminal.
    expect({ cols: view.cols(), rows: view.rows() }).toEqual({ cols: 80, rows: 24 })
    view.dispose()
  })

  it('returns undefined when proposeDimensions yields cols < 2', () => {
    const el = document.createElement('div')
    const view = new TerminalView()
    view.mount(el)

    const fa = (view as unknown as { fitAddon: { proposeDimensions(): unknown; fit(): void } })
      .fitAddon
    fa.proposeDimensions = () => ({ cols: 1, rows: 24 })
    fa.fit = () => {}

    expect(view.proposeFit()).toBeUndefined()
    view.dispose()
  })

  it('returns undefined when proposeDimensions yields rows < 2', () => {
    const el = document.createElement('div')
    const view = new TerminalView()
    view.mount(el)

    const fa = (view as unknown as { fitAddon: { proposeDimensions(): unknown; fit(): void } })
      .fitAddon
    fa.proposeDimensions = () => ({ cols: 80, rows: 1 })
    fa.fit = () => {}

    expect(view.proposeFit()).toBeUndefined()
    view.dispose()
  })

  it('returns undefined when proposeDimensions throws', () => {
    const el = document.createElement('div')
    const view = new TerminalView()
    view.mount(el)

    const fa = (view as unknown as { fitAddon: { proposeDimensions(): unknown; fit(): void } })
      .fitAddon
    fa.proposeDimensions = () => {
      throw new Error('renderer not ready')
    }

    expect(view.proposeFit()).toBeUndefined()
    view.dispose()
  })
})
