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
 * in the button because two surfaces speak it — the header action's accessible
 * label and the pane's caption — and they must never drift apart.
 */

export type TerminalRole = ConnectionState['role']
export type TerminalControlPhase = 'spectating' | 'fitting' | 'controlling'

/** What the pane publishes so the SCREEN's header can own the affordance. */
export interface TerminalControlState {
  role: TerminalRole
  phase: TerminalControlPhase
  /** The grid the SERVER holds, or `undefined` before this connection has been
   *  told one (POD-3239 B8). The caption says so rather than naming a number
   *  nobody has stated. */
  cols: number | undefined
  rows: number | undefined
  /** The mount is attached: a takeover request has somewhere to land. */
  ready: boolean
  takeControl: () => void
}

/** The published state minus the action — what a renderer derives from a
 *  ConnectionState alone (the pane adds `ready` + `takeControl` on publish). */
export type TerminalControlView = Pick<TerminalControlState, 'role' | 'phase' | 'cols' | 'rows'>

/**
 * ConnectionState → the control view both panes publish. `requestedGeometry`
 * non-null means a takeover/fit claim is pending server acknowledgment, so the
 * UI must say "fitting" rather than claim the phone is driving that grid —
 * regardless of which role the stale snapshot still reports.
 */
export function terminalControlView(
  state: Pick<ConnectionState, 'role' | 'cols' | 'rows' | 'requestedGeometry'>,
): TerminalControlView {
  return {
    role: state.role,
    phase: state.requestedGeometry
      ? 'fitting'
      : state.role === 'controller'
        ? 'controlling'
        : 'spectating',
    cols: state.cols,
    rows: state.rows,
  }
}

export interface TerminalControlCopy {
  /** Accessible label for the header action. HeaderButton has no hint slot, so
   *  the consequence is carried here — the label IS the warning. */
  label: string
  /** Header subtitle fragment: the state, at a glance, beside the control. */
  status: string
  /**
   * The line under the header, in the pane. ALWAYS a string, never dropped in
   * one state: the pane is a flex column, so a caption that vanished on takeover
   * would change the terminal's height at the exact moment the takeover is
   * resizing the PTY — a second SIGWINCH chasing the first. Colour alone is also
   * not a state signal, so the sighted reading of "who is driving" lives here.
   */
  caption: string
}

export function terminalControlCopy(control: TerminalControlState): TerminalControlCopy {
  if (control.phase === 'fitting') {
    return {
      label: 'Taking control — waiting for the phone grid to be applied',
      status: 'Fitting…',
      caption: 'Taking control — fitting the shared terminal to this phone…',
    }
  }
  if (control.phase === 'controlling') {
    return {
      label: 'In control — the terminal is sized to this phone. Tap to re-claim it.',
      status: 'In control',
      caption:
        control.cols === undefined || control.rows === undefined
          ? 'In control.'
          : `In control — phone grid ${control.cols}×${control.rows}.`,
    }
  }
  return {
    label: 'Take control — resizes the shared terminal to fit this phone',
    status: 'Spectating',
    // Names the crop AND the price of fixing it. Whoever is at the desk sees
    // the new geometry, so that must not be a surprise discovered afterwards.
    caption:
      control.cols === undefined || control.rows === undefined
        ? 'Following the shared terminal — take control to fit this phone.'
        : `Following the shared ${control.cols}×${control.rows} terminal — take control to fit this phone.`,
  }
}
