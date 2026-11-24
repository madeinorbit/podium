import { asSessionId } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  open: vi.fn(),
  launch: vi.fn(),
  kill: vi.fn(),
  navigate: vi.fn(),
  managed: undefined as { active: { version: string } } | undefined,
}))
vi.mock('@podium/client-core/react', () => ({
  useCommands: () => ({ sessions: { launch: state.launch, killSession: state.kill } }),
  useUi: () => ({ navigateToSession: state.navigate }),
}))
vi.mock('@/features/setup-agents/open-setup-agents', () => ({ openSetupAgents: state.open }))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => ({
    sessionObject: () => ({
      sessionId: 'failed-session',
      cwd: '/project',
      launch: { input: { issueId: 'issue-1', model: 'chosen-model', effort: 'high' } },
      installRecoveryHarness: {
        kind: 'codex',
        label: 'Codex',
        machine: { id: 'test-machine' },
        managed: state.managed,
      },
    }),
  }),
}))

import { InstallCurrentHarness } from './InstallCurrentHarness'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  state.managed = undefined
  state.launch.mockReturnValue({ sessionId: asSessionId('managed-session') })
})

function openPanel(): { onStart: (harness: string) => void } {
  render(
    <InstallCurrentHarness
      sessionId={asSessionId('failed-session')}
      firstPrompt="Continue the task"
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Set up a current Codex…' }))
  expect(state.open).toHaveBeenCalledTimes(1)
  return state.open.mock.calls[0]?.[0]
}

describe('too-old start recovery', () => {
  it('opens Set up agents on the harness and installs nothing itself', () => {
    const request = openPanel()
    expect(request).toMatchObject({ machineId: 'test-machine', origin: 'menu', focus: 'codex' })
    expect(state.launch).not.toHaveBeenCalled()
  })

  it('starts the same launch again when the panel hands the harness back', () => {
    openPanel().onStart('codex')
    expect(state.launch).toHaveBeenCalledWith({
      target: { path: '/project', repoPath: '/project', machineId: 'test-machine' },
      agentKind: 'codex',
      issueId: 'issue-1',
      model: 'chosen-model',
      effort: 'high',
      firstPrompt: 'Continue the task',
    })
    expect(state.kill).toHaveBeenCalledWith('failed-session')
    expect(state.navigate).toHaveBeenCalledWith('managed-session')
  })

  it('drops the failed launch’s model when the person starts another harness instead', () => {
    openPanel().onStart('claude-code')
    expect(state.launch).toHaveBeenCalledWith({
      target: { path: '/project', repoPath: '/project', machineId: 'test-machine' },
      agentKind: 'claude-code',
      issueId: 'issue-1',
      firstPrompt: 'Continue the task',
    })
  })

  it('names Podium’s copy once it is installed', () => {
    state.managed = { active: { version: '0.171.0' } }
    render(<InstallCurrentHarness sessionId={asSessionId('failed-session')} />)
    expect(screen.getByRole('button', { name: 'Start on Podium’s Codex…' })).toBeTruthy()
  })
})
