import type { AutomationRunWire, AutomationWire } from '@podium/model/browser'

export interface AutomationRows {
  automation: AutomationWire
  automationRun: AutomationRunWire
  automationCatalog: { automations: readonly string[]; runs: readonly string[] }
}
declare module './source-registry' { interface PoolSourceRows extends AutomationRows {} }
export type AutomationEntity = keyof AutomationRows

/** Definitions/history are resident on demand. Launch catalogs reuse the
 * declared machine/repository source; cold sessions use its setup summary.
 * No new index contains cold session payloads. */
export const AUTOMATION_SCHEMA = {
  automation: { key: 'id', source: 'replica:automations', residency: 'resident-on-demand' },
  automationRun: { key: 'id', source: 'replica:automationRuns', residency: 'resident-on-demand' },
  automationCatalog: { key: 'catalog', source: 'replica:membership', residency: 'on-demand' },
  repository: { source: 'pool:settingsRepository', targetKey: 'path' },
  machine: { source: 'pool:settingsMachine', targetKey: 'id' },
  session: { source: 'pool:setupSession', summary: ['sessionId', 'cwd', 'lastActiveAt', 'resume', 'status', 'setupOrder'] },
} as const
export const AUTOMATION_ENTITIES = ['automation', 'automationRun', 'automationCatalog'] as const
export const AUTOMATION_RELATIONS = [
  { from: 'automation', key: 'targetSessionId', name: 'target', to: 'session', inverse: 'targetedAutomations' },
  { from: 'automation', key: 'repoPath', name: 'repository', to: 'repository', inverse: 'automations' },
  { from: 'automationRun', key: 'automationId', name: 'automation', to: 'automation', inverse: 'runs' },
  { from: 'automationRun', key: 'sessionId', name: 'session', to: 'session', inverse: 'automationRuns' },
] as const
