// @vitest-environment happy-dom

/**
 * SIZING PLAN ASSUMPTION TESTS — view/mount half (POD-3235, spec artifact SPEC-0b.md rev 2).
 *
 * What `mountSession` and `TerminalView` actually do today, for the claims the
 * terminal-sizing plan (POD-3190) rests on. Stage 1 (POD-3239) deletes the
 * reveal guard, the retry ladders and `gridMode`; each claim below is rewritten
 * in the commit that changes the behaviour it pins.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SessionCallbacks, SocketHub } from '@podium/client-core/socket-transport'
import { asSessionId } from '@podium/model'
import { FitAddon } from '@xterm/addon-fit'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSession } from './session-mount'
import { onTerminalDiagnostic, type TerminalDiagnosticEntry } from './terminal-diagnostics'
import { TerminalView } from './terminal-view'

const SESSION = asSessionId('s-sizing')
const restorers: Array<() => void> = []
afterEach(() => {
  while (restorers.length) restorers.pop()?.()
})

function withResizeObserver(): void {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  const original = g.ResizeObserver
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  restorers.push(() => {
    g.ResizeObserver = original
  })
}

/** Record what each ResizeObserver was pointed at — the measurement seam. */
function withObservingResizeObserver(): { targets: Element[] } {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  const original = g.ResizeObserver
  const targets: Element[] = []
  g.ResizeObserver = class {
    observe(el: Element): void {
      targets.push(el)
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  restorers.push(() => {
    g.ResizeObserver = original
  })
  return { targets }
}

/** happy-dom cannot measure a cell grid, so FitAddon.proposeDimensions is patched. */
function withProposal(next: () => { cols: number; rows: number } | undefined): void {
  const proto = FitAddon.prototype as unknown as { proposeDimensions: () => unknown }
  const original = proto.proposeDimensions
  proto.proposeDimensions = next
  restorers.push(() => {
    proto.proposeDimensions = original
  })
}

function captureDiagnostics(): { entries: TerminalDiagnosticEntry[] } {
  const entries: TerminalDiagnosticEntry[] = []
  const off = onTerminalDiagnostic((entry) => entries.push(entry))
  restorers.push(off)
  return { entries }
}

/** A host that reports a real size so xterm/FitAddon can run. */
function host(): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: 1200, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 800, configurable: true })
  document.body.appendChild(el)
  return el
}

/** Hub stub whose `onState` the test drives directly. */
function fakeHub() {
  let cbs: SessionCallbacks = {}
  let current = {
    connected: true,
    clientId: 'c1',
    controllerId: 'c1',
    controllerIdentity: null,
    outcome: null,
    sessionId: SESSION,
    role: 'controller' as 'controller' | 'spectator',
    cols: 80,
    rows: 24,
    geometryRevision: 0,
    requestedGeometry: null as { cols: number; rows: number } | null,
    epoch: 0,
    lastSeq: -1,
    outputSeen: true,
  }
  const calls = { resize: [] as Array<[number, number]>, requestControl: 0, redraw: 0 }
  const connection = {
    sendResize: (c: number, r: number) => calls.resize.push([c, r]),
    reportViewport: (c: number, r: number) => calls.resize.push([c, r]),
    sendInput: () => {},
    requestControl: () => {
      calls.requestControl += 1
    },
    redraw: () => {
      calls.redraw += 1
    },
    state: () => current,
  }
  const hub = {
    attach: (_id: string, cb: SessionCallbacks = {}) => {
      cbs = cb
      return connection
    },
    registerRenderedSession: () => () => {},
    detach: () => {},
  } as unknown as SocketHub
  return {
    hub,
    calls,
    serverGrid: (cols: number, rows: number) => {
      current = { ...current, cols, rows }
      cbs.onState?.(current as never)
    },
  }
}

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

describe('C2: onState resizes the view while the pane is NOT eligible', () => {
  it('a pane mounted inactive still follows a server grid change', () => {
    withResizeObserver()
    withProposal(() => undefined) // never measurable: no fit can move the grid
    const { hub, serverGrid } = fakeHub()
    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: false })
    try {
      expect(mounted.view.cols()).toBe(80)
      expect(mounted.view.rows()).toBe(24)

      serverGrid(132, 43)

      // No eligibility gate on this branch — the hidden pane is resized.
      expect(mounted.view.cols()).toBe(132)
      expect(mounted.view.rows()).toBe(43)
    } finally {
      mounted.dispose()
    }
  })

  it('the same is true when the DOCUMENT is hidden, not just the pane', () => {
    withResizeObserver()
    withProposal(() => undefined)
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    restorers.push(() => {
      if (original) Object.defineProperty(document, 'visibilityState', original)
      else Reflect.deleteProperty(document, 'visibilityState')
    })
    expect(document.visibilityState).toBe('hidden')

    const { hub, serverGrid } = fakeHub()
    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: true })
    try {
      serverGrid(120, 40)
      expect(mounted.view.cols()).toBe(120)
      expect(mounted.view.rows()).toBe(40)
    } finally {
      mounted.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// C11
// ---------------------------------------------------------------------------

describe('C11: the reveal guard', () => {
  it('TerminalView.fit() returns the APPLIED grid, so `grid === applied` can never be false', () => {
    // The guard at session-mount.ts:455-462 compares fit()'s return against
    // {view.cols(), view.rows()} read on the next line. fit() returns
    // {term.cols, term.rows} AFTER the resize and view.cols()/rows() read the
    // same two fields, so that half of the comparison is tautological.
    //
    // Non-vacuous because fit() MEASURES TWICE: its own proposeFit() probe, and
    // then FitAddon.fit()'s internal one, which is what actually lands. Feed the
    // two different answers and fit() still reports the applied grid — the exact
    // hazard the guard's comment names, and the reason its first check cannot
    // catch it.
    const el = host()
    const view = new TerminalView({})
    view.mount(el)
    try {
      const answers = [
        { cols: 150, rows: 50 },
        { cols: 120, rows: 40 },
      ]
      let call = 0
      withProposal(() => answers[Math.min(call++, answers.length - 1)])

      const grid = view.fit()
      expect(call).toBeGreaterThan(1) // fit() really did measure more than once
      const applied = { cols: view.cols(), rows: view.rows() }

      expect(grid).toEqual(applied) // the tautology
      // …and it is the SECOND measurement that landed, not the probe fit() itself
      // validated, so the equality above says nothing about the proposal.
      expect(grid).toEqual({ cols: 120, rows: 40 })
      expect(grid).not.toEqual(answers[0])
    } finally {
      view.dispose()
    }
  })

  it('INTENDED behaviour: a post-fit probe that disagrees with the applied grid restarts the settle streak', async () => {
    withResizeObserver()
    const { entries } = captureDiagnostics()

    // The guard's SECOND comparison is the live one: `settled`, the probe taken
    // immediately after fit(), must agree with what landed. Target exactly that
    // read by flagging the call that follows a fit().
    let justFitted = false
    let disagreeOnce = true
    const origFit = TerminalView.prototype.fit
    TerminalView.prototype.fit = function patched(this: TerminalView) {
      const result = origFit.call(this)
      justFitted = true
      return result
    }
    restorers.push(() => {
      TerminalView.prototype.fit = origFit
    })
    withProposal(() => {
      if (justFitted) {
        justFitted = false
        if (disagreeOnce) {
          disagreeOnce = false
          return { cols: 99, rows: 33 }
        }
      }
      return { cols: 150, rows: 50 }
    })

    const { hub, calls } = fakeHub()
    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: false })
    try {
      mounted.setActive(true)
      await new Promise((r) => setTimeout(r, 600))
      const events = entries.map((e) => e.event)
      // The disagreement was SEEN and rejected…
      expect(events).toContain('reveal:fit-mismatch')
      // …and the streak restarted rather than aborting: a later attempt measures
      // and the reveal goes on to claim control at the settled grid.
      expect(events).toContain('reveal:measured')
      expect(events.indexOf('reveal:fit-mismatch')).toBeLessThan(events.indexOf('reveal:measured'))
      expect(calls.requestControl).toBeGreaterThan(0)
    } finally {
      mounted.dispose()
    }
  }, 15000)
})

// ---------------------------------------------------------------------------
// C12
// ---------------------------------------------------------------------------

describe("C12: gridMode:'server-grid' selects the DOM renderer; the desktop panel gets the auto renderer", () => {
  it("server-grid selects the DOM renderer explicitly ('renderer-selected')", () => {
    withResizeObserver()
    withProposal(() => undefined)
    const { entries } = captureDiagnostics()
    const { hub } = fakeHub()
    const mounted = mountSession(host(), {
      hub,
      sessionId: SESSION,
      active: false,
      gridMode: 'server-grid',
    })
    try {
      const reasons = entries
        .filter((e) => e.event === 'renderer:dom')
        .map((e) => e.data.reason as string)
      expect(reasons).toContain('renderer-selected')
    } finally {
      mounted.dispose()
    }
  })

  it('the default (control) mount never selects the DOM renderer explicitly', () => {
    withResizeObserver()
    withProposal(() => undefined)
    const { entries } = captureDiagnostics()
    const { hub } = fakeHub()
    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: false })
    try {
      const reasons = entries
        .filter((e) => e.event === 'renderer:dom')
        .map((e) => e.data.reason as string)
      // It may still END UP on DOM (happy-dom has no WebGL), but never via the
      // server-grid selection branch — the reason distinguishes the two.
      expect(reasons).not.toContain('renderer-selected')
    } finally {
      mounted.dispose()
    }
  })

  it('with no viewportEl the host IS the measured box; a crop viewport is measured instead', () => {
    const { targets } = withObservingResizeObserver()
    withProposal(() => undefined)
    const { hub } = fakeHub()

    const plain = host()
    const a = mountSession(plain, { hub, sessionId: SESSION, active: false })
    expect(targets).toContain(plain)
    a.dispose()

    targets.length = 0
    const crop = host()
    const inner = host()
    crop.appendChild(inner)
    const b = mountSession(inner, {
      hub,
      sessionId: SESSION,
      active: false,
      viewportEl: crop,
      gridMode: 'server-grid',
    })
    expect(targets).toContain(crop)
    expect(targets).not.toContain(inner)
    b.dispose()
  })

  it('SOURCE FACT: the mobile pane wraps an overflow-scroll crop viewport; AgentPanel has none', () => {
    // Scoped deliberately to the two files the claim names. It is a source
    // reading, not a runtime observation: it proves the crop container exists
    // in one and is absent from the other, which is what stage 1's B3 replaces.
    const read = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    const mobile = read('../../../apps/mobile/src/terminal/TerminalPane.web.tsx')
    const desktop = read('../../../apps/web/src/features/terminal/AgentPanel.tsx')

    expect(mobile).toContain('data-terminal-crop-viewport')
    expect(mobile).toContain("overflow: 'auto'")
    expect(mobile).toContain("gridMode: 'server-grid'")

    expect(desktop).not.toContain('data-terminal-crop-viewport')
    expect(desktop).not.toContain('gridMode')
    expect(desktop).not.toContain('viewportEl')
  })
})

// ---------------------------------------------------------------------------
// C10 (the "nobody reads it" half)
// ---------------------------------------------------------------------------

describe('C10: nothing in the mount/hook/panel chain reads SessionMeta.geometry today', () => {
  it('SOURCE FACT: no session-geometry read in mountSession, useTerminalSession, AgentPanel or the hub connection', () => {
    // Positive-only by construction (a grep cannot prove a negative in
    // general), so it is scoped to exactly the four files SPEC-0b names and
    // exists to FAIL LOUDLY if a reader is added before stage 1 wires one on
    // purpose. Stage 1's B1 adds `initialGeometry` here and rewrites this test.
    const read = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    const files = {
      'session-mount.ts': read('./session-mount.ts'),
      'use-terminal-session.ts': read('../../terminal-client-react/src/use-terminal-session.ts'),
      'AgentPanel.tsx': read('../../../apps/web/src/features/terminal/AgentPanel.tsx'),
    }
    for (const [name, source] of Object.entries(files)) {
      expect({ [name]: /session[^\n]*\.geometry\b/.test(source) }).toEqual({ [name]: false })
      expect({ [name]: source.includes('initialGeometry') }).toEqual({ [name]: false })
    }
  })
})
