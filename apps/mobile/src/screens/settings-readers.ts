import type { Store } from '@podium/client-core/engine'
import { shallowEqual } from '@podium/client-core/store'
import type { MobxPool } from '@podium/client-graph'
import type { MobileSettingsDiagnostics } from '@podium/client-graph/mobile-settings'
import type { HostMetricsWire } from '@podium/model'
import { useHostMetrics, useIssues, useStoreSelector } from '../client/hooks'
import { mobileDataLayer, useMobilePoolProjection } from '../client/mobile-pool'

export interface SettingsData extends MobileSettingsDiagnostics {
  machines: Store['machines']
  hosts: HostMetricsWire[]
  sessionCount: number
  outboxSize: number
  outboxDeadLetters: Store['outboxDeadLetters']
}
const EMPTY_SETTINGS: SettingsData = {
  machines: [], hosts: [], sessionCount: 0, issueCount: 0, conversationCount: 0,
  cursor: null, outboxSize: 0, outboxDeadLetters: [],
}
const loaded = <T extends object>(row: T | symbol | undefined): row is T =>
  typeof row === 'object' && row !== null

/** One retained projection per screen. Catalog rows and session summaries use
 * the same Settings source/views as web; diagnostics never escape to a replica
 * getter in React. Every payload comes through the pool's single row reader. */
export function readSettingsData(pool: MobxPool): SettingsData {
  const catalog = pool.row('settingsCatalog', 'catalog')
  const diagnostics = pool.row('mobileSettingsDiagnostics', 'diagnostics')
  const window = pool.row('window', 'window') as Pick<Store, 'outboxSize'> | undefined
  const notices = pool.row('noticeCatalog', 'catalog')
  return {
    machines: loaded(catalog) ? catalog.machines.flatMap(id => {
      const row = pool.row('settingsMachine', id)
      return loaded(row) ? [row] : []
    }) : [],
    hosts: (pool.header.orders.get('hostMetric') ?? []).flatMap(id => {
      const row = pool.row('hostMetric', id) as HostMetricsWire | undefined
      return row ? [row] : []
    }),
    sessionCount: pool.settingsViews.sessions().rows.length,
    issueCount: loaded(diagnostics) ? diagnostics.issueCount : 0,
    conversationCount: loaded(diagnostics) ? diagnostics.conversationCount : 0,
    cursor: loaded(diagnostics) ? diagnostics.cursor : null,
    outboxSize: window?.outboxSize ?? 0,
    outboxDeadLetters: loaded(notices) ? notices.deadLetters.flatMap(id => {
      const row = pool.row('outboxDeadLetter', id)
      return loaded(row) ? [row] : []
    }) : [],
  }
}

function useLegacySettingsData(): SettingsData {
  const { conversations, machines, outboxDeadLetters, outboxSize, replica, sessions } =
    useStoreSelector(s => ({ conversations: s.conversations, machines: s.machines,
      outboxDeadLetters: s.outboxDeadLetters, outboxSize: s.outboxSize,
      replica: s.replica, sessions: s.sessions }), shallowEqual)
  const issues = useIssues()
  const hosts = useHostMetrics()
  return { machines, hosts, outboxDeadLetters, outboxSize, sessionCount: sessions.length,
    issueCount: issues.length, conversationCount: conversations.length, cursor: replica.getCursor() }
}
function usePoolSettingsData(): SettingsData {
  return useMobilePoolProjection(readSettingsData, EMPTY_SETTINGS)
}

/** The startup choice is fixed before screens mount. Pool attachment may still
 * be pending; it changes the projection's source, never the hook branch. */
export function useSettingsData(): SettingsData {
  const useData = mobileDataLayer() === 'pool' ? usePoolSettingsData : useLegacySettingsData
  return useData()
}
