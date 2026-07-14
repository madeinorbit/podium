export const SIDEBAR_COLLAPSED_KEY = 'podium:sidebar:collapsed'
export const SUPERAGENT_MODE_KEY = 'podium:superagent:mode'
export const RIGHT_PANEL_KEY = 'podium.rightPanel'
export const RIGHT_PANEL_LAST_KEY = 'podium.rightPanel.last'

/** The engraved column's two states (#65): human preview feedback removed the
 *  fully-closed state — every collapse resolves to the in-place folded bar. */
export type SuperagentMode = 'open' | 'folded'
export type RightPanelTab = 'issue' | 'git' | 'files' | 'shell'

export function readBooleanState(value: string | null, fallback = false): boolean {
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return fallback
}

export function readSuperagentMode(value: string | null, legacyOpen: boolean): SuperagentMode {
  if (value === 'open' || value === 'folded') return value
  // Pre-#65 'closed' persistence (and the legacy open=false boolean) lands on
  // the folded bar so the column never disappears.
  if (value === 'closed') return 'folded'
  return legacyOpen ? 'open' : 'folded'
}

export function readRightPanel(value: string | null): RightPanelTab | null {
  return value === 'issue' || value === 'git' || value === 'files' || value === 'shell'
    ? value
    : null
}

export function readLastRightPanel(value: string | null): RightPanelTab {
  return readRightPanel(value) ?? 'issue'
}
