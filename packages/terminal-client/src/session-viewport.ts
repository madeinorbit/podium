// packages/terminal-client/src/session-viewport.ts
export type Grid = { cols: number; rows: number }

/**
 * `decideResizeAction` lived here and is deleted (POD-3239 B8).
 *
 * It answered "given a freshly fitted grid and the server's current grid, what
 * should this client push to the agent?" — a decision the client no longer
 * makes. Under MODEL rule 3 a viewer states the box it has and the SERVER
 * decides whether that differs from W; under rule 4 a reveal claims whether or
 * not it does. The `redraw` arm went with it: a reveal repaints its own canvas
 * locally rather than asking the agent to repaint for it.
 */
