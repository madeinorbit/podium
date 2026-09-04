import type { TerminalOutlook } from '@podium/client-core/viewmodels'
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
  terminal?: TerminalOutlook
}) =>
  panelSurface({
    status: over.status,
    inTransit: over.inTransit ?? false,
    chatCapable: over.chatCapable ?? true,
    mode: over.mode ?? 'native',
    // Default KNOWN-terminal: every pre-POD-2290 case in this file is about a
    // session whose driver family has already landed, and `unknown` would route
    // half of them into `pending` and prove nothing about the states they name.
    terminal: over.terminal ?? 'terminal',
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
    switchAlreadyOffered?: boolean
  } = {},
) =>
  panelGates(surface, {
    paneActive: over.paneActive ?? true,
    spawnConfirmed: over.spawnConfirmed ?? true,
    chatCapable: over.chatCapable ?? true,
    terminalCapable: over.terminalCapable ?? true,
    switchAlreadyOffered: over.switchAlreadyOffered ?? false,
  })

describe('panelGates', () => {
  it('keeps a warm HIDDEN panel mounted but never active', () => {
    // The warm set exists so switching back catches up instead of re-attaching:
    // mounted is true while visible is false.
    const g = gatesFor(surfaceOf({ status: 'live' }), { paneActive: false })
    expect(g.terminalMounted).toBe(true)
    expect(g.terminalActive).toBe(false)
  })

  it('permits an already-loaded terminal to stay mounted in chat mode', () => {
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

// ---------------------------------------------------------------------------
// POD-2290 ROUND TWO — the operator's live retest of round one. Two complaints,
// and neither was about a rule this file already had: the panel COMMITTED to a
// view before anything had told it which one (twelve measured seconds of the
// original bug), and then TOOK THE SWITCHER AWAY when the answer arrived.
// ---------------------------------------------------------------------------

describe('a session whose driver family has not arrived yet', () => {
  it('holds neutral while it is still starting', () => {
    // The exact window the operator saw: a row exists, it says `starting`, and
    // nobody has said whether there is a terminal. Committing either way here is
    // a guess, and the guess that reads `unknown` as `terminal` is the bug.
    expect(surfaceOf({ status: 'starting', terminal: 'unknown' })).toEqual({ kind: 'pending' })
    expect(surfaceOf({ status: undefined, terminal: 'unknown' })).toEqual({ kind: 'pending' })
  })

  it('offers nothing at all while it holds', () => {
    // Nothing to mount, nothing to switch to, and above all nothing to withdraw
    // a moment later — a control that appears and vanishes is the second half of
    // the complaint.
    const g = gatesFor(surfaceOf({ status: 'starting', terminal: 'unknown' }))
    expect(g.terminalMounted).toBe(false)
    expect(g.nativePaneRendered).toBe(false)
    expect(g.modeSwitchOffered).toBe(false)
    expect(g.terminalActive).toBe(false)
  })

  it('does NOT hold a live session neutral — that is a legacy row, and it has a terminal', () => {
    // The scoping that keeps this from swallowing every pre-driver-family
    // session: an older daemon, a legacy row, and a daemon that has not
    // reconnected since a server restart are all `live` with no family, none of
    // them is waiting for anything, and all of them have a PTY.
    expect(surfaceOf({ status: 'live', terminal: 'unknown', mode: 'native' })).toEqual({
      kind: 'live',
      view: 'native',
    })
    expect(gatesFor(surfaceOf({ status: 'live', terminal: 'unknown' })).terminalMounted).toBe(true)
  })

  it('leaves the read-only states alone — they never consult it', () => {
    // A parked or exited session shows its transcript whatever drove it, and the
    // veil owns the pane during a move. `pending` must not have taken those.
    expect(surfaceOf({ status: 'hibernated', terminal: 'unknown' }).kind).toBe('parked')
    expect(surfaceOf({ status: 'exited', terminal: 'unknown' }).kind).toBe('ended')
    expect(surfaceOf({ status: 'starting', terminal: 'unknown', inTransit: true }).kind).toBe(
      'transit',
    )
  })
})

describe('the switcher, once offered, is never withdrawn', () => {
  it('keeps the switch on a session that stopped having a terminal', () => {
    // The operator's words: "the native and chat button vanished?!". A control
    // disappearing under the cursor cannot be read as anything but a fault, so
    // the panel keeps its promise even when the fact behind it changes — which a
    // re-spawn onto a different driver genuinely can do.
    const g = gatesFor(surfaceOf({ status: 'live' }), {
      terminalCapable: false,
      switchAlreadyOffered: true,
    })
    expect(g.modeSwitchOffered).toBe(true)
  })

  it('does not make the PANE sticky with it — the switch lands somewhere honest', () => {
    // What stickiness costs is a switch to a pane with no PTY behind it, and the
    // answer to that is a pane that says so, not a spinner and not a blank.
    const g = gatesFor(surfaceOf({ status: 'live', mode: 'native' }), {
      terminalCapable: false,
      switchAlreadyOffered: true,
    })
    expect(g.terminalMounted).toBe(false)
    expect(g.nativePaneRendered).toBe(false)
    expect(g.noTerminalPaneShown).toBe(true)
  })

  it('still never offers it on a session that has never had one', () => {
    // Stickiness is a promise not to take something back, not a reason to give
    // it out: a headless session that was never offered the switch stays without
    // it, which is what makes the affordance readable from t=0.
    expect(
      gatesFor(surfaceOf({ status: 'live' }), {
        terminalCapable: false,
        switchAlreadyOffered: false,
      }).modeSwitchOffered,
    ).toBe(false)
  })

  it('shows no no-terminal pane while chat is the view', () => {
    // It is the NATIVE view's honest state, not a banner: a headless session
    // sitting in chat has nothing to explain.
    expect(
      gatesFor(surfaceOf({ status: 'live', mode: 'chat' }), { terminalCapable: false })
        .noTerminalPaneShown,
    ).toBe(false)
  })
})
