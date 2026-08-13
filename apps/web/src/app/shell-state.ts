import type { MainView } from '@podium/client-core/router'

export {
  RIGHT_PANEL_KEY,
  SIDEBAR_COLLAPSED_KEY,
  SUPERAGENT_MODE_KEY,
} from '@podium/client-core/ui-state'

export type RightPanelTab =
  | 'issue'
  | 'superagent'
  | 'git'
  | 'files'
  | 'shell'
  | 'mail'
  | 'merge-queue'
  | 'shipping'

export interface RightPanelFeatures {
  git: boolean
  messages: boolean
  mergeQueue: boolean
  shipping: boolean
}

export function rightPanelAllowed(
  panel: RightPanelTab | null,
  features: RightPanelFeatures,
): boolean {
  if (panel === 'git') return features.git
  if (panel === 'mail') return features.messages
  if (panel === 'merge-queue') return features.mergeQueue
  if (panel === 'shipping') return features.shipping
  return true
}

/** Window event asking the shell to open a right-dock panel [POD-98] — fired by
 *  deep surfaces (the pane header's git stamp, the command palette) that don't
 *  hold the AppShell's local panel state. detail = the RightPanelTab to open,
 *  or {@link CLOSE_RIGHT_PANEL} to shut the dock. */
export const OPEN_RIGHT_PANEL_EVENT = 'podium:open-right-panel'

/** `detail` value that closes the dock rather than opening a panel (POD-745).
 *  A distinct token, not `null`/`''`: those are also what a MALFORMED detail
 *  decodes to, and "unreadable request" must stay a no-op rather than silently
 *  closing the operator's panel. */
export const CLOSE_RIGHT_PANEL = 'close'

export function readBooleanState(value: string | null, fallback = false): boolean {
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return fallback
}

/**
 * The Flight Deck occupies the column the Superagent used to own, so it keeps
 * that column's persisted mode key and its two-state semantics (#65): a
 * collapse folds the column in place, it never fully disappears. Reusing the
 * key also carries a user's existing open/folded preference across the move
 * instead of resetting it — and the key is already classified as replicated
 * layout, which a new spelling would not be (`uiStateRoute` is default-closed).
 */
export function readFlightDeckCollapsed(value: string | null): boolean {
  // New installs start with the deck folded so activation and the first task get
  // the full stage. Existing explicit preferences still win, including the
  // legacy `closed` spelling.
  return value === null || value === 'folded' || value === 'closed'
}

export function readRightPanel(value: string | null): RightPanelTab | null {
  return value === 'issue' ||
    value === 'superagent' ||
    value === 'git' ||
    value === 'files' ||
    value === 'shell' ||
    value === 'mail' ||
    value === 'merge-queue' ||
    value === 'shipping'
    ? value
    : null
}

/**
 * Utility views that layer OVER a mode rather than replacing it (POD-365).
 * Settings and Usage are things you visit and leave, so the shell keeps the mode
 * beneath them mounted and returns you to it — not always to the workspace.
 */
const OVERLAY_VIEWS: ReadonlySet<MainView> = new Set<MainView>(['settings', 'usage'])

export function isOverlayView(view: MainView): boolean {
  return OVERLAY_VIEWS.has(view)
}

/**
 * The mode the shell renders (and returns to) while `view` is showing.
 *
 * An overlay keeps whatever was underneath; anything else IS the base. Opening
 * Settings from Tasks and pressing Esc must land back on Tasks — the old
 * behaviour hard-coded `workspace`, which silently threw away where you were.
 */
export function nextBaseView(current: MainView, view: MainView): MainView {
  return isOverlayView(view) ? current : view
}
