import type { AutomationRunWire, AutomationWire } from '@podium/model/browser'

export interface AutomationRows {
  automation: AutomationWire
  automationRun: AutomationRunWire
  automationCatalog: { automations: readonly string[]; runs: readonly string[] }
}
declare module './source-registry' { interface PoolSourceRows extends AutomationRows {} }
export type AutomationEntity = keyof AutomationRows
export const AUTOMATION_ENTITIES = ['automation', 'automationRun', 'automationCatalog'] as const
export const AUTOMATION_RELATIONS = [
  { from: 'automation', key: 'targetSessionId', name: 'target', to: 'session', inverse: 'targetedAutomations' },
  { from: 'automation', key: 'repoPath', name: 'repository', to: 'repository', inverse: 'automations' },
  { from: 'automationRun', key: 'automationId', name: 'automation', to: 'automation', inverse: 'runs' },
  { from: 'automationRun', key: 'sessionId', name: 'session', to: 'session', inverse: 'automationRuns' },
] as const
