import type { IssueProjection, MachineId } from '@podium/model'
import { draft } from '@podium/mobx-helpers'

export type AgentSettingsRecord = Partial<Pick<IssueProjection,
  'defaultAgent' | 'defaultModel' | 'defaultEffort'>> & { readonly machineId?: MachineId | null }
export type AgentSettingsPatch = Partial<AgentSettingsRecord>

/** Both issue configuration forms edit the same canonical field names. */
export function agentSettingsDraft<R>(record: AgentSettingsRecord, save: (changes: AgentSettingsPatch) => R) {
  return draft(record, {
    fields: ['defaultAgent', 'defaultModel', 'defaultEffort', 'machineId'],
    save,
  })
}
