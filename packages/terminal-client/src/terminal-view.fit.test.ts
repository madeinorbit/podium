// @vitest-environment happy-dom
//
// Unit-guards for TerminalView.fit() zero-size / not-ready detection.
// The key invariant: when a container has zero dimensions (hidden tab, collapsed
// panel), fit() must return undefined rather than silently returning a stale grid.
// Callers can then retry across rAFs instead of sending a bad resize to the agent.
import { beforeAll, describe, expect, it } from 'vitest'
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

describe('TerminalView.fit() readiness guard', () => {
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

    expect(view.proposeFitIn(viewport)).toEqual({ cols: 40, rows: 12 })
    expect({ cols: view.cols(), rows: view.rows() }).toEqual({ cols: 80, rows: 24 })
    view.dispose()
  })

  it('returns undefined when the container has zero dimensions', () => {
    const el = document.createElement('div')
    // zero clientWidth/clientHeight → FitAddon.proposeDimensions() returns undefined
    const view = new TerminalView()
    view.mount(el)
    const result = view.fit()
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

    // term.cols/rows stay at the Terminal constructor default (80×24)
    const result = view.fit()
    expect(result).toEqual({ cols: 80, rows: 24 })
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

    expect(view.fit()).toBeUndefined()
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

    expect(view.fit()).toBeUndefined()
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

    expect(view.fit()).toBeUndefined()
    view.dispose()
  })
})
