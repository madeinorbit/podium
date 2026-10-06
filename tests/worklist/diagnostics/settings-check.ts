import { settingsView } from '@podium/client-graph/settings-views'
import { referenceState } from './reference-state'
/** Fixture and private-replay comparison using the sidebar contract. Expected
 * values exist only in this process; reports retain counts and positions. */
import type { ReferenceState as Store } from './reference-state'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { createRepositoryUsageSelector, resolveDefaultAgent } from '@podium/client-core/values'
import type { MobxPool } from '../../../packages/client-graph/src/pool'
import { settingsRepositoryId } from '../../../packages/client-graph/src/settings-schema'
import { LOADING } from '../../../packages/client-graph/src/worklist/rollup'
import { checkPreferences } from './preference-check'
import { type CheckRow, type CheckSection, compareSidebarSnapshots } from './sidebar-check'

export interface SettingsCheckOwner {
  readonly access: import('@podium/client-core/engine').Store
  readonly replica?: import('@podium/client-core/replica').Replica
  readonly ui: RoutedUiState
}

export function checkSettings(pool: MobxPool, owner: SettingsCheckOwner) {
  const state = referenceState(owner)
  const catalog = pool.row('settingsCatalog', 'catalog')
  const window = pool.row('settingsWindow', 'window')
  const expectedUsage = createRepositoryUsageSelector()(state.sessions)
  const setup = settingsView(pool).setup([...expectedUsage.keys()])
  const sessions = settingsView(pool).sessions()
  let pending = Number(catalog === LOADING) + Number(window === LOADING) + setup.pending
  const rows = (values: readonly (readonly [string, object])[]): CheckRow[] =>
    values.map(([id, value]) => ({ id, fields: { value } }))
  const machineRows = rows(state.machines.map((row) => [row.id, row]))
  const repositoryRows = rows(state.repos.map((row) => [settingsRepositoryId(row), row]))
  const expected: CheckSection[] = [
    { key: 'machines', fields: {}, rows: machineRows },
    { key: 'repositories', fields: {}, rows: repositoryRows },
    { key: 'window', fields: { settingsTab: state.settingsTab }, rows: [] },
    {
      key: 'setup',
      fields: {
        usage: [...expectedUsage].sort(([a], [b]) =>
          a.localeCompare(b),
        ),
        defaultAgent: resolveDefaultAgent(undefined, state.sessions),
      },
      rows: state.sessions.map((row) => ({ id: row.sessionId, fields: {} })),
    },
  ]
  const readRows = (
    entity: 'settingsMachine' | 'settingsRepository',
    ids: readonly string[],
  ): CheckRow[] =>
    ids.map((id) => {
      const row = pool.row(entity, id)
      if (row === LOADING) pending++
      return { id, pending: row === LOADING, fields: row === LOADING || !row ? {} : { value: row } }
    })
  const actual: CheckSection[] = [
    {
      key: 'machines',
      fields: {},
      rows:
        catalog === LOADING
          ? machineRows.map((row) => ({ ...row, placementPending: true }))
          : readRows('settingsMachine', catalog?.machines ?? []),
    },
    {
      key: 'repositories',
      fields: {},
      rows:
        catalog === LOADING
          ? repositoryRows.map((row) => ({ ...row, placementPending: true }))
          : readRows('settingsRepository', catalog?.repositories ?? []),
    },
    {
      key: 'window',
      fields: window && window !== LOADING ? window : {},
      pendingFields: window === LOADING ? ['settingsTab'] : [],
      rows: [],
    },
    {
      key: 'setup',
      fields: {
        usage: [...setup.usage].sort(([a], [b]) => a.localeCompare(b)),
        defaultAgent: setup.defaultAgent,
      },
      pendingFields: setup.pending ? ['usage', 'defaultAgent'] : [],
      rows: sessions.pending
        ? state.sessions.map((row) => ({ id: row.sessionId, fields: {}, placementPending: true }))
        : sessions.rows.map((row) => ({ id: row.sessionId, fields: {} })),
    },
  ]
  const result = compareSidebarSnapshots(
    { sections: expected, pending: 0 },
    { sections: actual, pending },
  )
  const preferences = checkPreferences(pool, owner.ui)
  return {
    differences: result.differences + preferences.differences,
    pending: result.pending + preferences.pending,
    positions: result.rows + preferences.positions,
    first: result.first
      ? { section: result.first.sectionIndex, index: result.first.rowIndex }
      : preferences.first
        ? { section: expected.length, index: preferences.first.index }
        : null,
  }
}
