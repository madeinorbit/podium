import type { IssueUpdatePatch } from '@podium/commands'
import { draft } from '@podium/mobx-helpers'

export type AgentSettingsRecord = Pick<IssueUpdatePatch,
  'defaultAgent' | 'defaultModel' | 'defaultEffort' | 'machineId'>
export type AgentSettingsPatch = Partial<AgentSettingsRecord>

/** Both issue configuration forms edit the same canonical field names. */
export function agentSettingsDraft<R>(record: AgentSettingsRecord, save: (changes: AgentSettingsPatch) => R) {
  return draft(record, {
    fields: ['defaultAgent', 'defaultModel', 'defaultEffort', 'machineId'],
    save,
  })
}
