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
  let onControllerEnter: (() => void) | undefined

  const connection = hub.attach(sessionId, {
    onFrame: (text) => view.write(text),
    onState: (state) => {
      if (view.cols() !== state.cols || view.rows() !== state.rows) {
        view.resize(state.cols, state.rows)
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
    })
  }

  const offInput = view.onData((data) => connection.sendInput(data))

  const viewport = new DomViewportSource(el)
  const offViewport = viewport.onChange(() => {
    if (connection.state().role !== 'controller') return
    const grid = view.fit()
    connection.sendResize(grid.cols, grid.rows)
  })

  const offToolbar = opts.toolbarEl ? mountKeyToolbar(opts.toolbarEl, connection) : () => {}

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
        if (inset > 0) {
          const currentH = el.getBoundingClientRect().height
          const effectiveInset = Math.max(inset, Math.ceil(currentH * 0.5))
          const newH = `${Math.max(1, currentH - effectiveInset)}px`
          el.style.flex = 'none'
          el.style.height = newH
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
      offToolbar()
      viewport.dispose()
      hub.detach(sessionId)
      view.dispose()
    },
  }
}
