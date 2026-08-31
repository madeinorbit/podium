import { asMachineId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { newTaskInput } from './new-task'

const launch = {
  defaultAgent: 'codex',
  defaultModel: 'gpt-5.6-sol',
  defaultEffort: 'high',
  machineId: asMachineId('phone-host'),
}

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
})
