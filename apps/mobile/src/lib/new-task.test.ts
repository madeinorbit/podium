import { asMachineId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { newTaskInput, newTaskSubmitState } from './new-task'

const launch = {
  defaultAgent: 'codex',
  defaultModel: 'gpt-5.6-sol',
  defaultEffort: 'high',
  machineId: asMachineId('phone-host'),
}

describe('New Task submit controls', () => {
  const ready = {
    busy: false,
    draftLoading: false,
    hasProject: true,
    hasMachine: true,
    hasCheckout: true,
    machineDenied: false,
    ready: true,
    prompt: '',
    attachmentCount: 0,
    uploading: false,
  }
  it('enables Start for an empty prompt and enables Save only after text is written', () => {
    expect(newTaskSubmitState(ready)).toEqual({ canStart: true, canSave: false })
    expect(newTaskSubmitState({ ...ready, prompt: 'Do this' })).toEqual({
      canStart: true,
      canSave: true,
    })
  })
  it.each(['busy', 'draftLoading', 'uploading'] as const)('waits for %s', (field) => {
    expect(newTaskSubmitState({ ...ready, prompt: 'Do this', [field]: true })).toEqual({
      canStart: false,
      canSave: false,
    })
  })
  it('allows filing a prompt even when its machine cannot start work', () => {
    expect(
      newTaskSubmitState({ ...ready, prompt: 'Do this', machineDenied: true, ready: false }),
    ).toEqual({ canStart: false, canSave: true })
  })
  it('keeps attachment refs on Start and explains why Save is unavailable', () => {
    expect(newTaskSubmitState({ ...ready, prompt: 'Do this', attachmentCount: 1 })).toEqual({
      canStart: true,
      canSave: false,
      saveReason: 'Attachments go with Start',
    })
    expect(newTaskSubmitState({ ...ready, attachmentCount: 1 }).canStart).toBe(false)
    expect(
      newTaskSubmitState({ ...ready, prompt: 'Keep my file', shell: true, attachmentCount: 1 })
        .canStart,
    ).toBe(false)
  })
})

describe('newTaskInput', () => {
  it('preserves the configured prompt verbatim through immediate launch', () => {
    const prompt = '  Keep this exact first prompt\n\n- including its structure\n'
    expect(
      newTaskInput({
        repoPath: ' /repo ',
        title: ' Task ',
        prompt,
        type: 'task',
        priority: 1,
        startNow: true,
        launch,
      }),
    ).toEqual({
      repoPath: '/repo',
      title: 'Task',
      description: prompt,
      type: 'task',
      priority: 1,
      startNow: true,
      defaultAgent: 'codex',
      defaultModel: 'gpt-5.6-sol',
      defaultEffort: 'high',
      machineId: asMachineId('phone-host'),
    })
  })

  it('keeps task context but omits execution choices when filing for later', () => {
    const input = newTaskInput({
      repoPath: '/repo',
      title: 'Later',
      prompt: 'Durable context',
      type: 'task',
      priority: 2,
      startNow: false,
      launch,
    })
    expect(input.description).toBe('Durable context')
    expect(input).not.toHaveProperty('defaultAgent')
    expect(input).not.toHaveProperty('defaultModel')
    expect(input).not.toHaveProperty('defaultEffort')
    expect(input).not.toHaveProperty('machineId')
  })

  it('keeps the configured coding role authoritative when Agent stays Auto', () => {
    const input = newTaskInput({
      repoPath: '/repo',
      title: 'Use configured role',
      prompt: 'Start with the configured coding agent',
      type: 'task',
      priority: 2,
      startNow: true,
      launch: { ...launch, defaultAgent: undefined },
    })
    expect(input).not.toHaveProperty('defaultAgent')
    expect(input).toMatchObject({
      defaultModel: 'gpt-5.6-sol',
      defaultEffort: 'high',
      machineId: asMachineId('phone-host'),
    })
  })

  it('omits every untouched Auto execution override', () => {
    const input = newTaskInput({
      repoPath: '/repo',
      title: 'All configured defaults',
      prompt: '',
      type: 'task',
      priority: 2,
      startNow: true,
      launch: {
        defaultAgent: undefined,
        defaultModel: 'auto',
        defaultEffort: 'auto',
        machineId: null,
      },
    })
    expect(input).not.toHaveProperty('defaultAgent')
    expect(input).not.toHaveProperty('defaultModel')
    expect(input).not.toHaveProperty('defaultEffort')
    expect(input).not.toHaveProperty('machineId')
  })
})
