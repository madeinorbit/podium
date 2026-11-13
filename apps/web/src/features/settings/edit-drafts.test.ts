import { agentSettingsDraft } from '@podium/client-graph/write/agent-settings-draft'
import { type AutomationWire, asAutomationId } from '@podium/model'
import { observable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { AutomationEditDraft } from '../automations/automation-edit-draft'
import { automationInput, GLOBAL_TARGET } from '../automations/automation-form'
import { initialState } from '../automations/automation-state.test.fixture'

function automation(overrides: Partial<AutomationWire> = {}): AutomationWire {
  return observable({
    id: asAutomationId('aut_draft'),
    name: 'Sweep',
    prompt: 'Check it',
    repoPath: '/repo',
    enabled: true,
    scheduleKind: 'cron' as const,
    cron: '0 9 * * *',
    runAt: null,
    targetSessionId: null,
    agentKind: 'codex',
    model: 'auto',
    effort: 'auto',
    sessionMode: 'fresh' as const,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: '2026-10-10T00:00:00Z',
    ...overrides,
  })
}

describe('standard edit draft parity before removing form copies', () => {
  it.each([
    {},
    { scheduleKind: 'once' as const, runAt: '2099-10-11T12:30:00Z', cron: null },
    { agentKind: 'claude-code', enabled: false, repoPath: null, sessionMode: 'resume' as const },
  ])('answers the same automation inputs as the old initialization: %j', (overrides) => {
    const record = automation(overrides)
    const edits = new AutomationEditDraft(
      record,
      vi.fn(async () => {}),
    )
    expect(automationInput(edits, record)).toEqual(
      automationInput(initialState(record, GLOBAL_TARGET), record),
    )
  })
  it('answers the same agent selection and combined edit as the old desktop copy', () => {
    const record = observable({
      defaultAgent: 'codex',
      defaultModel: 'auto',
      defaultEffort: 'high',
      machineId: null,
    })
    const old = { ...record }
    const save = vi.fn()
    const edits = agentSettingsDraft(record, save)
    for (const key of Object.keys(old) as (keyof typeof old)[]) expect(edits[key]).toEqual(old[key])
    const patch = { defaultModel: 'gpt-6.1-sol', defaultEffort: 'auto' }
    Object.assign(edits, patch)
    expect({ ...old, ...patch }).toMatchObject({
      defaultModel: edits.defaultModel,
      defaultEffort: edits.defaultEffort,
    })
    edits.submit()
    expect(save).toHaveBeenCalledExactlyOnceWith(patch)
  })
})

describe('open form live fields, discard and touched-only submission', () => {
  it('follows untouched automation fields, preserves edited text and resets to live', async () => {
    const record = automation()
    const save = vi.fn(async () => {})
    const edits = new AutomationEditDraft(record, save)
    edits.patch({ name: 'My sweep' })
    runInAction(() => {
      record.prompt = 'Elsewhere'
      record.cron = '*/5 * * * *'
      record.name = 'Remote sweep'
    })
    expect(edits.prompt).toBe('Elsewhere')
    expect(edits.rawCron).toBe('*/5 * * * *')
    expect(edits.name).toBe('My sweep')
    await edits.submit()
    expect(save).toHaveBeenCalledExactlyOnceWith({ name: 'My sweep' })
    edits.patch({ name: 'Unsent' })
    edits.reset()
    expect(edits.name).toBe('Remote sweep')
    expect(edits.isDirty).toBe(false)
  })
  it('does not round an untouched one-off timestamp into a changed field', async () => {
    const record = automation({ scheduleKind: 'once', cron: null, runAt: '2099-10-11T12:30:45Z' })
    const save = vi.fn(async () => {})
    const edits = new AutomationEditDraft(record, save)
    edits.patch({ prompt: 'Changed prompt' })
    await edits.submit()
    expect(save).toHaveBeenCalledExactlyOnceWith({ prompt: 'Changed prompt' })
  })
  it('keeps untouched agent values live while a selection is dirty', () => {
    const record = observable({
      defaultAgent: 'codex',
      defaultModel: 'auto',
      defaultEffort: 'auto',
      machineId: null,
    })
    const save = vi.fn()
    const edits = agentSettingsDraft(record, save)
    edits.defaultEffort = 'high'
    runInAction(() => {
      record.defaultModel = 'gpt-6.1-sol'
    })
    expect(edits.defaultModel).toBe('gpt-6.1-sol')
    edits.submit()
    expect(save).toHaveBeenCalledExactlyOnceWith({ defaultEffort: 'high' })
    edits.defaultEffort = 'low'
    edits.reset()
    expect(edits.defaultEffort).toBe('auto')
  })
})
