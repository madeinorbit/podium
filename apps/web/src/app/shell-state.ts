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

export interface RightPanelFeatures {
  git: boolean
  messages: boolean
  mergeQueue: boolean
}

export function rightPanelAllowed(
  panel: RightPanelTab | null,
  features: RightPanelFeatures,
): boolean {
  if (panel === 'git') return features.git
  if (panel === 'mail') return features.messages
  if (panel === 'merge-queue') return features.mergeQueue
  return true
}

/** Window event asking the shell to open a right-dock panel [POD-98] — fired by
 *  deep surfaces (the pane header's git stamp) that don't hold the AppShell's
 *  local panel state. detail = the RightPanelTab to open. */
export const OPEN_RIGHT_PANEL_EVENT = 'podium:open-right-panel'

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
  // Pre-#65 'closed' persistence folds; absent/corrupt opens.
  return value === 'folded' || value === 'closed'
}

export function readRightPanel(value: string | null): RightPanelTab | null {
  return value === 'issue' ||
    value === 'superagent' ||
    value === 'git' ||
    value === 'files' ||
    value === 'shell' ||
    value === 'mail' ||
    value === 'merge-queue'
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
