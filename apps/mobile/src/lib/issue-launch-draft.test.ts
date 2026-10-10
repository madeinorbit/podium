import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { IssueLaunchForm, issueLaunchDraft, patchIssueLaunchDraft } from './issue-launch-draft'
import { launchConfigurationForIssue, selectLaunchEffort } from './launch-configuration'

describe('phone issue launch draft', () => {
  it('keeps the picker input stable until a displayed field changes', () => {
    const record = observable({ defaultAgent: 'codex', defaultModel: 'auto', defaultEffort: 'auto', machineId: null })
    const form = new IssueLaunchForm(record, vi.fn(async () => {}))
    const values: unknown[] = []
    const stop = autorun(() => { values.push(form.configuration) })
    try {
      expect(form.configuration).toBe(values[0])
      runInAction(() => { record.defaultModel = 'gpt-6.1-sol' })
      expect(form.configuration).toBe(values[1])
      expect(form.configuration.modelPick).toBe('codex:gpt-6.1-sol')
    } finally { stop() }
  })
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
