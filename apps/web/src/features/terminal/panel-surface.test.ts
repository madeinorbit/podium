import type { SessionStatus } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { panelGates, panelSurface } from './panel-surface'

// ---------------------------------------------------------------------------
// The arbitration, as a table (POD-408). Before this file the same rules lived
// in a nested ternary plus eight re-spellings of `!hibernated && !exited && …`,
// and could only be driven through a mounted React tree with a mocked xterm.
// ---------------------------------------------------------------------------

const surfaceOf = (over: {
  status?: SessionStatus | undefined
  inTransit?: boolean
  chatCapable?: boolean
  mode?: 'chat' | 'native'
}) =>
  panelSurface({
    status: over.status,
    inTransit: over.inTransit ?? false,
    chatCapable: over.chatCapable ?? true,
    mode: over.mode ?? 'native',
  })

describe('panelSurface', () => {
  it('renders a live session in the mode it was left in', () => {
    expect(surfaceOf({ status: 'live', mode: 'native' })).toEqual({ kind: 'live', view: 'native' })
    expect(surfaceOf({ status: 'live', mode: 'chat' })).toEqual({ kind: 'live', view: 'chat' })
  })

  it('shows a hibernated session its transcript, or the recovery pane when it has none', () => {
    expect(surfaceOf({ status: 'hibernated' })).toEqual({ kind: 'parked', view: 'transcript' })
    expect(surfaceOf({ status: 'hibernated', chatCapable: false })).toEqual({
      kind: 'parked',
      view: 'recovery',
    })
  })

  it('shows an exited session its transcript, or the recovery pane when it has none', () => {
    expect(surfaceOf({ status: 'exited' })).toEqual({ kind: 'ended', view: 'transcript' })
    expect(surfaceOf({ status: 'exited', chatCapable: false })).toEqual({
      kind: 'ended',
      view: 'recovery',
    })
  })

  it('lets the move win over the read-only state it passes through', () => {
    // A move STOPS the process, so a moving session is briefly a parked one too.
    // The veil must win or the operator watches the pane fall through every
    // read-only state on the way ([spec:SP-3f7a]).
    expect(surfaceOf({ status: 'hibernated', inTransit: true })).toEqual({ kind: 'transit' })
    expect(surfaceOf({ status: 'exited', inTransit: true })).toEqual({ kind: 'transit' })
    expect(surfaceOf({ status: 'live', inTransit: true })).toEqual({ kind: 'transit' })
  })

  it('treats a session with no row yet as live (the Starting… window)', () => {
    // An optimistic spawn has no wire row. The panel is live and the overlay
    // covers the wait; `spawnConfirmed` — not this function — holds the mount.
    expect(surfaceOf({ status: undefined, mode: 'native' })).toEqual({
      kind: 'live',
      view: 'native',
    })
    expect(surfaceOf({ status: 'starting' })).toEqual({ kind: 'live', view: 'native' })
  })
})

const gatesFor = (
  surface: ReturnType<typeof panelSurface>,
  over: {
    paneActive?: boolean
    spawnConfirmed?: boolean
    chatCapable?: boolean
    terminalCapable?: boolean
  } = {},
) =>
  panelGates(surface, {
    paneActive: over.paneActive ?? true,
    spawnConfirmed: over.spawnConfirmed ?? true,
    chatCapable: over.chatCapable ?? true,
    terminalCapable: over.terminalCapable ?? true,
  })

describe('panelGates', () => {
  it('keeps a warm HIDDEN panel mounted but never active', () => {
    // The warm set exists so switching back catches up instead of re-attaching:
    // mounted is true while visible is false.
    const g = gatesFor(surfaceOf({ status: 'live' }), { paneActive: false })
    expect(g.terminalMounted).toBe(true)
    expect(g.terminalActive).toBe(false)
  })

  it('keeps the terminal mounted in chat mode but not active (the warm toggle)', () => {
    const g = gatesFor(surfaceOf({ status: 'live', mode: 'chat' }))
    expect(g.terminalMounted).toBe(true)
    expect(g.terminalActive).toBe(false)
  })

  it('holds the mount back until an optimistic spawn reconciles (#119)', () => {
    expect(
      gatesFor(surfaceOf({ status: undefined }), { spawnConfirmed: false }).terminalMounted,
    ).toBe(false)
  })

  it('never mounts a PTY for a state that has no process behind it', () => {
    for (const s of [
      surfaceOf({ status: 'hibernated' }),
      surfaceOf({ status: 'exited' }),
      surfaceOf({ inTransit: true }),
    ]) {
      expect(gatesFor(s).terminalMounted).toBe(false)
      expect(gatesFor(s).terminalActive).toBe(false)
    }
  })

  it('REFUSES PTY sizing on a warm but hidden pane', () => {
    // The visibility foundation: PanelDeck `display:none`s a non-visible panel,
    // so it measures ZERO. A fit()+sendResize from that measurement re-grids a
    // live PTY to a box nobody is looking at. Same flag the engine derives
    // viewState `visible` from.
    expect(gatesFor(surfaceOf({ status: 'live' }), { paneActive: false }).ptySizingAllowed).toBe(
      false,
    )
    expect(gatesFor(surfaceOf({ status: 'live' }), { paneActive: true }).ptySizingAllowed).toBe(
      true,
    )
  })

  it('REFUSES PTY sizing while chat is the view, even on the visible pane', () => {
    expect(gatesFor(surfaceOf({ status: 'live', mode: 'chat' })).ptySizingAllowed).toBe(false)
  })

  it('offers the mode switch only for a live, chat-capable session', () => {
    expect(gatesFor(surfaceOf({ status: 'live' })).modeSwitchOffered).toBe(true)
    expect(gatesFor(surfaceOf({ status: 'live' }), { chatCapable: false }).modeSwitchOffered).toBe(
      false,
    )
    expect(gatesFor(surfaceOf({ status: 'hibernated' })).modeSwitchOffered).toBe(false)
    expect(gatesFor(surfaceOf({ status: 'exited' })).modeSwitchOffered).toBe(false)
    expect(gatesFor(surfaceOf({ inTransit: true })).modeSwitchOffered).toBe(false)
  })

  it('offers the mode switch on a hidden pane — the header is not the PTY', () => {
    // A warm hidden panel still renders its header into the DOM; the switch is
    // not a PTY operation, so paneActive must not gate it.
    expect(gatesFor(surfaceOf({ status: 'live' }), { paneActive: false }).modeSwitchOffered).toBe(
      true,
    )
  })

  it('offers Take control and the offer dock only where a native PTY is on screen', () => {
    const live = gatesFor(surfaceOf({ status: 'live' }))
    expect(live.takeControlOffered).toBe(true)
    expect(live.offerDockOffered).toBe(true)
    for (const s of [
      surfaceOf({ status: 'live', mode: 'chat' }),
      surfaceOf({ status: 'hibernated' }),
      surfaceOf({ status: 'exited' }),
      // Pre-POD-408 the offer dock did NOT check transit: `nativeOffer` read
      // mode + !hibernated + !exited only, so a move left the dock's target
      // flipped while the veil covered the pane.
      surfaceOf({ inTransit: true }),
    ]) {
      expect(gatesFor(s).takeControlOffered).toBe(false)
      expect(gatesFor(s).offerDockOffered).toBe(false)
    }
  })

  // POD-2290 — a server- or embedded-driven session has no PTY at all. Both
  // gates below used to pass on the strength of `live` alone, which is how an
  // opencode session ended up attaching to nothing and offering a switch to the
  // spinner that produced.
  describe('a live session with no terminal behind it', () => {
    const noTerminal = { terminalCapable: false }

    it('never mounts a PTY, however confirmed and live the session is', () => {
      // The attach would be issued against a session no daemon will ever bind a
      // PTY to: unanswered, `ready` false forever, and that unresolvable wait IS
      // the "Starting <Harness>…" spinner.
      expect(gatesFor(surfaceOf({ status: 'live' }), noTerminal).terminalMounted).toBe(false)
    })

    it('does not offer a switch to a view that cannot exist', () => {
      expect(gatesFor(surfaceOf({ status: 'live' }), noTerminal).modeSwitchOffered).toBe(false)
    })

    it('does not put the native pane in the DOM at all', () => {
      // Not the same gate as the mount, and `hidden` is not the same as absent:
      // the container carries the startup overlay, so leaving it rendered would
      // keep a spinner animating over a wait that has no end — off screen, but
      // still a claim the panel is making.
      expect(gatesFor(surfaceOf({ status: 'live' }), noTerminal).nativePaneRendered).toBe(false)
    })

    it('leaves every PTY-capable session exactly as it was', () => {
      // The regression this pair is guarding against runs the other way too: a
      // claude-pty session, a degraded fallback, and any row whose driver family
      // has not arrived (or is unknown to this build) must be untouched.
      const g = gatesFor(surfaceOf({ status: 'live' }), { terminalCapable: true })
      expect(g.terminalMounted).toBe(true)
      expect(g.modeSwitchOffered).toBe(true)
      expect(g.nativePaneRendered).toBe(true)
    })

    it('still renders the native pane before an optimistic spawn reconciles', () => {
      // The one case that proves `nativePaneRendered` is not just a second
      // spelling of `terminalMounted`: the mount is held back here, and the
      // container must be on screen anyway — the "Starting…" overlay inside it
      // IS what covers that wait.
      const g = gatesFor(surfaceOf({ status: undefined }), { spawnConfirmed: false })
      expect(g.terminalMounted).toBe(false)
      expect(g.nativePaneRendered).toBe(true)
    })
  })
})
