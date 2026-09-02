import type {
  ConnectionState,
  SessionConnection,
  SocketHub,
} from '@podium/client-core/socket-transport'
import { extractCodexPromptDraft } from '@podium/composer'
import type { SessionId } from '@podium/model'
import { DomViewportSource } from './dom-viewport'
import { decideResizeAction, type Grid } from './session-viewport'
import {
  createTerminalDiagnosticRecorder,
  terminalDiagnosticsSnapshot,
} from './terminal-diagnostics'
import {
  colorSchemeReport,
  DEFAULT_THEME,
  type TerminalAppearance,
  TerminalView,
} from './terminal-view'
import { mountKeyToolbar } from './toolbar'

export interface MountSessionOptions {
  hub: SocketHub
  sessionId: SessionId
  toolbarEl?: HTMLElement
  test?: boolean
  /** Opt-in input-event→paint diagnostics. Disabled by default. */
  echoLatencyEnabled?: boolean
  onState?: (state: ConnectionState) => void
  /**
   * Fires once, on the first non-empty PTY frame. NOTE: this fires only when output
   * actually lands — it is NOT a reliable readiness signal, because a session that
   * reattaches with an empty replay buffer (e.g. after a server restart) and an idle
   * child blocked on input produces no frame. Use {@link onReady} to gate the
   * "Starting…" overlay; keep this for output-specific work.
   */
  onFirstFrame?: () => void
  /**
   * Fires ONCE the session is ready to use: the moment the server confirms the
   * attach (the PTY is bound), or the first real frame lands, or the
   * {@link readyTimeoutMs} backstop elapses — whichever is first. Unlike
   * onFirstFrame this does NOT wait for output, so a session idling at a prompt
   * (empty replay buffer) is recognised as ready instead of hanging the panel's
   * "Starting…" overlay forever. Prefer this over onFirstFrame for gating it.
   */
  onReady?: () => void
  /**
   * Backstop for {@link onReady}: if neither an attach nor a frame arrives within
   * this many ms, fire onReady anyway so a stalled handshake can never trap the UI
   * in a permanent "Starting…" overlay. Defaults to {@link READY_TIMEOUT_MS}.
   */
  readyTimeoutMs?: number
  /**
   * Fires on every PTY frame written to the view. The panel uses this to sample
   * the rendered prompt region (debounced) and mirror the native input into the
   * shared chat draft. Distinct from onFirstFrame (which fires once).
   */
  onFrame?: () => void
  /**
   * Focus the terminal as soon as it mounts (default true). The panel sets this
   * false so the soft keyboard doesn't pop up over the "Starting…" overlay on a
   * mobile spawn — it focuses itself once the first frame lands instead.
   */
  focusOnMount?: boolean
  /**
   * Whether this panel is the active, foreground tab. Only an active panel on a
   * visible page may drive the PTY size (and claim control). Defaults to true so
   * existing single-panel callers are unaffected. Toggle at runtime via
   * MountedSession.setActive — the panel is NOT remounted on tab switches.
   */
  active?: boolean
  /** Initial rendering appearance (font, line height, theme). Change at runtime
   *  via {@link MountedSession.setAppearance} — never a remount. */
  appearance?: TerminalAppearance
  /** Optional crop viewport around the xterm host. Defaults to the host itself. */
  viewportEl?: HTMLElement
  /**
   * How this client reconciles its container with the PTY's one authoritative
   * grid. `control` (default) keeps the existing latest-active-client policy:
   * revealing the pane takes control and fits the PTY to this container.
   * `server-grid` keeps a spectator at the server grid and lets its container
   * crop/pan; it reports its fitted viewport for a later explicit takeover but
   * does not preempt another device merely because the pane became visible.
   */
  gridMode?: 'control' | 'server-grid'
  /**
   * THE SIZE THIS BUFFER IS BORN AT (POD-3239 B1 / MODEL rule 2).
   *
   * The session's last-known grid W, straight from the store. A terminal that
   * knows W constructs at W, so the very first painted frame is already the right
   * shape — no default is ever painted and nothing has to move it afterwards.
   *
   * Omitted only when there is genuinely no last-known grid (an older server that
   * does not send one). xterm's own 80x24 default then stands, and the attach
   * corrects it.
   */
  initialGeometry?: { cols: number; rows: number }
  /**
   * What {@link initialGeometry} is WORTH (MODEL rule 6). `unknown` — the
   * default — RENDERS: inside the system W can only change through the daemon,
   * so last-known is right until the first ask corrects it. `absent` means there
   * is no pty and the caller should not be mounting at all; the panel's own gate
   * owns that decision, and this is here so a mount cannot silently paint a grid
   * for a session that has none.
   */
  geometryState?: 'current' | 'unknown' | 'absent'
}

export interface MountedSession {
  connection: SessionConnection
  view: TerminalView
  /** Send user input, taking control first when a server-grid spectator starts
   *  interacting. The atomic claim makes the first byte land as controller. */
  sendInput(data: string): void
  /**
   * Claim control of the shared PTY WITHOUT typing anything (POD-724).
   *
   * A server-grid spectator (the phone) is deliberately not driving the PTY
   * size, so a wide desktop TUI arrives cropped and has to be panned. The only
   * way to be sized for this screen used to be the implicit takeover inside
   * {@link sendInput} — you had to send a keystroke into someone else's session
   * to be able to READ it. This is that takeover made explicit, and it is on the
   * mount rather than on `connection` because the viewport sample belongs with
   * the fit logic: THIS client's measured grid rides on the control claim, so
   * the server applies both in one mutation instead of trusting whatever the
   * debounced resize observer last sent.
   * Control mode has nothing to withhold, so there it is just the request.
   */
  takeControl(): void
  /** Toggle/reset input-event→paint diagnostics without remounting the PTY. */
  setEchoLatencyEnabled(enabled: boolean): void
  setActive(active: boolean): void
  /** Apply a new appearance to the live terminal and re-fit: a font-metric
   *  change alters the cell size, so the grid (and the PTY, via resize) must
   *  reconcile to the same container. Theme-only changes end up a no-op fit. */
  setAppearance(appearance: TerminalAppearance): void
  dispose(): void
}

/** Default {@link MountSessionOptions.readyTimeoutMs}: reveal the terminal even if the
 *  attach handshake stalls, so the "Starting…" overlay can never hang permanently. */
export const READY_TIMEOUT_MS = 2000

const SGR_MOUSE_REPORT = /\x1b\[<(\d+);\d+;\d+([Mm])/gu

/** True only when every byte is one or more SGR mouse-motion reports. */
function isOnlySgrMouseMotion(data: string): boolean {
  let offset = 0
  for (const match of data.matchAll(SGR_MOUSE_REPORT)) {
    const button = Number(match[1])
    if (match.index !== offset || match[2] !== 'M' || (button & 32) === 0) return false
    offset += match[0].length
  }
  return offset > 0 && offset === data.length
}

/**
 * Codex can paint a composer before startup work (notably MCP initialization)
 * redraws it. Its safe synthetic-input boundary is stricter than "some output":
 * DECSET 2004 must be enabled and the dim-stripped empty composer must be on
 * screen. The browser harness additionally holds this predicate through a quiet
 * window so a later redraw resets the wait. [spec:SP-e639]
 */
export function codexInputReady(
  view: Pick<TerminalView, 'bracketedPasteMode' | 'screenText'>,
): boolean {
  if (!view.bracketedPasteMode()) return false
  return extractCodexPromptDraft(view.screenText({ dropDim: true }).split('\n')) === ''
}

export function mountSession(el: HTMLElement, opts: MountSessionOptions): MountedSession {
  const { hub, sessionId } = opts
  const gridMode = opts.gridMode ?? 'control'
  const viewportEl = opts.viewportEl ?? el
  const diagnostics = createTerminalDiagnosticRecorder(sessionId)
  // BORN AT W (B1). `absent` is the one state that must not paint a grid — there
  // is no pty behind the row — so it falls back to xterm's own default, which the
  // panel keeps behind its transcript/overlay.
  const birthGeometry = opts.geometryState === 'absent' ? undefined : opts.initialGeometry
  const view = new TerminalView({
    ...(opts.appearance ?? {}),
    ...(birthGeometry ? { cols: birthGeometry.cols, rows: birthGeometry.rows } : {}),
    // xterm's WebGL canvas does not repaint sections revealed by scrolling an
    // independent overflow ancestor. Server-grid mode deliberately uses that
    // crop layout, so keep its rendering phone-local and deterministic with the
    // built-in DOM renderer; ordinary fitted terminals retain WebGL.
    renderer: gridMode === 'server-grid' ? 'dom' : 'auto',
    diagnostics: (event, data) => diagnostics.record(event, data),
  })
  view.mount(el)

  // The background last applied to the view — a later setAppearance compares
  // against it to detect a real colour change (issue recolour, user theme
  // edit) worth reporting to a mode-2031 subscriber.
  let lastBackground = (opts.appearance?.theme ?? DEFAULT_THEME).background

  let active = opts.active ?? true
  /**
   * HAS THE SERVER TOLD US ANYTHING YET? (POD-3239 B2 / MODEL rule 1.)
   *
   * False until `onAttached`. Before that, every `onState` is ignored FOR
   * GEOMETRY — a pre-attach state carries no grid at all now, and the emits that
   * used to carry a fabricated one (`requestControl`, `welcome`) are exactly how
   * a mounted terminal got dragged to 80x24 before the attach had said anything.
   *
   * After it, the attach snapshot is W and the buffer follows the server
   * unconditionally: visible or hidden, controller or spectator.
   */
  let authoritative = false
  let serverGrid: Grid = { cols: view.cols(), rows: view.rows() }
  const pageVisible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState === 'visible'
  const eligible = (): boolean => active && pageVisible()
  const trace = (event: string, data: Record<string, unknown> = {}): void => {
    diagnostics.record(event, {
      active,
      pageVisible: pageVisible(),
      eligible: eligible(),
      authoritative,
      serverGrid: { ...serverGrid },
      gridMode,
      ...data,
      view: view.diagnosticSnapshot(),
    })
  }
  // In control mode a fitted grid is a claim, not merely a proposal. Keep the
  // applied grid while the server acknowledges it: a delayed state echo can
  // carry the old winsize after the correct claim and must not reflow the view.
  let assertedControlGrid: Grid | null = null
  let controlRepairRaf: number | undefined
  let repairingControlGrid = false
  // xterm derives mouse mode from replayed bytes. While a hidden live pane is
  // becoming visible, hold motion until POD-2602's geometry claim establishes
  // that the PTY has caught up with this renderer. Releases and keys never wait.
  let revealMouseInputHeld = false
  let revealMouseTarget: Grid | null = null

  const sameGrid = (left: Grid, right: Grid): boolean =>
    left.cols === right.cols && left.rows === right.rows

  function hasOtherController(state: ConnectionState): boolean {
    return (
      state.role === 'spectator' &&
      state.controllerId !== null &&
      state.requestedGeometry === null
    )
  }

  function cancelControlRepair(): void {
    if (controlRepairRaf !== undefined) cancelAnimationFrame(controlRepairRaf)
    controlRepairRaf = undefined
  }

  function clearControlAssertion(): void {
    assertedControlGrid = null
    cancelControlRepair()
  }

  function holdRevealMouseInput(): void {
    revealMouseInputHeld = true
    revealMouseTarget = null
    trace('reveal:mouse-input-held')
  }

  function clearRevealMouseInput(source: string): void {
    if (!revealMouseInputHeld) return
    revealMouseInputHeld = false
    revealMouseTarget = null
    trace('reveal:mouse-input-released', { source })
  }

  function scheduleControlRepair(state: ConnectionState): void {
    const asserted = assertedControlGrid
    if (
      gridMode !== 'control' ||
      asserted === null ||
      !eligible() ||
      !state.connected ||
      hasOtherController(state)
    )
      return
    if (controlRepairRaf !== undefined || repairingControlGrid) return
    trace('connection:repair-scheduled', { state, asserted })
    controlRepairRaf = requestAnimationFrame(() => {
      controlRepairRaf = undefined
      const expected = assertedControlGrid
      if (gridMode !== 'control' || expected === null || !eligible()) return
      const latest = connection.state()
      if (!latest.connected || hasOtherController(latest)) {
        if (hasOtherController(latest)) clearControlAssertion()
        return
      }
      const applied = { cols: view.cols(), rows: view.rows() }
      if (!sameGrid(applied, expected)) {
        trace('connection:repair-skipped', { expected, applied })
        return
      }
      repairingControlGrid = true
      try {
        trace('connection:repair-claim', { grid: expected, state: latest })
        connection.requestControl({ ...expected })
      } finally {
        repairingControlGrid = false
      }
    })
  }
  trace('mount')

  // fit-with-retry: a measurable container fits immediately; an unmeasurable one
  // (just-revealed, layout not settled) retries across rAFs, then falls back to a
  // few longer timeouts — layout after a heavy workspace remount (or a web-font
  // load) can take well past 10 frames, and a fixed rAF cap that then gives up
  // FOREVER left panes wrapped at a stale tiny grid until a window resize (#29).
  // A new request RESTARTS the schedule with the newest onMeasured (it never
  // drops the request — the old code silently discarded fits that arrived while
  // a retry loop was in flight, so the ResizeObserver backstop could lose the
  // one event that carried the real size). onMeasured runs once a grid is
  // obtained; a request that outlives every backstop is abandoned — the next
  // viewport change or reveal schedules a fresh one.
  const RAF_FIT_RETRIES = 10
  const SLOW_FIT_DELAYS_MS = [250, 500, 1000]
  let fitAttempt = 0
  let fitRaf: number | undefined
  let fitTimer: ReturnType<typeof setTimeout> | undefined
  let measureFit = (): Grid | undefined => view.fit()
  let onFitMeasured: ((grid: Grid) => void) | null = null
  function cancelScheduledFit(): void {
    if (fitRaf !== undefined) cancelAnimationFrame(fitRaf)
    if (fitTimer !== undefined) clearTimeout(fitTimer)
    fitRaf = undefined
    fitTimer = undefined
    onFitMeasured = null
  }
  function tryScheduledFit(): void {
    fitRaf = undefined
    fitTimer = undefined
    // Hidden again mid-schedule: abandon — a hidden pane must never drive the PTY
    // size. The next reveal/viewport change schedules a fresh fit.
    if (!eligible()) {
      onFitMeasured = null
      trace('fit:cancelled', { attempt: fitAttempt, reason: 'ineligible' })
      return
    }
    const grid = measureFit()
    if (grid) {
      const cb = onFitMeasured
      onFitMeasured = null
      trace('fit:measured', {
        phase: fitAttempt === 0 ? 'immediate' : 'retry',
        attempts: fitAttempt,
        grid,
      })
      cb?.(grid)
      return
    }
    fitAttempt += 1
    if (fitAttempt <= RAF_FIT_RETRIES) {
      fitRaf = requestAnimationFrame(tryScheduledFit)
      return
    }
    const delay = SLOW_FIT_DELAYS_MS[fitAttempt - RAF_FIT_RETRIES - 1]
    if (delay !== undefined) fitTimer = setTimeout(tryScheduledFit, delay)
    else {
      onFitMeasured = null
      trace('anomaly:fit-retries-exhausted', { attempts: fitAttempt })
    }
  }
  function fitWithRetry(
    onMeasured: (grid: Grid) => void,
    measure: () => Grid | undefined = () => view.fit(),
  ): void {
    if (onFitMeasured) trace('fit:superseded', { attempt: fitAttempt })
    cancelScheduledFit()
    fitAttempt = 0
    measureFit = measure
    onFitMeasured = onMeasured
    trace('fit:retry-start')
    tryScheduledFit()
  }

  let reportedViewport: Grid | null = null
  const proposeViewport = (): Grid | undefined =>
    viewportEl === el ? view.proposeFit() : view.proposeFitIn(viewportEl)
  function reportViewport(): void {
    if (!eligible()) {
      trace('viewport-report:skipped', { reason: 'ineligible' })
      return
    }
    fitWithRetry((grid) => {
      if (reportedViewport?.cols === grid.cols && reportedViewport.rows === grid.rows) return
      reportedViewport = grid
      trace('viewport-report:send', { grid })
      // The server records every client's resize even when it is not controller.
      // It does not apply this grid until an explicit takeover.
      connection.reportViewport(grid.cols, grid.rows)
    }, proposeViewport)
  }

  function applyFit(forceRedrawIfSame: boolean): void {
    if (!eligible()) {
      trace('fit:skipped', { reason: 'ineligible', forceRedrawIfSame })
      return
    }
    fitWithRetry(
      (grid) => {
        // server-grid: do NOT optimistically resize the local xterm to the phone
        // viewport. Attach replay and live frames still encode the server's
        // authoritative geometry until the resize is applied and the TUI
        // repaints; shrinking first reflows that stream into shredded fragments
        // (Grok/Claude multi-pane TUIs on mobile). Keep the local grid on
        // serverGrid (crop-and-pan) and only sendResize — onState applies the
        // new geometry when the server broadcasts it.
        const action = decideResizeAction(grid, serverGrid, { forceRedrawIfSame })
        trace('fit:action', { grid, action, forceRedrawIfSame })
        if (action.kind === 'resize') {
          if (gridMode === 'server-grid') {
            // A controller phone repairs geometry through the same atomic claim
            // as an explicit takeover. This is intentionally idempotent when it
            // already owns control: the server still applies/acknowledges this
            // viewport without bumping the controller epoch.
            connection.requestControl({ cols: action.cols, rows: action.rows })
          } else {
            connection.sendResize(action.cols, action.rows)
          }
        } else if (action.kind === 'redraw') {
          connection.redraw()
        }
      },
      gridMode === 'server-grid' ? proposeViewport : undefined,
    )
  }

  function becomeEligible(): void {
    if (!eligible()) {
      trace('eligible:skipped')
      return
    }
    trace('eligible:became')
    if (gridMode === 'server-grid' && connection.state().role === 'spectator') {
      reportViewport()
      view.forceRepaint()
      return
    }
    if (gridMode === 'server-grid') {
      applyFit(true)
      view.repaintRecover()
      return
    }
    if (gridMode === 'control') connection.requestControl() // last-foregrounded-wins
    applyFit(true) // force a repaint on reveal even when the size is unchanged
    view.forceRepaint()
  }

  // Retry a fit across animation frames until the container is genuinely measurable — a
  // just-revealed panel (display:none → flex) hasn't laid out yet, so an immediate fit reads
  // a zero/stale size and view.fit() returns undefined. Reports whether the fit actually
  // CHANGED the local grid: xterm resizes optimistically inside fit(), and a real size change
  // recomputes pixel geometry, clears the renderer model and repaints in full — so a changed
  // grid has already recovered the canvas, while an unchanged one has not. The DomViewportSource
  // ResizeObserver is the longer-term backstop, so giving up after ~1s is safe.
  const MAX_REVEAL_FIT_RETRIES = 60
  // A foregrounded document can report a non-zero, otherwise plausible grid
  // before xterm's renderer has caught up with the canvas becoming visible.
  // Sampling through two more frames lets the browser commit that layout before
  // we resize the PTY. This is deliberately short: it prevents the first stale
  // fit from becoming daemon geometry without making a reveal feel delayed.
  const REVEAL_LAYOUT_SETTLE_FRAMES = 2
  let revealGeneration = 0
  function whenMeasurable(onMeasured: (grid: Grid, gridChanged: boolean) => void): void {
    const generation = ++revealGeneration
    let measurableFrames = 0
    const tryFit = (attempt: number): void => {
      if (generation !== revealGeneration || !eligible()) {
        trace('reveal:cancelled', { attempt })
        return // hidden again before layout settled
      }
      // FitAddon can return a valid grid from the previous renderer metrics while
      // a tab is being foregrounded. Probe without changing xterm's local grid,
      // then require consecutive visible frames before committing the fit.
      const proposed = view.proposeFit()
      if (proposed) {
        measurableFrames += 1
        if (measurableFrames > REVEAL_LAYOUT_SETTLE_FRAMES) {
          const before = { cols: view.cols(), rows: view.rows() }
          const grid = view.fit()
          if (grid) {
            // TerminalView.fit() measures more than once: FitAddon.fit() performs
            // its own proposeDimensions call after TerminalView's readiness probe.
            // A cached, valid proposal can therefore be applied even after the
            // pre-fit samples have started reporting the real layout. Validate the
            // grid that actually reached xterm and require the next proposal to
            // agree before allowing it to drive the daemon.
            const applied = { cols: view.cols(), rows: view.rows() }
            const settled = view.proposeFit()
            if (
              grid.cols === applied.cols &&
              grid.rows === applied.rows &&
              settled?.cols === applied.cols &&
              settled?.rows === applied.rows
            ) {
              const gridChanged = applied.cols !== before.cols || applied.rows !== before.rows
              trace('reveal:measured', { attempt, before, proposed, applied, gridChanged })
              onMeasured(applied, gridChanged)
              return
            }
            trace('reveal:fit-mismatch', { attempt, before, proposed, grid, applied, settled })
          }
          // The probe, the applied grid, and the post-fit measurement must agree;
          // otherwise start a fresh consecutive-valid streak on the next frame.
          measurableFrames = 0
        }
      } else {
        measurableFrames = 0
      }
      if (attempt < MAX_REVEAL_FIT_RETRIES) {
        requestAnimationFrame(() => tryFit(attempt + 1))
        return
      }
      trace('anomaly:reveal-fit-retries-exhausted', { attempts: attempt + 1 })
      clearRevealMouseInput('fit-retries-exhausted')
    }
    tryFit(0)
  }

  // A true REVEAL — the panel was hidden with display:none (a tab switch) or the page was
  // backgrounded, either of which frees the WebGL canvas's backing store so it comes back blank.
  // Once the container is laid out, fit it and atomically re-claim control:
  //   - If the fit CHANGES the grid, xterm's resize has already recomputed geometry, cleared the
  //     renderer model and repainted in full — the same path a browser-window resize takes, which
  //     is exactly what recovers a freed canvas. Nothing more to do (and we inform the server when
  //     our viewport differs from its authoritative grid).
  //   - If the grid is UNCHANGED, a same-size resize is a no-op that won't repaint the freed
  //     canvas, so clear the live renderer's atlas/model and repaint it in place. Swapping the
  //     renderer would stale xterm's wheel-scroll dimensions and churn limited WebGL contexts.
  // Sizing waits for real layout plus a short post-layout settle, so the recompute can't run
  // against a still-hidden/zero-size canvas; whenMeasurable re-checks eligibility each frame.
  function reveal(): void {
    if (!eligible()) {
      trace('reveal:skipped')
      return
    }
    trace('reveal:start')
    if (gridMode === 'server-grid' && connection.state().role === 'spectator') {
      reportViewport()
      view.repaintRecover()
      return
    }
    if (gridMode === 'server-grid') {
      applyFit(true)
      view.repaintRecover()
      return
    }
    holdRevealMouseInput()
    whenMeasurable((grid, gridChanged) => {
      if (!eligible()) {
        trace('reveal:cancelled', { phase: 'measured-callback' })
        return
      }
      if (gridMode === 'control') {
        // Carry the measured grid on the claim. The server records it before
        // applying the request, so a viewState/resize ordering race cannot
        // leave the daemon at the stale pre-tab geometry.
        const applied = { cols: view.cols(), rows: view.rows() }
        if (!sameGrid(applied, grid)) {
          trace('reveal:claim-mismatch', { grid, applied })
          return
        }
        trace('reveal:control-claim', { grid, gridChanged })
        assertedControlGrid = { ...grid }
        connection.requestControl({ cols: grid.cols, rows: grid.rows })
        // Set after requestControl: its local pending-state emit is synchronous.
        // Only a later server acknowledgment may release this reveal fence.
        if (revealMouseInputHeld) revealMouseTarget = { ...grid }
      } else if (grid.cols !== serverGrid.cols || grid.rows !== serverGrid.rows) {
        trace('reveal:resize-send', { grid, gridChanged })
        connection.sendResize(grid.cols, grid.rows)
      }
      if (!gridChanged) {
        trace('reveal:recover-renderer', { grid })
        view.repaintRecover()
      }
    })
  }

  /**
   * Move the buffer to the server's grid, and only ever to the server's grid
   * (MODEL rule 2). The clear + repaint are kept: xterm reflows the old buffer
   * into the new shape, and for an alt-screen TUI that content is garbage until
   * the app's own SIGWINCH repaint arrives, so blank-then-clean beats shredded
   * mid-width fragments.
   */
  function applyServerGrid(state: ConnectionState, source: string): void {
    const { cols, rows } = state
    if (cols === undefined || rows === undefined) return
    serverGrid = { cols, rows }
    if (view.cols() === cols && view.rows() === rows) return
    trace('connection:apply-server-grid', { state, source })
    view.resize(cols, rows)
    view.clear()
    // A resize/reflow can leave the GPU canvas showing only the cells that moved
    // or changed (the "caret at top, my text at bottom, rest black" symptom).
    view.forceRepaint()
  }

  let lastEpoch = -1
  // Defense in depth for embedders that deliver onState directly. Production
  // geometry ordering is enforced before emission by
  // SessionConnection.acceptGeometryRevision.
  let lastGeometryRevision: number | undefined
  let geometryTimelineResetPending = false
  let firstFrameSeen = false
  // Tracks whether we've seen an attach before, so onAttached can tell a fresh mount
  // (sizing already driven by the mount/setActive path) from a RECONNECT (where we must
  // re-assert the size — see the onAttached handler).
  let everAttached = false
  let lastTracedState = ''
  let lastRole: ConnectionState['role'] = 'spectator'

  // Ready = "usable, drop the Starting… overlay". Fires on the FIRST of: the server
  // confirming the attach (onAttached), the first real frame, or the timeout backstop
  // — so an idle child with an empty replay buffer is never mistaken for still booting.
  let ready = false
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  const markReady = (source: 'attach' | 'frame' | 'timeout'): void => {
    if (ready) return
    ready = true
    if (readyTimer !== undefined) clearTimeout(readyTimer)
    trace('ready', { source })
    opts.onReady?.()
  }
  readyTimer = setTimeout(() => markReady('timeout'), opts.readyTimeoutMs ?? READY_TIMEOUT_MS)

  const connection = hub.attach(sessionId, {
    onAttached: () => {
      trace('connection:attached', { reconnect: everAttached, connection: connection.state() })
      markReady('attach')
      geometryTimelineResetPending = false
      // THE ATTACH SNAPSHOT IS THE FIRST AUTHORITATIVE W, AND IT IS APPLIED HERE
      // (B2). `attached` sets cols/rows and emits its state BEFORE this callback
      // runs (0b C3), so there is no later event to wait for — a mount that
      // waited would sit at its birth grid until something unrelated moved it.
      authoritative = true
      applyServerGrid(connection.state(), 'attach')
      // RECONNECT re-fit. A server reload rebuilds the session at the 80×24 default and
      // the 'attached' message carries that grid; _ingest emits onState (serverGrid →
      // 80×24, the view shrinks) BEFORE this callback, so re-fitting here sees the
      // mismatch and re-asserts our real viewport (and re-claims control, which the
      // restarted server also reset). Without this the terminal stays stuck quarter-
      // sized until a manual resize/tab-switch. Skip the first attach — the mount /
      // setActive path already sized it, and re-running would double-bump the epoch.
      if (everAttached && eligible()) becomeEligible()
      everAttached = true
    },
    onFrame: (bytes) => {
      view.write(bytes)
      if (!firstFrameSeen && bytes.length > 0) {
        firstFrameSeen = true
        opts.onFirstFrame?.()
        markReady('frame')
      }
      opts.onFrame?.()
    },
    // A full replay is incoming (fresh mount, or a reconnect whose gap outran the
    // server's buffer): wipe before the buffered frames rebuild the screen. A
    // resuming reconnect does NOT fire this — it keeps the screen and appends only
    // what it missed, so a network blip no longer flashes the whole terminal.
    onReset: () => {
      trace('connection:reset', { connection: connection.state() })
      lastEpoch = connection.state().epoch
      lastGeometryRevision = undefined
      geometryTimelineResetPending = false
      view.clear()
    },
    onGeometryTimelineReset: () => {
      // A restarted server may resume with no frames; reset ordering without
      // clearing the screen. onReset owns the full-replay clear below.
      lastGeometryRevision = undefined
      geometryTimelineResetPending = true
    },
    onState: (state) => {
      const signature = JSON.stringify([
        state.connected,
        state.role,
        state.cols,
        state.rows,
        state.epoch,
        state.controllerId,
        state.geometryRevision ?? null,
        state.requestedGeometry?.cols ?? null,
        state.requestedGeometry?.rows ?? null,
        state.outputSeen,
      ])
      if (signature !== lastTracedState) {
        lastTracedState = signature
        trace('connection:state', { state })
      }
      const geometryRevision = state.geometryRevision
      const staleGeometry =
        geometryRevision !== undefined &&
        lastGeometryRevision !== undefined &&
        geometryRevision < lastGeometryRevision
      if (staleGeometry) {
        trace('connection:stale-geometry-state', {
          state,
          acceptedRevision: lastGeometryRevision,
        })
      } else if (geometryRevision !== undefined) {
        lastGeometryRevision = geometryRevision
      }
      const geometrySuppressed = geometryTimelineResetPending || staleGeometry
      if (hasOtherController(state)) {
        clearControlAssertion()
        clearRevealMouseInput('other-controller')
      }
      const applied = { cols: view.cols(), rows: view.rows() }
      // A state with no grid at all is the pre-attach case (B8): the connection
      // has not been told one and there is nothing to fence against. Fall back
      // to what the view already shows, so every comparison below reads "no
      // disagreement" rather than comparing against a fabricated number.
      const stateGrid: Grid =
        state.cols !== undefined && state.rows !== undefined
          ? { cols: state.cols, rows: state.rows }
          : applied
      const requested = state.requestedGeometry ?? null
      if (
        !geometrySuppressed &&
        revealMouseTarget !== null &&
        state.connected &&
        state.role === 'controller' &&
        requested === null &&
        sameGrid(stateGrid, revealMouseTarget)
      ) {
        clearRevealMouseInput('geometry-acknowledged')
      }
      // requestControl/sendResize publish requestedGeometry before the stale
      // state echo. Prefer that newer local intent when xterm already applied it.
      // The existing assertion remains the fallback after the request settles.
      const pendingRequestedGrid =
        !geometrySuppressed &&
        requested !== null &&
        sameGrid(applied, requested) &&
        !sameGrid(stateGrid, requested)
          ? { ...requested }
          : null
      // The assertion fences only an in-flight local claim. Once the transport
      // clears requestedGeometry, a different server grid supersedes that claim.
      if (
        !geometrySuppressed &&
        assertedControlGrid !== null &&
        pendingRequestedGrid === null &&
        state.requestedGeometry === null &&
        !sameGrid(stateGrid, applied)
      ) {
        trace('connection:assertion-superseded', {
          state,
          asserted: assertedControlGrid,
        })
        clearControlAssertion()
      }
      const asserted = geometrySuppressed ? null : pendingRequestedGrid ?? assertedControlGrid
      const holdClaimedGrid =
        !geometrySuppressed &&
        gridMode === 'control' &&
        state.connected &&
        asserted !== null &&
        sameGrid(applied, asserted) &&
        !sameGrid(stateGrid, asserted) &&
        (state.role === 'controller' ||
          state.controllerId === null ||
          (state.requestedGeometry !== null && sameGrid(state.requestedGeometry, asserted)))
      // NOT AUTHORITATIVE YET ⇒ NOTHING HERE MAY MOVE THE BUFFER (B2). Before
      // the attach, a state carries no grid at all; after it, the attach
      // snapshot has already been applied in `onAttached` and every later state
      // is the server telling us W changed.
      if (authoritative && !geometrySuppressed && !holdClaimedGrid) {
        applyServerGrid(state, 'state')
      }
      if (authoritative && !geometrySuppressed && holdClaimedGrid) {
        if (asserted !== null) {
          assertedControlGrid = { ...asserted }
        }
        trace('connection:hold-claimed-grid', { state, asserted })
        scheduleControlRepair(state)
        if (state.cols !== undefined && state.rows !== undefined) {
          serverGrid = { cols: state.cols, rows: state.rows }
        }
      }
      const roleChanged = state.role !== lastRole
      // Update before an atomic claim emits its local pending state; otherwise
      // that nested notification would look like a second role transition and
      // recursively claim again.
      lastRole = state.role
      if (gridMode === 'server-grid' && roleChanged && eligible()) {
        // The first attached client is made controller by the server. It should
        // still fit a phone-only session; only a spectator follows/crops.
        if (state.role === 'controller') applyFit(false)
        else reportViewport()
      }
      // Clear only on an in-session epoch bump — a controller takeover repaints the
      // grid for the new owner. The (re)attach clear is owned by onReset above, so a
      // plain reconnect that resumes from our cursor leaves the screen intact.
      if (state.connected) {
        if (lastEpoch === -1) lastEpoch = state.epoch
        else if (state.epoch !== lastEpoch) {
          trace('connection:epoch-clear', { from: lastEpoch, to: state.epoch })
          lastEpoch = state.epoch
          view.clear()
        }
      }
      el.dataset.role = state.role
      el.dataset.epoch = String(state.epoch)
      // A role transition may synchronously create a pending geometry claim.
      // Publish the connection's latest state so UI never overwrites “fitting”
      // with the stale pre-claim controller snapshot from this callback.
      opts.onState?.(connection.state())
    },
  })
  connection.setEchoLatencyEnabled?.(opts.echoLatencyEnabled ?? false)

  // A renderer lease is the per-CONNECTION answer to “who has this terminal on
  // screen?”. It complements person-level multiplayer presence: the same user
  // may have a desktop and phone, and both must count independently for sizing.
  // Acquire before any fit/control message so the server's visibility gate and
  // sole-renderer policy see one ordered truth on this socket.
  let releaseRendererLease: (() => void) | null = null
  const syncRendererLease = (): void => {
    // Optional guard keeps older embedders/test doubles source-compatible
    // during the additive client-core rollout.
    if (typeof hub.registerRenderedSession !== 'function') return
    if (eligible() && releaseRendererLease === null) {
      releaseRendererLease = hub.registerRenderedSession(sessionId, {
        mode: 'native',
        focused: true,
      })
    } else if (!eligible() && releaseRendererLease !== null) {
      releaseRendererLease()
      releaseRendererLease = null
    }
  }

  // An output frame is not yet a visible echo: xterm parses asynchronously and
  // the browser still has to paint its canvas/DOM. Wait for xterm's render event,
  // then cross the next animation frame before closing the sample. When the
  // probe is off this listener does one boolean check per render and schedules
  // nothing.
  let echoPaintRaf: number | undefined
  const offEchoRender =
    typeof view.onRender === 'function'
      ? view.onRender(() => {
          if (!connection.echoPaintPending?.() || echoPaintRaf !== undefined) return
          echoPaintRaf = requestAnimationFrame(() => {
            echoPaintRaf = undefined
            connection.markEchoPaint?.()
          })
        })
      : () => {}

  // Becoming the active tab of a visible page claims control (last-foregrounded-wins)
  // and fits the terminal to THIS client's viewport. We never resize/redraw/requestControl
  // while ineligible, so a hidden tab can't pin the shared PTY to its stale grid.
  syncRendererLease()
  if (active) becomeEligible()

  // The takeover itself, shared by the implicit path (first keystroke) and the
  // explicit one a client can offer as an action (POD-724). Whichever triggers
  // it, the server-grid spectator carries its OWN viewport on the control claim,
  // so the server applies ownership and size atomically. The resize observer is
  // debounced, so the grid is sampled synchronously HERE — a takeover that
  // immediately follows a rotation or a keyboard change must not pin the shared
  // PTY to the previous size. The role transition in onState then fits/repaints.
  function takeControl(): void {
    if (gridMode === 'server-grid') {
      const grid = proposeViewport()
      if (grid) {
        reportedViewport = grid
        connection.requestControl(grid)
        return
      }
    }
    connection.requestControl()
  }

  // Paste + arrows now live in the panel's React action row / D-pad above the key
  // bar, so the bar itself no longer renders a Paste key.
  const sendInput = (data: string, inputEventAt?: number): void => {
    if (revealMouseInputHeld && isOnlySgrMouseMotion(data)) {
      trace('input:reveal-mouse-motion-withheld', { bytes: data.length })
      return
    }
    // A spectator that starts typing means it: take control first so the first
    // byte lands as controller, on this client's own grid.
    if (gridMode === 'server-grid' && connection.state().role === 'spectator') takeControl()
    connection.sendInput(data, inputEventAt)
  }

  const toolbar = opts.toolbarEl ? mountKeyToolbar(opts.toolbarEl, { sendInput }) : null

  // Route keyboard input through the toolbar so an armed modifier (e.g. Ctrl)
  // transforms the next character the soft keyboard sends.
  const offInput = view.onData((data, inputEventAt) =>
    sendInput(toolbar ? toolbar.applyModifiers(data) : data, inputEventAt),
  )

  // Container-size changes (ResizeObserver + visualViewport) re-fit the grid. This
  // is the backstop that catches EVERY layout path — pane drags, dock toggles, and
  // the display:none → visible transition (ResizeObserver fires on it) — not just
  // window resizes. Debounced: a layout transition emits a burst of intermediate
  // sizes, and fitting each one would sendResize → SIGWINCH-flash the TUI per step.
  const VIEWPORT_FIT_DEBOUNCE_MS = 60
  let viewportFitTimer: ReturnType<typeof setTimeout> | undefined
  const viewport = new DomViewportSource(viewportEl)
  const offViewport = viewport.onChange((size) => {
    trace('viewport:changed', { viewport: size })
    if (viewportFitTimer !== undefined) clearTimeout(viewportFitTimer)
    viewportFitTimer = setTimeout(() => {
      viewportFitTimer = undefined
      if (gridMode === 'server-grid' && connection.state().role === 'spectator') reportViewport()
      else applyFit(false)
    }, VIEWPORT_FIT_DEBOUNCE_MS)
  })

  const onPageResume = (source: 'visibility-change' | 'focus' | 'pageshow'): void => {
    trace(`page:${source}`)
    syncRendererLease()
    if (eligible()) reveal() // page returning to the foreground is a reveal (canvas was freed)
  }
  const onVisibility = (): void => onPageResume('visibility-change')
  const onWindowFocus = (): void => onPageResume('focus')
  const onPageShow = (): void => onPageResume('pageshow')
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }
  if (typeof window !== 'undefined') {
    // Some Chromium/PWA paths restore focus without delivering a useful
    // visibility transition to the app. These events are cheap, and reveal's
    // generation guard coalesces duplicate callbacks from one tab return.
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('pageshow', onPageShow)
  }

  if (opts.focusOnMount !== false) view.focus()

  let testApi: unknown
  if (opts.test) {
    const api = {
      state: () => connection.state(),
      echoLatency: () => connection.echoLatency(),
      diagnostics: () => terminalDiagnosticsSnapshot(sessionId),
      // Client switch-latency traces [POD-701]. Read through the introspection
      // global the collector registers (client-core), so the terminal package
      // never imports it — an empty list before the collector module loads.
      switchTraces: () =>
        (
          globalThis as { __podiumSwitchTraces?: { recent(): unknown[] } }
        ).__podiumSwitchTraces?.recent() ?? [],
      screenHash: (screenOpts?: { dropDim?: boolean }) => view.screenHash(screenOpts),
      screenText: () => view.screenText(),
      codexInputReady: () => codexInputReady(view),
      sendInput,
      setEchoLatencyEnabled: (enabled: boolean) => connection.setEchoLatencyEnabled?.(enabled),
      // The same takeover the product's own action performs — one name, one
      // meaning, so a browser test cannot pass against a path nothing ships.
      takeControl,
      sessions: () => hub.sessions(),
      attach: (id: SessionId) => hub.attach(id),
      simulateKeyboard: (inset: number) => {
        // Percentage heights don't resolve when the parent has auto height, so we
        // compute the explicit pixel value from the element's current rendered height.
        // This ensures FitAddon sees a genuinely smaller container and recomputes rows.
        // With flex:1 layouts, flex-grow overrides a plain height. We set flex:none +
        // explicit height so the element actually renders at the smaller size.
        // FitAddon reads getComputedStyle(el).height, so the reflow must complete first.
        // We ensure the inset is at least 50% of the container so that row reduction
        // is reliable across different viewport sizes (e.g. fullscreen vs 70vh).
        if (inset > 0) {
          const currentH = viewportEl.getBoundingClientRect().height
          const effectiveInset = Math.max(inset, Math.ceil(currentH * 0.5))
          const newH = `${Math.max(1, currentH - effectiveInset)}px`
          viewportEl.style.flex = 'none'
          viewportEl.style.height = newH
          // Force a synchronous reflow so FitAddon reads the updated height
          void viewportEl.offsetHeight
        } else {
          viewportEl.style.flex = ''
          viewportEl.style.height = ''
          void viewportEl.offsetHeight
        }
        const grid = gridMode === 'server-grid' ? proposeViewport() : view.fit()
        // Mirror applyFit: server-grid keeps the local grid on the server until
        // geometry acks; only the PTY is asked to move.
        if (grid) connection.sendResize(grid.cols, grid.rows)
      },
    }
    testApi = api
    ;(globalThis as unknown as { __podium?: unknown }).__podium = api
  }

  return {
    connection,
    view,
    sendInput,
    takeControl,
    setEchoLatencyEnabled(enabled: boolean): void {
      connection.setEchoLatencyEnabled?.(enabled)
    },
    setActive(next: boolean): void {
      if (next === active) return
      active = next
      trace('panel:active-change', { next })
      syncRendererLease()
      // Becoming active = a reveal: the panel was display:none (its WebGL canvas freed),
      // so recover the renderer after layout, not just refresh immediately.
      if (active) {
        // The E2E API follows the pane a real click activated, even though warm
        // hidden panes remain mounted and retain their own terminal views.
        if (testApi) (globalThis as unknown as { __podium?: unknown }).__podium = testApi
        reveal()
      } else {
        clearControlAssertion()
        clearRevealMouseInput('panel-hidden')
      }
      // going inactive: do nothing — never resize a hidden panel
    },
    setAppearance(appearance: TerminalAppearance): void {
      // Colour-scheme report (contour mode 2031): when the running app
      // subscribed and the background genuinely changed, tell it so it can
      // re-query OSC 11 and repaint (Claude Code's `theme: auto`). The report
      // is PTY input, so it obeys the controller-only input rule — a
      // spectator's local appearance never speaks for the session.
      const nextBackground = (appearance.theme ?? DEFAULT_THEME).background
      if (
        nextBackground !== lastBackground &&
        view.colorSchemeNotifyEnabled() &&
        connection.state().role === 'controller'
      ) {
        connection.sendInput(colorSchemeReport(nextBackground))
      }
      lastBackground = nextBackground
      view.setAppearance(appearance)
      trace('appearance:change')
      // A font-metric change altered the cell size — reconcile the grid to the
      // container and inform the server (eligibility-gated inside applyFit, so
      // a hidden panel never drives the shared PTY). A theme-only change leaves
      // the grid identical and applyFit decides 'same' → nothing further.
      if (gridMode === 'server-grid' && connection.state().role === 'spectator') reportViewport()
      else applyFit(false)
    },
    dispose() {
      trace('dispose')
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      if (viewportFitTimer !== undefined) clearTimeout(viewportFitTimer)
      revealGeneration += 1
      clearControlAssertion()
      releaseRendererLease?.()
      releaseRendererLease = null
      cancelScheduledFit()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onWindowFocus)
        window.removeEventListener('pageshow', onPageShow)
      }
      offInput()
      offEchoRender()
      if (echoPaintRaf !== undefined) cancelAnimationFrame(echoPaintRaf)
      offViewport()
      toolbar?.dispose()
      viewport.dispose()
      hub.detach(sessionId)
      view.dispose()
    },
  }
}
