/**
 * Engine UI-state persistence keys + readers (#262 [spec:SP-3fe2]). Persist the
 * "where am I" state so a reload (the PWA cold-starts often on mobile) lands
 * back on the same surface. All UI persistence goes through the replica's ONE
 * versioned ui-state collection (replica.uiState()); the old ad-hoc
 * localStorage keys are migrated in there once and removed.
 */

import type { UiState } from '../replica/replica'
import type { MainView } from '../router'

export const VIEW_KEY = 'podium.view'
export const WT_KEY = 'podium.selectedWorktree'
export const ISSUE_SEL_KEY = 'podium.selectedIssueId'

export const DOCK_TAB_KEY = 'podium.dockTab'
export const PANE_A_KEY = 'podium.paneA'
export const PANE_B_KEY = 'podium.paneB'
export const SPLIT_KEY = 'podium.split'
// v2: the superagent became the desktop shell's CENTER column (default open).
// A fresh key so a pre-redesign "closed dock" ('0' under podium.superOpen)
// doesn't hide the new column for returning users.
export const SUPER_OPEN_KEY = 'podium.superOpen.v2'
export const PANEL_MODE_KEY = 'podium.panelMode'
export const DOCK_SHELLS_KEY = 'podium.dockShells'

export function readStoredView(ui: UiState): MainView {
  const v = ui.get(VIEW_KEY)
  // 'superagent' is no longer a full view (it's a dock now) — a returning user who
  // left on it lands on home instead of a dead surface.
  return v === 'home' ||
    v === 'workspace' ||
    v === 'settings' ||
    v === 'usage' ||
    v === 'issues' ||
    v === 'automations' ||
    v === 'specs'
    ? v
    : 'home'
}

/** The persisted worktreePath → dock-shell-session map (#23). A corrupt/missing
 *  blob reads as empty. */
export function readStoredDockShells(ui: UiState): Record<string, string> {
  const raw = ui.get(DOCK_SHELLS_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [wt, id] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === 'string' && id) out[wt] = id
    }
    return out
  } catch {
    return {}
  }
}

/** The persisted per-session panel-mode map. A corrupt/missing blob reads as empty. */
export function readStoredPanelModes(ui: UiState): Record<string, 'chat' | 'native'> {
  const raw = ui.get(PANEL_MODE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, 'chat' | 'native'> = {}
    for (const [id, m] of Object.entries(parsed as Record<string, unknown>)) {
      if (m === 'chat' || m === 'native') out[id] = m
    }
    return out
  } catch {
    return {}
  }
}
