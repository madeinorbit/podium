import type { ConnectionState, SessionConnection, SocketHub } from './connection'
import { DomViewportSource } from './dom-viewport'
import { decideResizeAction, type Grid } from './session-viewport'
import {
  createTerminalDiagnosticRecorder,
  terminalDiagnosticsSnapshot,
} from './terminal-diagnostics'
import { type TerminalAppearance, TerminalView } from './terminal-view'
import { mountKeyToolbar } from './toolbar'

export interface MountSessionOptions {
  hub: SocketHub
  sessionId: string
  toolbarEl?: HTMLElement
  test?: boolean
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
}

export interface MountedSession {
  connection: SessionConnection
  view: TerminalView
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

export function mountSession(el: HTMLElement, opts: MountSessionOptions): MountedSession {
  const { hub, sessionId } = opts
  const diagnostics = createTerminalDiagnosticRecorder(sessionId)
  const view = new TerminalView({
    ...(opts.appearance ?? {}),
    diagnostics: (event, data) => diagnostics.record(event, data),
  })
  view.mount(el)

  let active = opts.active ?? true
  let serverGrid: Grid = { cols: view.cols(), rows: view.rows() }
  const pageVisible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState === 'visible'
  const eligible = (): boolean => active && pageVisible()
  const trace = (event: string, data: Record<string, unknown> = {}): void => {
    diagnostics.record(event, {
      active,
      pageVisible: pageVisible(),
      eligible: eligible(),
      serverGrid: { ...serverGrid },
      ...data,
      view: view.diagnosticSnapshot(),
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
    const grid = view.fit()
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
  function fitWithRetry(onMeasured: (grid: Grid) => void): void {
    if (onFitMeasured) trace('fit:superseded', { attempt: fitAttempt })
    cancelScheduledFit()
    fitAttempt = 0
    onFitMeasured = onMeasured
    trace('fit:retry-start')
    tryScheduledFit()
  }

  function applyFit(forceRedrawIfSame: boolean): void {
    if (!eligible()) {
      trace('fit:skipped', { reason: 'ineligible', forceRedrawIfSame })
      return
    }
    fitWithRetry((grid) => {
      const action = decideResizeAction(grid, serverGrid, { forceRedrawIfSame })
      trace('fit:action', { grid, action, forceRedrawIfSame })
      if (action.kind === 'resize') {
        connection.sendResize(action.cols, action.rows)
      } else if (action.kind === 'redraw') {
        connection.redraw()
      }
    })
  }

  function becomeEligible(): void {
    if (!eligible()) {
      trace('eligible:skipped')
      return
    }
    trace('eligible:became')
    connection.requestControl() // last-foregrounded-wins
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
  function whenMeasurable(onMeasured: (grid: Grid, gridChanged: boolean) => void): void {
    const tryFit = (attempt: number): void => {
      if (!eligible()) {
        trace('reveal:cancelled', { attempt })
        return // hidden again before layout settled
      }
      const before = { cols: view.cols(), rows: view.rows() }
      const grid = view.fit()
      if (grid) {
        const gridChanged = grid.cols !== before.cols || grid.rows !== before.rows
        trace('reveal:measured', { attempt, before, grid, gridChanged })
        onMeasured(grid, gridChanged)
        return
      }
      if (attempt < MAX_REVEAL_FIT_RETRIES) requestAnimationFrame(() => tryFit(attempt + 1))
      else {
        trace('anomaly:reveal-fit-retries-exhausted', { attempts: attempt + 1 })
      }
    }
    tryFit(0)
  }

  // A true REVEAL — the panel was hidden with display:none (a tab switch) or the page was
  // backgrounded, either of which frees the WebGL canvas's backing store so it comes back blank.
  // Re-claim control, then once the container is laid out, fit it:
  //   - If the fit CHANGES the grid, xterm's resize has already recomputed geometry, cleared the
  //     renderer model and repainted in full — the same path a browser-window resize takes, which
  //     is exactly what recovers a freed canvas. Nothing more to do (and we inform the server when
  //     our viewport differs from its authoritative grid).
  //   - If the grid is UNCHANGED, a same-size resize is a no-op that won't repaint the freed
  //     canvas, so clear the live renderer's atlas/model and repaint it in place. Swapping the
  //     renderer would stale xterm's wheel-scroll dimensions and churn limited WebGL contexts.
  // Sizing waits for real layout (no fixed-frame guess), so the recompute can't run against a
  // still-hidden/zero-size canvas; whenMeasurable re-checks eligibility each frame.
  function reveal(): void {
    if (!eligible()) {
      trace('reveal:skipped')
      return
    }
    trace('reveal:start')
    connection.requestControl() // last-foregrounded-wins
    whenMeasurable((grid, gridChanged) => {
      if (!eligible()) {
        trace('reveal:cancelled', { phase: 'measured-callback' })
        return
      }
      if (grid.cols !== serverGrid.cols || grid.rows !== serverGrid.rows) {
        trace('reveal:resize-send', { grid, gridChanged })
        connection.sendResize(grid.cols, grid.rows)
      }
      if (!gridChanged) {
        trace('reveal:recover-renderer', { grid })
        view.repaintRecover()
      }
    })
  }

  let lastEpoch = -1
  let firstFrameSeen = false
  // Tracks whether we've seen an attach before, so onAttached can tell a fresh mount
  // (sizing already driven by the mount/setActive path) from a RECONNECT (where we must
  // re-assert the size — see the onAttached handler).
  let everAttached = false
  let lastTracedState = ''

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
    onFrame: (text) => {
      view.write(text)
      if (!firstFrameSeen && text.length > 0) {
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
      view.clear()
    },
    onState: (state) => {
      const signature = JSON.stringify([
        state.connected,
        state.role,
        state.cols,
        state.rows,
        state.epoch,
        state.controllerId,
      ])
      if (signature !== lastTracedState) {
        lastTracedState = signature
        trace('connection:state', { state })
      }
      if (view.cols() !== state.cols || view.rows() !== state.rows) {
        trace('connection:apply-server-grid', { state })
        view.resize(state.cols, state.rows)
        // A resize/reflow can leave the GPU canvas showing only the cells that moved or
        // changed (the "caret at top, my text at bottom, rest black" symptom). Force a
        // full repaint so the whole grid redraws at the new geometry.
        view.forceRepaint()
      }
      serverGrid = { cols: state.cols, rows: state.rows }
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
      opts.onState?.(state)
    },
  })

  // Becoming the active tab of a visible page claims control (last-foregrounded-wins)
  // and fits the terminal to THIS client's viewport. We never resize/redraw/requestControl
  // while ineligible, so a hidden tab can't pin the shared PTY to its stale grid.
  if (active) becomeEligible()

  // Paste + arrows now live in the panel's React action row / D-pad above the key
  // bar, so the bar itself no longer renders a Paste key.
  const toolbar = opts.toolbarEl ? mountKeyToolbar(opts.toolbarEl, connection) : null

  // Route keyboard input through the toolbar so an armed modifier (e.g. Ctrl)
  // transforms the next character the soft keyboard sends.
  const offInput = view.onData((data) =>
    connection.sendInput(toolbar ? toolbar.applyModifiers(data) : data),
  )

  // Container-size changes (ResizeObserver + visualViewport) re-fit the grid. This
  // is the backstop that catches EVERY layout path — pane drags, dock toggles, and
  // the display:none → visible transition (ResizeObserver fires on it) — not just
  // window resizes. Debounced: a layout transition emits a burst of intermediate
  // sizes, and fitting each one would sendResize → SIGWINCH-flash the TUI per step.
  const VIEWPORT_FIT_DEBOUNCE_MS = 60
  let viewportFitTimer: ReturnType<typeof setTimeout> | undefined
  const viewport = new DomViewportSource(el)
  const offViewport = viewport.onChange((size) => {
    trace('viewport:changed', { viewport: size })
    if (viewportFitTimer !== undefined) clearTimeout(viewportFitTimer)
    viewportFitTimer = setTimeout(() => {
      viewportFitTimer = undefined
      applyFit(false)
    }, VIEWPORT_FIT_DEBOUNCE_MS)
  })

  const onVisibility = (): void => {
    trace('page:visibility-change')
    if (eligible()) reveal() // page returning to the foreground is a reveal (canvas was freed)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }

  if (opts.focusOnMount !== false) view.focus()

  if (opts.test) {
    ;(globalThis as unknown as { __podium?: unknown }).__podium = {
      state: () => connection.state(),
      echoLatency: () => connection.echoLatency(),
      diagnostics: () => terminalDiagnosticsSnapshot(sessionId),
      screenHash: () => view.screenHash(),
      screenText: () => view.screenText(),
      sendInput: (s: string) => connection.sendInput(s),
      takeControl: () => connection.requestControl(),
      sessions: () => hub.sessions(),
      attach: (id: string) => hub.attach(id),
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
          const currentH = el.getBoundingClientRect().height
          const effectiveInset = Math.max(inset, Math.ceil(currentH * 0.5))
          const newH = `${Math.max(1, currentH - effectiveInset)}px`
          el.style.flex = 'none'
          el.style.height = newH
          // Force a synchronous reflow so FitAddon reads the updated height
          void el.offsetHeight
        } else {
          el.style.flex = ''
          el.style.height = ''
          void el.offsetHeight
        }
        const grid = view.fit()
        if (grid) connection.sendResize(grid.cols, grid.rows)
      },
    }
  }

  return {
    connection,
    view,
    setActive(next: boolean): void {
      if (next === active) return
      active = next
      trace('panel:active-change', { next })
      // Becoming active = a reveal: the panel was display:none (its WebGL canvas freed),
      // so recover the renderer after layout, not just refresh immediately.
      if (active) reveal()
      // going inactive: do nothing — never resize a hidden panel
    },
    setAppearance(appearance: TerminalAppearance): void {
      view.setAppearance(appearance)
      trace('appearance:change')
      // A font-metric change altered the cell size — reconcile the grid to the
      // container and inform the server (eligibility-gated inside applyFit, so
      // a hidden panel never drives the shared PTY). A theme-only change leaves
      // the grid identical and applyFit decides 'same' → nothing further.
      applyFit(false)
    },
    dispose() {
      trace('dispose')
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      if (viewportFitTimer !== undefined) clearTimeout(viewportFitTimer)
      cancelScheduledFit()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      offInput()
      offViewport()
      toolbar?.dispose()
      viewport.dispose()
      hub.detach(sessionId)
      view.dispose()
    },
  }
}
