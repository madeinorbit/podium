// packages/terminal-client/src/session-viewport.ts
export type Grid = { cols: number; rows: number }
export type ResizeAction =
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'redraw' }
  | { kind: 'none' }

/**
 * Decide what to push to the agent given a freshly fitted grid and the server's
 * current authoritative grid. A genuine size change resizes the PTY; an unchanged
 * size only repaints (and only when a reveal forces it), because re-sending the
 * same winsize raises SIGWINCH and flashes TUIs.
 */
export function decideResizeAction(
  fitted: Grid,
  serverGrid: Grid,
  opts: { forceRedrawIfSame: boolean },
): ResizeAction {
  if (fitted.cols !== serverGrid.cols || fitted.rows !== serverGrid.rows) {
    return { kind: 'resize', cols: fitted.cols, rows: fitted.rows }
  }
  return opts.forceRedrawIfSame ? { kind: 'redraw' } : { kind: 'none' }
}
