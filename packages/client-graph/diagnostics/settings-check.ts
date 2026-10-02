/** On-demand differential using the sidebar comparison contract. Expected
 * values exist only in this process; reports retain counts and positions. */
import type { Store } from '@podium/client-core/engine'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { createRepositoryUsageSelector, resolveDefaultAgent } from '@podium/client-core/viewmodels'
import type { MobxPool } from '../src/pool'
import { settingsRepositoryId } from '../src/settings-schema'
import { LOADING } from '../src/worklist/rollup'
import { checkPreferences } from './preference-check'
import { compareSidebarSnapshots, type CheckRow, type CheckSection } from './sidebar-check'

export interface SettingsCheckOwner {
  getSnapshot(): Pick<Store, 'machines' | 'repos' | 'sessions' | 'settingsTab'>
  readonly ui: RoutedUiState
}

export function checkSettings(pool: MobxPool, owner: SettingsCheckOwner) {
  const state = owner.getSnapshot()
  const catalog = pool.row('settingsCatalog', 'catalog')
  const window = pool.row('settingsWindow', 'window')
  const setup = pool.settingsViews.setup()
  const sessions = pool.settingsViews.sessions()
  let pending = Number(catalog === LOADING) + Number(window === LOADING) + setup.pending
  const rows = (values: readonly (readonly [string, object])[]): CheckRow[] => values.map(([id, value]) => ({ id, fields: { value } }))
  const machineRows = rows(state.machines.map((row) => [row.id, row]))
  const repositoryRows = rows(state.repos.map((row) => [settingsRepositoryId(row), row]))
  const expected: CheckSection[] = [
    { key: 'machines', fields: {}, rows: machineRows },
    { key: 'repositories', fields: {}, rows: repositoryRows },
    { key: 'window', fields: { settingsTab: state.settingsTab }, rows: [] },
    { key: 'setup', fields: {
      usage: [...createRepositoryUsageSelector()(state.sessions)].sort(([a], [b]) => a.localeCompare(b)),
      defaultAgent: resolveDefaultAgent(undefined, state.sessions),
    }, rows: state.sessions.map((row) => ({ id: row.sessionId, fields: {} })) },
  ]
  const readRows = (entity: 'settingsMachine' | 'settingsRepository', ids: readonly string[]): CheckRow[] => ids.map((id) => {
    const row = pool.row(entity, id)
    if (row === LOADING) pending++
    return { id, pending: row === LOADING, fields: row === LOADING || !row ? {} : { value: row } }
  })
  const actual: CheckSection[] = [
    { key: 'machines', fields: {}, rows: catalog === LOADING ? machineRows.map((row) => ({ ...row, placementPending: true })) : readRows('settingsMachine', catalog?.machines ?? []) },
    { key: 'repositories', fields: {}, rows: catalog === LOADING ? repositoryRows.map((row) => ({ ...row, placementPending: true })) : readRows('settingsRepository', catalog?.repositories ?? []) },
    { key: 'window', fields: window && window !== LOADING ? window : {}, pendingFields: window === LOADING ? ['settingsTab'] : [], rows: [] },
    { key: 'setup', fields: {
      usage: [...setup.usage].sort(([a], [b]) => a.localeCompare(b)), defaultAgent: setup.defaultAgent,
    }, pendingFields: setup.pending ? ['usage', 'defaultAgent'] : [], rows: sessions.pending
      ? state.sessions.map((row) => ({ id: row.sessionId, fields: {}, placementPending: true }))
      : sessions.rows.map((row) => ({ id: row.sessionId, fields: {} })) },
  ]
  const result = compareSidebarSnapshots({ sections: expected, pending: 0 }, { sections: actual, pending })
  const preferences = checkPreferences(pool, owner.ui)
  return {
    differences: result.differences + preferences.differences,
    pending: result.pending + preferences.pending,
    positions: result.rows + preferences.positions,
    first: result.first ? { section: result.first.sectionIndex, index: result.first.rowIndex }
      : preferences.first ? { section: expected.length, index: preferences.first.index } : null,
  }
}

export function installSettingsCheck(pool: MobxPool, owner: SettingsCheckOwner): () => void {
  if (typeof window === 'undefined') return () => {}
  const check = () => checkSettings(pool, owner)
  Object.assign(window, { __settingsCheck: check })
  return () => { if (Reflect.get(window, '__settingsCheck') === check) Reflect.deleteProperty(window, '__settingsCheck') }
}
