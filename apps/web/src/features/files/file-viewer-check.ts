/** On-demand comparison only. Paths and saved values stay in this process;
 * reports contain counts and positions, using the sidebar-check contract. */
import {
  DIFF_SHEET_WRAP_KEY,
  HTML_MODE_MAP_KEY,
  JSON_MODE_MAP_KEY,
  MD_MODE_MAP_KEY,
  readFilePanelMode,
  type FilePanelMode,
  type RoutedUiState,
} from '@podium/client-core/ui-state'
import type { MobxPool } from '@podium/client-graph'
import {
  compareSidebarSnapshots,
  type CheckRow,
} from '@podium/client-graph/diagnostics/sidebar-check'
import { LOADING } from '@podium/client-graph/worklist/rollup'

export const FILE_VIEWER_PREFERENCE_KEYS = [
  HTML_MODE_MAP_KEY,
  JSON_MODE_MAP_KEY,
  MD_MODE_MAP_KEY,
  DIFF_SHEET_WRAP_KEY,
] as const
export interface FileViewerPreference {
  readonly mapKey: typeof HTML_MODE_MAP_KEY | typeof JSON_MODE_MAP_KEY | typeof MD_MODE_MAP_KEY
  readonly tabId: string
  readonly fallback?: FilePanelMode
}

function mode(raw: string | null, tab: FileViewerPreference): FilePanelMode {
  const saved = readFilePanelMode({ get: () => raw }, tab.mapKey, tab.tabId)
  return tab.mapKey === JSON_MODE_MAP_KEY
    ? saved === 'source'
      ? 'source'
      : 'preview'
    : (saved ?? tab.fallback ?? 'preview')
}

export function checkFileViewerPreferences(
  pool: MobxPool,
  ui: RoutedUiState,
  tabs: readonly FileViewerPreference[],
) {
  const keys = [...new Set([...FILE_VIEWER_PREFERENCE_KEYS, ...tabs.map((tab) => tab.mapKey)])]
  // All reads use the declared preference entity and the shared pool reader.
  const rows = new Map(keys.map((key) => [key, pool.row('preference', key)]))
  const expected: CheckRow[] = [],
    actual: CheckRow[] = []
  let pending = 0
  for (const key of keys) {
    const row = rows.get(key),
      loading = row === LOADING
    if (loading) pending++
    expected.push({ id: String(expected.length), fields: { value: ui.get(key) } })
    actual.push({
      id: String(actual.length),
      pending: loading,
      fields: { value: !row || loading ? null : row.value },
    })
  }
  for (const tab of tabs) {
    const row = rows.get(tab.mapKey),
      loading = row === LOADING
    expected.push({ id: String(expected.length), fields: { mode: mode(ui.get(tab.mapKey), tab) } })
    actual.push({
      id: String(actual.length),
      pending: loading,
      fields: { mode: mode(!row || loading ? null : row.value, tab) },
    })
  }
  const snapshot = (values: CheckRow[], loading: number) => ({
    sections: [{ key: 'file-viewers', fields: {}, rows: values }],
    pending: loading,
  })
  const result = compareSidebarSnapshots(snapshot(expected, 0), snapshot(actual, pending))
  return {
    differences: result.differences,
    pending: result.pending,
    positions: result.rows,
    first: result.first ? { index: result.first.rowIndex, field: result.first.field } : null,
  }
}
