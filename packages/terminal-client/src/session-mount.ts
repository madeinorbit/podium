import type { ConnectionState, SessionConnection, SocketHub } from './connection'
import { DomViewportSource } from './dom-viewport'
import { decideResizeAction, type Grid } from './session-viewport'
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
  const view = new TerminalView(opts.appearance ?? {})
  view.mount(el)

  let active = opts.active ?? true
  let serverGrid: Grid = { cols: view.cols(), rows: view.rows() }
  const pageVisible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState === 'visible'
  const eligible = (): boolean => active && pageVisible()

  // fit-with-retry: a measurable container fits immediately; an unmeasurable one
  // (just-revealed, layout not settled) retries across rAFs. onMeasured runs once
  // a grid is obtained.
  const MAX_FIT_RETRIES = 10
  let fitRunning = false
  function fitWithRetry(onMeasured: (grid: Grid) => void): void {
    const grid = view.fit()
    if (grid) {
      onMeasured(grid)
      return
    }
    if (fitRunning) return
    fitRunning = true
    let attempts = 0
    const retry = (): void => {
      attempts += 1
      const g = view.fit()
      if (g) {
        fitRunning = false
        onMeasured(g)
        return
      }
      if (attempts < MAX_FIT_RETRIES) requestAnimationFrame(retry)
      else fitRunning = false
    }
    requestAnimationFrame(retry)
  }

  function applyFit(forceRedrawIfSame: boolean): void {
    if (!eligible()) return
    fitWithRetry((grid) => {
      const action = decideResizeAction(grid, serverGrid, { forceRedrawIfSame })
      if (action.kind === 'resize') connection.sendResize(action.cols, action.rows)
      else if (action.kind === 'redraw') connection.redraw()
    })
  }

  function becomeEligible(): void {
    if (!eligible()) return
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
      if (!eligible()) return // hidden again before layout settled
      const before = { cols: view.cols(), rows: view.rows() }
      const grid = view.fit()
      if (grid) {
        onMeasured(grid, grid.cols !== before.cols || grid.rows !== before.rows)
        return
      }
      if (attempt < MAX_REVEAL_FIT_RETRIES) requestAnimationFrame(() => tryFit(attempt + 1))
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
  //     canvas, so recreate the WebGL renderer for a fresh context + full render. This works even
  //     though the old GL context is gone — we never relied on keeping it warm.
  // Sizing waits for real layout (no fixed-frame guess), so the recompute can't run against a
  // still-hidden/zero-size canvas; whenMeasurable re-checks eligibility each frame.
  function reveal(): void {
    if (!eligible()) return
    connection.requestControl() // last-foregrounded-wins
    whenMeasurable((grid, gridChanged) => {
      if (!eligible()) return
      if (grid.cols !== serverGrid.cols || grid.rows !== serverGrid.rows) {
        connection.sendResize(grid.cols, grid.rows)
      }
      if (!gridChanged) view.reloadWebgl()
    })
  }

  let lastEpoch = -1
  let firstFrameSeen = false
  // Tracks whether we've seen an attach before, so onAttached can tell a fresh mount
  // (sizing already driven by the mount/setActive path) from a RECONNECT (where we must
  // re-assert the size — see the onAttached handler).
  let everAttached = false

  // Ready = "usable, drop the Starting… overlay". Fires on the FIRST of: the server
  // confirming the attach (onAttached), the first real frame, or the timeout backstop
  // — so an idle child with an empty replay buffer is never mistaken for still booting.
  let ready = false
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  const markReady = (): void => {
    if (ready) return
    ready = true
    if (readyTimer !== undefined) clearTimeout(readyTimer)
    opts.onReady?.()
  }
  readyTimer = setTimeout(markReady, opts.readyTimeoutMs ?? READY_TIMEOUT_MS)

  const connection = hub.attach(sessionId, {
    onAttached: () => {
      markReady()
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
        markReady()
      }
      opts.onFrame?.()
    },
    // A full replay is incoming (fresh mount, or a reconnect whose gap outran the
    // server's buffer): wipe before the buffered frames rebuild the screen. A
    // resuming reconnect does NOT fire this — it keeps the screen and appends only
    // what it missed, so a network blip no longer flashes the whole terminal.
    onReset: () => {
      lastEpoch = connection.state().epoch
      view.clear()
    },
    onState: (state) => {
      if (view.cols() !== state.cols || view.rows() !== state.rows) {
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

  const viewport = new DomViewportSource(el)
  const offViewport = viewport.onChange(() => applyFit(false))

  const onVisibility = (): void => {
    if (eligible()) reveal() // page returning to the foreground is a reveal (canvas was freed)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }

  if (opts.focusOnMount !== false) view.focus()

  if (opts.test) {
    ;(globalThis as unknown as { __podium?: unknown }).__podium = {
      state: () => connection.state(),
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
      // Becoming active = a reveal: the panel was display:none (its WebGL canvas freed),
      // so recreate the renderer after layout, not just refresh.
      if (active) reveal()
      // going inactive: do nothing — never resize a hidden panel
    },
    setAppearance(appearance: TerminalAppearance): void {
      view.setAppearance(appearance)
      // A font-metric change altered the cell size — reconcile the grid to the
      // container and inform the server (eligibility-gated inside applyFit, so
      // a hidden panel never drives the shared PTY). A theme-only change leaves
      // the grid identical and applyFit decides 'same' → nothing further.
      applyFit(false)
    },
    dispose() {
      if (readyTimer !== undefined) clearTimeout(readyTimer)
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
