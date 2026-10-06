import { machinePathKey } from '@podium/model'
import type { Store } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'

/** Settings-only declarations. Catalog ids name resident machine/repository
 * rows; session history uses a small summary, never an index of cold payloads.
 * There are no new entity relations: session presence is a keyed read. */
export interface SettingsRows {
  settingsMachine: Store['machines'][number]
  settingsRepository: Store['repos'][number]
  settingsCatalog: { machines: readonly string[]; repositories: readonly string[] }
  settingsWindow: { settingsTab: Store['settingsTab'] }
}
export type SettingsEntity = keyof SettingsRows
export const SETTINGS_SCHEMA = {
  settingsMachine: { key: 'id', source: 'engine:machines', model: 'MachineWire', residency: 'resident-on-demand' },
  settingsRepository: { key: 'machineId,path', source: 'engine:repos', model: 'GitRepositoryWire', residency: 'resident-on-demand' },
  settingsCatalog: { key: 'catalog', source: 'engine:locals', fields: ['machines', 'repositories'], residency: 'on-demand' },
  settingsWindow: { key: 'window', source: 'engine:locals', fields: ['settingsTab'], residency: 'on-demand' },
  setupSession: { key: 'sessionId', source: 'pool:session', fields: [
    'sessionId', 'cwd', 'lastActiveAt', 'agentKind', 'headless', 'resume', 'status', 'setupOrder',
  ], residency: 'declared-summary' },
  relations: {},
} as const

// Source order belongs to the setup reader, never to a copied full session.
export const SETUP_SESSION_SUMMARY_FIELDS = SETTINGS_SCHEMA.setupSession.fields.filter(field => field !== 'setupOrder')
export type SetupSession = Pick<SessionView, 'sessionId' | 'cwd' | 'lastActiveAt' | 'agentKind' | 'headless' | 'resume' | 'status'> & { setupOrder: number }
export function isSettingsEntity(entity: string): entity is SettingsEntity {
  return entity !== 'setupSession' && entity !== 'relations' && Object.hasOwn(SETTINGS_SCHEMA, entity)
}
export const settingsRepositoryId = (repo: SettingsRows['settingsRepository']): string => JSON.stringify([repo.machineId ?? '', machinePathKey(repo.path)])

const setupSummaries = new WeakMap<object, { order: number; value: SetupSession }>()
export function setupSessionSummary(row: Readonly<Record<string, unknown>>, order = row['setupOrder'] as number): SetupSession {
  const previous = setupSummaries.get(row)
  if (previous && previous.order === order) return previous.value
  const value = Object.freeze({
    ...Object.fromEntries(SETUP_SESSION_SUMMARY_FIELDS.map((key) => [key, row[key]])), setupOrder: order,
  }) as SetupSession
  setupSummaries.set(row, { order, value })
  return value
}
