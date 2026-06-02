import { SessionConnection } from './connection'
import { DomViewportSource } from './dom-viewport'
import { TerminalView } from './terminal-view'
import { mountKeyToolbar } from './toolbar'

export interface MountSessionOptions {
  url: string
  toolbarEl?: HTMLElement
  test?: boolean
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
    },
  })

  const viewport = new DomViewportSource(el)
  const offViewport = viewport.onChange(() => {
    if (connection.state().role !== 'controller') return
    const grid = view.fit()
    connection.sendResize(grid.cols, grid.rows)
  })

  const offToolbar = opts.toolbarEl ? mountKeyToolbar(opts.toolbarEl, connection) : () => {}

  connection.connect()

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
        if (inset > 0) {
          const currentH = el.getBoundingClientRect().height
          el.style.height = `${Math.max(0, currentH - inset)}px`
        } else {
          el.style.height = ''
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
      offViewport()
      offToolbar()
      viewport.dispose()
      connection.dispose()
      view.dispose()
    },
  }
}
