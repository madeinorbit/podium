// @vitest-environment happy-dom

/**
 * SIZING PLAN ASSUMPTION TESTS — view/mount half (POD-3235, spec artifact SPEC-0b.md rev 2).
 *
 * What `mountSession` and `TerminalView` actually do today, for the claims the
 * terminal-sizing plan (POD-3190) rests on. Stage 1 (POD-3239) deletes the
 * reveal guard, the retry ladders and `gridMode` are all gone; each claim below
 * was rewritten in the commit that changed the behaviour it pinned.
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
    asks: [] as Array<{
      geometry: { cols: number; rows: number }
      visible: boolean
      mode: 'native' | 'chat'
      claimControl: boolean
    }>,
    requestControl: 0,
    redraw: 0,
  }
  const connection = {
    // THE ONE ASK (POD-3239 B4). Recorded in `asks` with its full shape, and
    // ALSO folded into `claims`/`resize` so the assertions those older cases
    // make still read the same events — a claiming ask is what `requestControl`
    // used to be, a plain one is what `sendResize`/`reportViewport` used to be.
    sendViewportRequest: (request: {
      geometry: { cols: number; rows: number }
      visible: boolean
      mode: 'native' | 'chat'
      claimControl: boolean
    }) => {
      calls.asks.push(request)
      if (request.claimControl) {
        calls.requestControl += 1
        calls.claims.push(request.geometry)
      } else {
        calls.resize.push([request.geometry.cols, request.geometry.rows])
      }
    },
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

describe('C11 (REWRITTEN — the guard and the method it guarded are both gone)', () => {
  it("SOURCE FACT: `TerminalView.fit()` no longer exists, and the two proposals do", () => {
    // WHAT C11 FOUND. `fit()` measured TWICE — its own `proposeFit()` probe, and
    // then `FitAddon.fit()`'s internal one, which is what actually landed — and
    // returned what LANDED. So the reveal guard's first comparison, `fit()`'s
    // return against `view.cols()/rows()`, compared a value to itself.
    //
    // The method is deleted (POD-3239 B8) and the finding is why: a call that
    // measures AND applies is the one shape MODEL rule 2 forbids, because
    // applying is what puts a buffer at something other than W. What is left
    // measures and returns, and the caller decides whether to ask.
    const view = new TerminalView({})
    expect((view as unknown as Record<string, unknown>).fit).toBeUndefined()
    expect(typeof view.proposeFit).toBe('function')
    expect(typeof view.proposeFitIn).toBe('function')
    view.dispose()
  })

  it('REWRITTEN: the guard is gone, and so is the ladder it lived in', () => {
    // C11's live half pinned the guard's SECOND comparison: a post-fit probe
    // that disagreed with what landed traced `reveal:fit-mismatch` and restarted
    // a settle streak. There is nothing left to land and nothing to restart — a
    // reveal measures the box once and asks. The trace vocabulary says so:
    // `ask:sent` replaced the ladder's `fit:*` and `reveal:*` entries.
    withResizeObserver()
    const { entries } = captureDiagnostics()
    withProposal(() => ({ cols: 150, rows: 50 }))

    const { hub, calls } = fakeHub()
    const mounted = mountSession(host(), { hub, sessionId: SESSION, active: false })
    try {
      mounted.setActive(true)
      const events = entries.map((e) => e.event)
      expect(events, 'the guard and its mismatch trace are gone').not.toContain(
        'reveal:fit-mismatch',
      )
      expect(events, 'and so is the ladder').not.toContain('fit:retry-start')
      expect(events, 'one ask, named').toContain('ask:sent')
      expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
      // …and nothing moved the buffer, which never attached.
      expect(mounted.view.cols()).toBe(80)
    } finally {
      mounted.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// C12
// ---------------------------------------------------------------------------

describe("C12 (REWRITTEN for POD-3239 B3): `crop` is the explicit presentation mode, and it is what picks the renderer", () => {
  it("crop:'scroll' selects the DOM renderer explicitly ('renderer-selected')", () => {
    // WHAT CHANGED. The DOM renderer used to be selected by `gridMode`, a
    // POLICY flag about who may drive the pty size, which happened to imply a
    // scrolling crop on the one platform that set it. The renderer is now chosen
    // by the presentation that actually determines it: WebGL not repainting
    // scroll-revealed regions is a fact about SCROLLING. (`gridMode` itself is
    // gone — see `claimsOnReveal`, the one line that now reads the platform's
    // claiming policy off `crop`.)
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

describe('C17 (REWRITTEN — this is the fix): a cold mount at W claims once and moves nothing', () => {
  it('T9: a box that already equals W sends ONE request and asks for no resize', () => {
    // WHAT C17 FOUND, and what this commit removes. `serverGrid` was seeded from
    // the JUST-CONSTRUCTED xterm — 80x24, a number with nothing to do with this
    // session — so `decideResizeAction` compared the measured box against 80x24
    // rather than against W, and a cold reveal claimed a resize the server was
    // already at. 0a's cold-sized capture caught the full shape of it: 104x31 →
    // 104x33 → 104x31, two SIGWINCH repaints for zero net change.
    //
    // Three separate changes make that unreachable, and this test is where they
    // meet: the buffer is CONSTRUCTED at W (B1), so there is no default to
    // compare against; nothing seeds a grid from xterm (B2); and the one ask
    // carries the measured box for the SERVER to compare against W (B4/B6).
    withResizeObserver()
    withProposal(() => ({ cols: 104, rows: 31 }))
    const { hub, calls } = fakeHub({ cols: 104, rows: 31 })

    const mounted = mountSession(host(), {
      hub,
      sessionId: SESSION,
      active: true,
      initialGeometry: { cols: 104, rows: 31 },
      geometryState: 'current',
    })
    try {
      // ONE request — the reveal claim, which rule 4 sends whether or not the
      // size moved — and it asks for the size the server already holds, so the
      // server forwards nothing to the daemon (see T9's server half).
      expect(calls.asks).toEqual([
        {
          geometry: { cols: 104, rows: 31 },
          visible: true,
          mode: 'native',
          claimControl: true,
        },
      ])
      // And the buffer was never anywhere else.
      expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
        cols: 104,
        rows: 31,
      })
    } finally {
      mounted.dispose()
    }
  })

  it('a settling box asks ONCE more, at the settled size — never away and back', async () => {
    // The second half of 0a's capture: the layout settled two rows shorter after
    // the first measurement. The debounced observer collapses the burst, and the
    // dedup drops a restatement, so the settled box is asked for exactly once.
    withResizeObserver()
    const observer = withCapturingResizeObserver()
    let grid = { cols: 104, rows: 33 }
    withProposal(() => grid)
    const { hub, calls } = fakeHub({ cols: 104, rows: 31 })

    const mounted = mountSession(host(), {
      hub,
      sessionId: SESSION,
      active: true,
      initialGeometry: { cols: 104, rows: 31 },
      geometryState: 'current',
    })
    try {
      expect(calls.claims).toEqual([{ cols: 104, rows: 33 }])

      grid = { cols: 104, rows: 31 }
      observer.fire()
      observer.fire()
      await new Promise((r) => setTimeout(r, 90))
      expect(calls.resize).toEqual([[104, 31]])
      observer.fire()
      await new Promise((r) => setTimeout(r, 90))
      expect(calls.resize, 'and the settled box is not re-stated').toEqual([[104, 31]])
    } finally {
      mounted.dispose()
    }
  })
})
