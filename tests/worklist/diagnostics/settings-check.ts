import type { RoutedUiState } from '@podium/client-core/ui-state'
import { createRepositoryUsageSelector, resolveDefaultAgent } from '@podium/client-core/values'
import { omitGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import { settingsView } from '@podium/client-graph/settings-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { checkPreferences } from './preference-check'
import { referenceState } from './reference-state'
import { type CheckRow, type CheckSection, compareSidebarSnapshots } from './sidebar-check'

export interface SettingsCheckOwner {
  readonly access: import('./reference-state').ReferenceState
  readonly replica?: import('@podium/client-core/replica').Replica
  readonly deviceState: RoutedUiState
}

export function checkSettings(pool: MobxPool, owner: SettingsCheckOwner) {
  const state = referenceState(owner)
  const catalog = omitGone(pool.row('settingsCatalog', 'catalog'))
  const window = omitGone(pool.row('settingsWindow', 'window'))
  const expectedUsage = createRepositoryUsageSelector()(state.sessions)
  const setup = settingsView(pool).setup([...expectedUsage.keys()])
  const sessions = settingsView(pool).sessions()
  let pending = Number(catalog === LOADING) + Number(window === LOADING) + setup.pending
  const rows = (values: readonly (readonly [string, object])[]): CheckRow[] =>
    values.map(([id, value]) => ({ id, fields: { value } }))
  // What Settings shows (POD-6644): a machine's name, and a repository's path,
  // kind and worktree paths. The pool's rows are records (a machine joined with
  // my access row, a repository derived from its checkouts on its machine).
  const machineView = (row: { id: string; name: string }) => ({ id: row.id, name: row.name })
  const repositoryView = (row: {
    path: string
    kind: string
    worktrees?: readonly { path: string }[]
  }) => ({
    path: row.path,
    kind: row.kind,
    worktrees: (row.worktrees ?? []).map((tree) => tree.path),
  })
  const machineRows = rows(state.machines.map((row) => [row.id, machineView(row)]))
  const repositoryRows = rows(state.repos.map((row) => [row.path, repositoryView(row)]))
  const expected: CheckSection[] = [
    { key: 'machines', fields: {}, rows: machineRows },
    { key: 'repositories', fields: {}, rows: repositoryRows },
    { key: 'window', fields: { settingsTab: state.settingsTab }, rows: [] },
    {
      key: 'setup',
      fields: {
        usage: [...expectedUsage].sort(([a], [b]) => a.localeCompare(b)),
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
      const row = omitGone(pool.row(entity, id))
      if (row === LOADING) pending++
      const value =
        row === LOADING || !row
          ? undefined
          : entity === 'settingsMachine'
            ? machineView(row as { id: string; name: string })
            : repositoryView(row as { path: string; kind: string })
      const key = value && 'path' in value ? value.path : id
      return { id: key, pending: row === LOADING, fields: value ? { value } : {} }
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
      fields: window && window !== LOADING ? { settingsTab: window.settingsTab } : {},
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
  const preferences = checkPreferences(pool, owner.deviceState)
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
