import { omitGone } from '@podium/client-graph/lookup'
import { preferenceSource } from '@podium/client-graph/preference-source'
/** On-demand differential using the sidebar comparison contract. Reports expose
 * positions only: keys may contain paths, and values are never evidence. */
import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { MobxPool } from '@podium/client-graph/pool'
import { declarePreference } from '@podium/client-graph/preference-schema'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { type CheckRow, compareSidebarSnapshots } from './sidebar-check'

export function checkPreferences(pool: MobxPool, ui: RoutedUiState, keys = (preferenceSource(pool)?.keys() ?? [])) {
  let pending = 0
  const expected = keys.map(
    (key, index): CheckRow => ({
      id: String(index),
      fields: { value: ui.get(key), home: declarePreference(key) },
    }),
  )
  const actual = keys.map((key, index): CheckRow => {
    const row = omitGone(pool.row('preference', key))
    const loading = row === LOADING
    if (loading) pending++
    return {
      id: String(index),
      pending: loading,
      fields: !row || loading ? {} : { value: row.value, home: row.home },
    }
  })
  const sections = (rows: CheckRow[]) => [{ key: 'preferences', fields: {}, rows }]
  const result = compareSidebarSnapshots(
    { sections: sections(expected), pending: 0 },
    { sections: sections(actual), pending },
  )
  return {
    differences: result.differences,
    pending: result.pending,
    positions: result.rows,
    first: result.first ? { index: result.first.rowIndex, field: result.first.field } : null,
  }
}
