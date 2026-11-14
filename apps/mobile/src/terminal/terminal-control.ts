import type { ConnectionState } from '@podium/client-core/socket-transport'

/**
 * WHO IS DRIVING THIS PTY, IN WORDS (POD-724).
 *
 * The phone attaches as a `server-grid` spectator: it shows the terminal at the
 * size the DESK is driving and lets you pan the rest, because a phone that is
 * merely looking must not reflow a colleague's (or your own) desktop TUI. The
 * cost is that a wide agent frame arrives cropped, and the only way out used to
 * be typing something — the first keystroke takes control and refits the PTY.
 * That is a terrible bargain when all you wanted was to READ.
 *
 * So the takeover becomes an action, and an action with a consequence someone
 * else can see needs to say so before it is tapped. Copy lives here rather than
 * in the button because the native menu and fallback header button share the
 * action, while the navigation subtitle names the state and grid.
 */

export type TerminalRole = ConnectionState['role']

/** What the pane publishes so the SCREEN's header can own the affordance. */
export interface TerminalControlState {
  role: TerminalRole
  /** The grid the SERVER holds, or `undefined` before this connection has been
   *  told one (POD-3239 B8). The subtitle omits an unknown grid. */
  cols: number | undefined
  rows: number | undefined
  /** The mount is attached: a takeover request has somewhere to land. */
  ready: boolean
  takeControl: () => void
}

/** The published state minus the action — what a renderer derives from a
 *  ConnectionState alone (the pane adds `ready` + `takeControl` on publish). */
export type TerminalControlView = Pick<TerminalControlState, 'role' | 'cols' | 'rows'>

/**
 * ConnectionState → the control view both panes publish: the server's word on
 * who drives, and the grid it holds. There is no in-between "fitting" state
 * (POD-3190 rev 3): the phone keeps no record of what it asked for, because an
 * ask the host refuses is never answered and such a state would never end. The
 * subtitle names the new grid when the server reports it.
 */
export function terminalControlView(
  state: Pick<ConnectionState, 'role' | 'cols' | 'rows'>,
): TerminalControlView {
  return { role: state.role, cols: state.cols, rows: state.rows }
}

export interface TerminalControlCopy {
  /** Accessible label for the header action. HeaderButton has no hint slot, so
   *  the consequence is carried here — the label IS the warning. */
  label: string
  /** Native subtitle fragment, including only the server-confirmed grid. */
  status: string
}

export function terminalControlCopy(control: TerminalControlState): TerminalControlCopy {
  const grid =
    control.cols === undefined || control.rows === undefined
      ? ''
      : ` · ${control.cols}×${control.rows}`
  if (control.role === 'controller') {
    return {
      label: 'Refit shared terminal to this phone',
      status: `In control${grid}`,
    }
  }
  return {
    // Taking control changes the shared terminal's geometry for the desk too.
    label: 'Take control and resize shared terminal to fit this phone',
    status: `Spectating${grid}`,
  }
}
