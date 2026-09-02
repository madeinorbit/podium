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

/** ResizeObserver stub the test can fire — the container-size-changed signal a
 *  real browser emits once a just-revealed pane finishes laying out. */
function withCapturingResizeObserver(): { fire: () => void } {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  const original = g.ResizeObserver
  const cbs: Array<() => void> = []
  g.ResizeObserver = class {
    constructor(cb: () => void) {
      cbs.push(cb)
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  restorers.push(() => {
    g.ResizeObserver = original
  })
  return {
    fire: () => {
      for (const cb of cbs) cb()
    },
  }
}

/** Hub stub whose `onState` the test drives directly. */
function fakeHub(initial: { cols: number; rows: number } = { cols: 80, rows: 24 }) {
  let cbs: SessionCallbacks = {}
  let current = {
    connected: true,
    clientId: 'c1',
    controllerId: 'c1',
    controllerIdentity: null,
    outcome: null,
    sessionId: SESSION,
    role: 'controller' as 'controller' | 'spectator',
    cols: initial.cols,
    rows: initial.rows,
    geometryRevision: 0,
    requestedGeometry: null as { cols: number; rows: number } | null,
    epoch: 0,
    lastSeq: -1,
    outputSeen: true,
  }
  const calls = {
    resize: [] as Array<[number, number]>,
    claims: [] as Array<{ cols: number; rows: number } | undefined>,
    requestControl: 0,
    redraw: 0,
  }
  const connection = {
    sendResize: (c: number, r: number) => calls.resize.push([c, r]),
    reportViewport: (c: number, r: number) => calls.resize.push([c, r]),
    sendInput: () => {},
    requestControl: (geometry?: { cols: number; rows: number }) => {
      calls.requestControl += 1
      calls.claims.push(geometry)
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
      current = { ...current, cols, rows, geometryRevision: current.geometryRevision + 1 }
      cbs.onState?.(current as never)
    },
    attached: () => cbs.onAttached?.(),
  }
}

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

describe('C2 (REWRITTEN for POD-3239 B2): the buffer follows the server whether or not the pane is eligible — but only AFTER the attach', () => {
  it('a pane mounted inactive follows a server grid change, once it has attached', () => {
    // The claim SURVIVES: there is deliberately no eligibility gate here, and
    // MODEL rule 2 makes that a rule rather than an oversight — every viewer's
    // buffer is always at W, hidden or not, so a reveal has nothing to catch up
    // on. What CHANGED is that the following is now conditional on having been
    // told a W at all (B2): before the attach, nothing may move this buffer.
    withResizeObserver()
    withProposal(() => undefined) // never measurable: no fit can move the grid
    const { hub, serverGrid, attached } = fakeHub()
    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: false })
    try {
      expect(mounted.view.cols()).toBe(80)

      // NOT AUTHORITATIVE YET — this state is ignored for geometry.
      serverGrid(99, 29)
      expect(mounted.view.cols()).toBe(80)
      expect(mounted.view.rows()).toBe(24)

      attached()
      serverGrid(132, 43)

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

    const { hub, serverGrid, attached } = fakeHub()
    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: true })
    try {
      attached()
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

  it('REWRITTEN (POD-3239 B3): the guard is gone, because the thing it guarded is', async () => {
    // C11's finding was that the reveal guard's first comparison was
    // TAUTOLOGICAL — it compared `fit()`'s return against the two fields `fit()`
    // had just written. The test above still proves that about `fit()`. What
    // this one used to pin was the guard's live half: a post-fit probe that
    // disagreed with what landed traced `reveal:fit-mismatch` and restarted the
    // streak.
    //
    // There is no longer anything to land. A reveal MEASURES the box and asks;
    // it does not apply the measurement, so there is no applied grid to compare
    // a probe against and no mismatch to trace. What survives is the part that
    // was doing real work: consecutive agreeing measurements before the ask, so
    // a mid-layout reading never becomes daemon geometry.
    withResizeObserver()
    const { entries } = captureDiagnostics()

    let reads = 0
    withProposal(() => {
      reads += 1
      // Two disagreeing reads while the layout settles, then a steady box.
      if (reads === 1) return { cols: 99, rows: 33 }
      if (reads === 2) return { cols: 120, rows: 40 }
      return { cols: 150, rows: 50 }
    })

    const { hub, calls } = fakeHub()
    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: false })
    try {
      mounted.setActive(true)
      await new Promise((r) => setTimeout(r, 600))
      const events = entries.map((e) => e.event)
      expect(events, 'the guard and its mismatch trace are gone').not.toContain(
        'reveal:fit-mismatch',
      )
      expect(events).toContain('reveal:measured')
      expect(calls.requestControl).toBeGreaterThan(0)
      // The ask carried the SETTLED box, never one of the two transient reads.
      expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
      // …and nothing moved the buffer, which never attached.
      expect(mounted.view.cols()).toBe(80)
    } finally {
      mounted.dispose()
    }
  }, 15000)
})

// ---------------------------------------------------------------------------
// C12
// ---------------------------------------------------------------------------

describe("C12 (REWRITTEN for POD-3239 B3): `crop` is the explicit presentation mode, and it is what picks the renderer", () => {
  it("crop:'scroll' selects the DOM renderer explicitly ('renderer-selected')", () => {
    // WHAT CHANGED. The DOM renderer used to be selected by `gridMode`, a
    // POLICY flag about who may drive the pty size, which happened to imply a
    // scrolling crop on the one platform that set it. The two are now separate
    // and the presentation is stated: WebGL not repainting scroll-revealed
    // regions is a fact about scrolling, not about who is in control.
    withResizeObserver()
    withProposal(() => undefined)
    const { entries } = captureDiagnostics()
    const { hub } = fakeHub()
    const mounted = mountSession(host(), {
      hub,
      sessionId: SESSION,
      active: false,
      crop: 'scroll',
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

  it("the default (crop:'clip') mount never selects the DOM renderer explicitly", () => {
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
      // crop selection branch — the reason distinguishes the two.
      expect(reasons).not.toContain('renderer-selected')
    } finally {
      mounted.dispose()
    }
  })

  it("the POLICY flag no longer picks the renderer: gridMode alone leaves it on auto", () => {
    // The counterfactual that makes the separation real rather than a rename.
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
      crop: 'scroll',
    })
    expect(targets).toContain(crop)
    expect(targets).not.toContain(inner)
    b.dispose()
  })

  it('SOURCE FACT: BOTH platforms now wrap the host in an outer viewport', () => {
    // The claim this inverts: the mobile pane had a crop viewport and the
    // desktop panel had neither it nor a `viewportEl`, so the desktop measured
    // the host xterm sizes — which is a box measuring its own output. B3 gives
    // both platforms the same two elements, differing only in `crop`.
    const read = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    const mobile = read('../../../apps/mobile/src/terminal/TerminalPane.web.tsx')
    const desktop = read('../../../apps/web/src/features/terminal/AgentPanel.tsx')

    expect(mobile).toContain('data-terminal-crop-viewport')
    expect(mobile).toContain("overflow: 'auto'")
    expect(mobile).toContain("crop: 'scroll'")

    expect(desktop).toContain('term-viewport')
    expect(desktop).toContain('termViewportRef')
    expect(desktop).toContain("crop: 'clip'")
  })
})

// ---------------------------------------------------------------------------
// C10 (the "nobody reads it" half)
// ---------------------------------------------------------------------------

describe('C10 (REWRITTEN for POD-3239 B1): the whole chain now reads the session geometry it always had', () => {
  it('SOURCE FACT: `initialGeometry` runs through mountSession, useTerminalSession and AgentPanel', () => {
    // THE CLAIM THIS INVERTS. `SessionMeta.geometry` reached the panel and
    // nobody read it, so every terminal was constructed at xterm's 80x24 and
    // then moved. B1 threads it through the same three files, which is what
    // makes the first painted frame the right shape.
    //
    // Still positive-only and still scoped to the named files — its job is to
    // fail loudly if any link in the chain is unwired, in either direction.
    const read = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    const files = {
      'session-mount.ts': read('./session-mount.ts'),
      'use-terminal-session.ts': read('../../terminal-client-react/src/use-terminal-session.ts'),
      'AgentPanel.tsx': read('../../../apps/web/src/features/terminal/AgentPanel.tsx'),
    }
    for (const [name, source] of Object.entries(files)) {
      expect({ [name]: source.includes('initialGeometry') }).toEqual({ [name]: true })
      expect({ [name]: source.includes('geometryState') }).toEqual({ [name]: true })
    }
    // …and the panel reads it off the SESSION ROW, which is the value the server
    // has been publishing all along.
    expect(files['AgentPanel.tsx']).toMatch(/session\?\.geometry\b/)
  })
})

// ---------------------------------------------------------------------------
// C17 (added at rev 3 from 0a's cold-sized capture, POD-3234)
// ---------------------------------------------------------------------------

describe('C17: a cold mount claims against the FRESH XTERM, not the server, and settles by resizing the PTY twice for no net change', () => {
  it('the mount seeds serverGrid from the just-constructed xterm, so it claims a size the server already holds', async () => {
    withResizeObserver()
    // The box measures exactly what the server is already at.
    withProposal(() => ({ cols: 104, rows: 31 }))
    const { hub, calls } = fakeHub({ cols: 104, rows: 31 })

    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: true })
    try {
      await new Promise((r) => setTimeout(r, 300))
      // A redundant claim: `serverGrid` was seeded from `view.cols()/rows()` at
      // mount (session-mount.ts:172), which is xterm's construction default, so
      // decideResizeAction compares 104x31 against 80x24 and reports a change.
      expect(calls.resize).toContainEqual([104, 31])
    } finally {
      mounted.dispose()
    }
  }, 10000)

  it('ARMED: a box that measures the construction default sends no resize at all', async () => {
    withResizeObserver()
    // Same server grid, but now the box happens to equal xterm's own default —
    // the ONE case the seeded comparison calls unchanged. It redraws instead.
    withProposal(() => ({ cols: 80, rows: 24 }))
    const { hub, calls } = fakeHub({ cols: 104, rows: 31 })

    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: true })
    try {
      await new Promise((r) => setTimeout(r, 300))
      expect(calls.resize).toEqual([])
      expect(calls.redraw).toBeGreaterThan(0)
    } finally {
      mounted.dispose()
    }
  }, 10000)

  it('two settling measurements push the PTY away from the server grid and back — two resizes, zero net change', async () => {
    // 0a's cold-sized capture (POD-3190 artifact cold-sized-trace.json, mount
    // mtkf7e2h-0): the server was already at 104x31 (rev 2); the mount's first
    // fit measured a 2-row-taller box and claimed 104x33 (rev 3); the settled
    // box then fired a second fit that claimed 104x31 back (rev 4). Two PTY
    // resizes and two SIGWINCH repaints to end exactly where it started.
    withResizeObserver()
    const observer = withCapturingResizeObserver()
    let grid = { cols: 104, rows: 33 } // pre-settle: the box is two rows taller
    withProposal(() => grid)
    const { hub, calls, serverGrid, attached } = fakeHub({ cols: 104, rows: 31 })

    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: true })
    try {
      await new Promise((r) => setTimeout(r, 300))
      expect(calls.resize).toEqual([[104, 33]]) // away from the server's 104x31

      // The attach lands and the server applies the claim: serverGrid := 104x33.
      attached()
      serverGrid(104, 33)

      // The layout settles two rows shorter and the observer fires a second fit.
      grid = { cols: 104, rows: 31 }
      observer.fire()
      await new Promise((r) => setTimeout(r, 400))

      expect(calls.resize).toEqual([
        [104, 33],
        [104, 31],
      ])
      // Net zero: the PTY ends at the grid the server already held before the
      // mount ran. Every byte of that round trip is a repaint nobody asked for.
      expect(calls.resize.at(-1)).toEqual([104, 31])
    } finally {
      mounted.dispose()
    }
  }, 15000)
})
