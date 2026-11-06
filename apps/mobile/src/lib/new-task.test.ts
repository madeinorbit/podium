import { asMachineId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { newTaskInput, newTaskStart } from './new-task'

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

describe('newTaskStart', () => {
  it('starts on the pinned agent with the prompt verbatim, its priority and stage', () => {
    const prompt = '  Keep this exact first prompt\n'
    expect(
      newTaskStart({
        repoPath: ' /repo ',
        title: ' Task ',
        prompt,
        priority: 1,
        stage: 'review',
        agentKind: 'claude-code',
        launch,
      }),
    ).toEqual({
      target: { path: '/repo', repoPath: '/repo', machineId: asMachineId('phone-host') },
      title: 'Task',
      description: prompt,
      agentKind: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      priority: 1,
      stage: 'review',
    })
  })

  it('leaves Auto choices and the defaults off, on the configured agent', () => {
    const start = newTaskStart({
      repoPath: '/repo',
      title: 'Configured',
      prompt: '   ',
      priority: 2,
      stage: 'backlog',
      agentKind: 'claude-code',
      launch: {
        defaultAgent: undefined,
        defaultModel: 'auto',
        defaultEffort: 'auto',
        machineId: null,
      },
    })
    expect(start).toEqual({
      target: { path: '/repo', repoPath: '/repo' },
      title: 'Configured',
      description: '',
      // Painted while it waits; the server resolves the configured agent.
      agentKind: 'claude-code',
      inheritAgent: true,
    })
  })
})
