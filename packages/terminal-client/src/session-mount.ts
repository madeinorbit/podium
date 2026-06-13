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
  let onControllerEnter: (() => void) | undefined

  const connection = hub.attach(sessionId, {
    onFrame: (text) => view.write(text),
    onState: (state) => {
      if (view.cols() !== state.cols || view.rows() !== state.rows) {
        view.resize(state.cols, state.rows)
      }
      // Drop stale pre-fit output (e.g. an 80-col shell prompt) before repaint.
      // A disconnect invalidates our screen sync: the epoch usually survives a
      // reconnect unchanged, so without the reset the replay-on-attach would append
      // the whole buffer onto the stale screen instead of repainting it.
      if (!state.connected) {
        lastEpoch = -1
      } else if (state.epoch !== lastEpoch) {
        lastEpoch = state.epoch
        view.clear()
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

  const toolbar = opts.toolbarEl
    ? mountKeyToolbar(opts.toolbarEl, connection, { onPaste: () => void view.requestPaste() })
    : null

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
