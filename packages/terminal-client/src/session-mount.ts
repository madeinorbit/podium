import type { ConnectionState, SessionConnection, SocketHub } from './connection'
import { DomViewportSource } from './dom-viewport'
import { TerminalView } from './terminal-view'
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
}

export interface MountedSession {
  connection: SessionConnection
  view: TerminalView
  dispose(): void
}

/** Default {@link MountSessionOptions.readyTimeoutMs}: reveal the terminal even if the
 *  attach handshake stalls, so the "Starting…" overlay can never hang permanently. */
export const READY_TIMEOUT_MS = 2000

export function mountSession(el: HTMLElement, opts: MountSessionOptions): MountedSession {
  const { hub, sessionId } = opts
  const view = new TerminalView()
  view.mount(el)
  const fitted = view.fit()

  // fitAndSend: attempt fit(); if the container isn't measurable yet, retry
  // across rAFs (cap MAX_FIT_RETRIES frames). Guarded by a running flag so
  // overlapping viewport-change events don't spawn multiple loops.
  const MAX_FIT_RETRIES = 10
  let fitRetryRunning = false
  function fitAndSend(): void {
    const grid = view.fit()
    if (grid) {
      connection.sendResize(grid.cols, grid.rows)
      return
    }
    if (fitRetryRunning) return
    fitRetryRunning = true
    let attempts = 0
    function retry(): void {
      attempts += 1
      const g = view.fit()
      if (g) {
        fitRetryRunning = false
        connection.sendResize(g.cols, g.rows)
        connection.redraw()
        return
      }
      if (attempts < MAX_FIT_RETRIES) {
        requestAnimationFrame(retry)
      } else {
        fitRetryRunning = false
      }
    }
    requestAnimationFrame(retry)
  }

  let wasController = false
  let lastEpoch = -1
  let firstFrameSeen = false
  let onControllerEnter: (() => void) | undefined

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
    onAttached: markReady,
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
      }
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
      if (state.role === 'controller') {
        if (!wasController) {
          wasController = true
          onControllerEnter?.()
        }
      } else {
        wasController = false
      }
      opts.onState?.(state)
    },
  })
  // The terminal was created at `fitted`; make sure the agent matches our viewport.
  // If the container isn't measurable yet at mount time, the viewport-change retry
  // loop will pick it up once layout settles.
  if (fitted) connection.sendResize(fitted.cols, fitted.rows)

  // On becoming controller, fit the terminal to THIS client's viewport and tell the agent.
  // The initial layout resize fires before we are made controller, so without this the
  // session would stay at the daemon's initial grid. Uses fitAndSend() so the bounded-rAF
  // retry loop kicks in when the container isn't measurable yet (same path as viewport changes).
  onControllerEnter = () => {
    requestAnimationFrame(() => {
      const s = connection.state()
      if (s.role !== 'controller') return
      // No view.clear() here: the server replays buffered output on attach, and clearing
      // would wipe it (leaving normal-buffer apps blank). fitAndSend() resizes + redraw
      // refresh the screen; xterm reflows the replayed content to the new grid.
      fitAndSend()
    })
  }

  // Paste + arrows now live in the panel's React action row / D-pad above the key
  // bar, so the bar itself no longer renders a Paste key.
  const toolbar = opts.toolbarEl ? mountKeyToolbar(opts.toolbarEl, connection) : null

  // Route keyboard input through the toolbar so an armed modifier (e.g. Ctrl)
  // transforms the next character the soft keyboard sends.
  const offInput = view.onData((data) =>
    connection.sendInput(toolbar ? toolbar.applyModifiers(data) : data),
  )

  const viewport = new DomViewportSource(el)
  const offViewport = viewport.onChange(() => {
    if (connection.state().role !== 'controller') return
    fitAndSend()
  })

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
    dispose() {
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      offInput()
      offViewport()
      toolbar?.dispose()
      viewport.dispose()
      hub.detach(sessionId)
      view.dispose()
    },
  }
}
