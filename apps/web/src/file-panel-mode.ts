import type { UiState } from './replica'

/**
 * Per-file panel-mode persistence (HTML/Markdown Preview/Source/Split picks),
 * stored as ONE ui-state row per family — a JSON map { [tabId]: mode } — instead
 * of the legacy unbounded `podium.htmlmode:<tabId>` localStorage key family
 * (replica.uiState() migrates those in once; see LEGACY_UI_MAP_PREFIXES).
 */

export type FilePanelMode = 'preview' | 'source' | 'split'

export const HTML_MODE_MAP_KEY = 'podium.htmlmode'
export const MD_MODE_MAP_KEY = 'podium.mdmode'

/** Keep the map from growing without bound: oldest-written entries drop first. */
export const FILE_MODE_MAP_CAP = 200

function readMap(ui: UiState, mapKey: string): Record<string, string> {
  const raw = ui.get(mapKey)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** The saved mode for one file tab, or null when never picked / corrupt. */
export function readFilePanelMode(ui: UiState, mapKey: string, id: string): FilePanelMode | null {
  const v = readMap(ui, mapKey)[id]
  return v === 'preview' || v === 'source' || v === 'split' ? v : null
}

/** Persist one file tab's mode into the family map (bounded, insertion-ordered). */
export function writeFilePanelMode(
  ui: UiState,
  mapKey: string,
  id: string,
  mode: FilePanelMode,
): void {
  const map = readMap(ui, mapKey)
  if (map[id] === mode) return
  // Re-insert at the back so the cap drops the least-recently-written entries.
  delete map[id]
  map[id] = mode
  const keys = Object.keys(map)
  for (const stale of keys.slice(0, Math.max(0, keys.length - FILE_MODE_MAP_CAP))) {
    delete map[stale]
  }
  ui.set(mapKey, JSON.stringify(map))
}
