import { agentSettingsDraft, type AgentSettingsPatch, type AgentSettingsRecord } from '@podium/client-graph/write/agent-settings-draft'
import { lazy } from '@podium/mobx-helpers'
import { compareShallow } from 'mobx'
import { launchConfigurationForIssue, launchConfigurationPatch, type LaunchConfiguration } from './launch-configuration'

export function issueLaunchDraft(record: AgentSettingsRecord, save: (patch: AgentSettingsPatch) => Promise<unknown>) {
  const edits = agentSettingsDraft(record, patch => save(patch).catch(error => {
    Object.assign(edits, patch)
    throw error
  }))
  return edits
}

/** Stable picker input while unrelated sheet state (plan/error/busy) changes. */
export class IssueLaunchForm {
  readonly edits
  constructor(record: AgentSettingsRecord, save: (patch: AgentSettingsPatch) => Promise<unknown>, private readonly codingHarness: () => string | undefined = () => undefined) {
    this.edits = issueLaunchDraft(record, save)
  }
  @lazy({ equals: compareShallow }) get configuration() { return launchConfigurationForIssue(this.edits, this.codingHarness()) }
  patch(next: LaunchConfiguration) { patchIssueLaunchDraft(this.edits, next, this.codingHarness()) }
}

/** The picker returns a complete value. Compare it with the current display so
 * only the selected field and its dependent resets enter the record draft. */
export function patchIssueLaunchDraft(edits: ReturnType<typeof issueLaunchDraft>, next: LaunchConfiguration, codingHarness?: string): void {
  const before = launchConfigurationPatch(launchConfigurationForIssue(edits, codingHarness))
  const after = launchConfigurationPatch(next)
  for (const key of Object.keys(after) as (keyof AgentSettingsPatch)[]) {
    // A concrete model/effort must pin an inherited harness even if the previous
    // displayed configuration already carried the same override.
    if (after[key] !== before[key] || (key === 'defaultAgent' && after[key] !== edits.defaultAgent))
      Object.assign(edits, { [key]: after[key] })
  }
}
