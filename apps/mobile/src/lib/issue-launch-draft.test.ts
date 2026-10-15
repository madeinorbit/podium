import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { IssueLaunchForm, issueLaunchDraft, patchIssueLaunchDraft } from './issue-launch-draft'
import { launchConfigurationForIssue, selectLaunchEffort, selectLaunchModel, selectLaunchMachine } from './launch-configuration'

describe('phone issue launch draft', () => {
  it('follows Settings until a model is chosen, then pins its harness', async () => {
    const record = observable({ defaultAgent: 'auto', defaultModel: 'auto', defaultEffort: 'auto', machineId: null })
    const settings = observable({ codingHarness: 'claude-code' })
    const save = vi.fn(async () => {})
    const form = new IssueLaunchForm(record, save, () => settings.codingHarness)
    const values: string[] = []
    const stop = autorun(() => { values.push(form.configuration.agentKind) })
    try {
      runInAction(() => { settings.codingHarness = 'codex' })
      expect(values).toEqual(['claude-code', 'codex'])
      form.patch(selectLaunchModel(form.configuration, 'codex:gpt-6.1-sol'))
      runInAction(() => { settings.codingHarness = 'claude-code' })
      expect(form.configuration.agentKind).toBe('codex')
      await form.edits.submit()
      expect(save).toHaveBeenCalledExactlyOnceWith({ defaultAgent: 'codex', defaultModel: 'gpt-6.1-sol' })
    } finally { stop() }
  })

  it('keeps auto on a machine-only change and pins auto issues with existing model overrides', async () => {
    const record = observable({ defaultAgent: 'auto', defaultModel: 'auto', defaultEffort: 'auto', machineId: null })
    const save = vi.fn(async () => {})
    const form = new IssueLaunchForm(record, save, () => 'codex')
    form.patch(selectLaunchMachine(form.configuration, 'host'))
    await form.edits.submit()
    expect(save).toHaveBeenCalledExactlyOnceWith({ machineId: 'host' })
    runInAction(() => { record.defaultModel = 'gpt-6.1-sol' })
    const override = new IssueLaunchForm(record, save, () => 'codex')
    override.patch(selectLaunchEffort(override.configuration, 'high'))
    await override.edits.submit()
    expect(save).toHaveBeenLastCalledWith({ defaultAgent: 'codex', defaultEffort: 'high' })
  })
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
