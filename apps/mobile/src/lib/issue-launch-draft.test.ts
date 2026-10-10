import { observable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { issueLaunchDraft, patchIssueLaunchDraft } from './issue-launch-draft'
import { launchConfigurationForIssue, selectLaunchEffort } from './launch-configuration'

describe('phone issue launch draft', () => {
  it('matches old launch defaults, follows untouched fields, resets and sends touched fields', async () => {
    const record = observable({ defaultAgent: 'codex', defaultModel: 'gpt-6.1-sol', defaultEffort: 'auto', machineId: null })
    const save = vi.fn(async () => {})
    const edits = issueLaunchDraft(record, save)
    expect(launchConfigurationForIssue(edits)).toEqual(launchConfigurationForIssue(record))
    patchIssueLaunchDraft(edits, selectLaunchEffort(launchConfigurationForIssue(edits), 'high'))
    runInAction(() => { record.defaultModel = 'gpt-6-sol' })
    expect(launchConfigurationForIssue(edits).modelPick).toBe('codex:gpt-6-sol')
    await edits.submit()
    expect(save).toHaveBeenCalledExactlyOnceWith({ defaultEffort: 'high' })
    edits.defaultEffort = 'low'
    edits.reset()
    expect(edits.defaultEffort).toBe('auto')
  })
})
