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
   * Fires once, on the first non-empty PTY frame. Lets the panel drop its
   * "Starting…" overlay the moment real output lands. A healthy session always
   * triggers this — the server replays its buffer on attach — so only a still
   * pre-output spawn or a wedged child leaves it unfired.
   */
  onFirstFrame?: () => void
}

export interface MountedSession {
  connection: SessionConnection
  view: TerminalView
  dispose(): void
}

export function mountSession(el: HTMLElement, opts: MountSessionOptions): MountedSession {
  const { hub, sessionId } = opts
  const view = new TerminalView()
  view.mount(el)
  const fitted = view.fit()

  let wasController = false
  let lastEpoch = -1
  let firstFrameSeen = false
  let onControllerEnter: (() => void) | undefined

  const connection = hub.attach(sessionId, {
    onFrame: (text) => {
      view.write(text)
      if (!firstFrameSeen && text.length > 0) {
        firstFrameSeen = true
        opts.onFirstFrame?.()
      }
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
  connection.sendResize(fitted.cols, fitted.rows)

  // On becoming controller, fit the terminal to THIS client's viewport and tell the agent.
  // The initial layout resize fires before we are made controller, so without this the
  // session would stay at the daemon's initial grid.
  onControllerEnter = () => {
    requestAnimationFrame(() => {
      const s = connection.state()
      if (s.role !== 'controller') return
      const grid = view.fit()
      if (grid.cols !== s.cols || grid.rows !== s.rows) connection.sendResize(grid.cols, grid.rows)
      // No view.clear() here: the server replays buffered output on attach, and clearing
      // would wipe it (leaving normal-buffer apps blank). The resize above + redraw below
      // refresh the screen; xterm reflows the replayed content to the new grid.
      connection.redraw()
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
    const grid = view.fit()
    connection.sendResize(grid.cols, grid.rows)
  })

  view.focus()

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
        connection.sendResize(grid.cols, grid.rows)
      },
    }
  }

  return {
    connection,
    view,
    dispose() {
      offInput()
      offViewport()
      toolbar?.dispose()
      viewport.dispose()
      hub.detach(sessionId)
      view.dispose()
    },
  }
}
