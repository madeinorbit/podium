/** On-demand differential using the sidebar comparison contract. Reports expose
 * positions only: keys may contain paths, and values are never evidence. */
import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { MobxPool } from '../src/pool'
import { declarePreference } from '../src/preference-schema'
import { LOADING } from '../src/worklist/rollup'
import { compareSidebarSnapshots, type CheckRow } from './sidebar-check'

export function checkPreferences(pool: MobxPool, ui: RoutedUiState, keys = pool.preferenceKeys()) {
  let pending = 0
  const expected = keys.map((key, index): CheckRow => ({
    id: String(index), fields: { value: ui.get(key), home: declarePreference(key) },
  }))
  const actual = keys.map((key, index): CheckRow => {
    const row = pool.row('preference', key)
    const loading = row === LOADING
    if (loading) pending++
    return { id: String(index), pending: loading,
      fields: !row || loading ? {} : { value: row.value, home: row.home } }
  })
  const sections = (rows: CheckRow[]) => [{ key: 'preferences', fields: {}, rows }]
  const result = compareSidebarSnapshots(
    { sections: sections(expected), pending: 0 }, { sections: sections(actual), pending },
  )
  return { differences: result.differences, pending: result.pending, positions: result.rows,
    first: result.first ? { index: result.first.rowIndex, field: result.first.field } : null }
}

export function installPreferenceCheck(pool: MobxPool, ui: RoutedUiState): () => void {
  if (typeof window === 'undefined') return () => {}
  const check = () => checkPreferences(pool, ui)
  Object.assign(window, { __preferenceCheck: check })
  return () => {
    if (Reflect.get(window, '__preferenceCheck') === check) Reflect.deleteProperty(window, '__preferenceCheck')
  }
}
