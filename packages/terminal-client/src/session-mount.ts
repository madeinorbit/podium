import { type ConnectionState, SessionConnection } from './connection'
import { DomViewportSource } from './dom-viewport'
import { TerminalView } from './terminal-view'
import { mountKeyToolbar } from './toolbar'

export interface MountSessionOptions {
  url: string
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
  const view = new TerminalView()
  view.mount(el)
  const fitted = view.fit()

  const connection = new SessionConnection({
    url: opts.url,
    viewport: { cols: fitted.cols, rows: fitted.rows, dpr: globalThis.devicePixelRatio ?? 1 },
    onFrame: (text) => view.write(text),
    onState: (state) => {
      if (view.cols() !== state.cols || view.rows() !== state.rows) {
        view.resize(state.cols, state.rows)
      }
      el.dataset.role = state.role
      el.dataset.epoch = String(state.epoch)
      opts.onState?.(state)
    },
  })

  const offInput = view.onData((data) => connection.sendInput(data))

  const viewport = new DomViewportSource(el)
  const offViewport = viewport.onChange(() => {
    if (connection.state().role !== 'controller') return
    const grid = view.fit()
    connection.sendResize(grid.cols, grid.rows)
  })

  const offToolbar = opts.toolbarEl ? mountKeyToolbar(opts.toolbarEl, connection) : () => {}

  connection.connect()
  view.focus()

  if (opts.test) {
    ;(globalThis as unknown as { __podium?: unknown }).__podium = {
      state: () => connection.state(),
      screenHash: () => view.screenHash(),
      screenText: () => view.screenText(),
      sendInput: (s: string) => connection.sendInput(s),
      takeControl: () => connection.requestControl(),
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
      offToolbar()
      viewport.dispose()
      connection.dispose()
      view.dispose()
    },
  }
}
