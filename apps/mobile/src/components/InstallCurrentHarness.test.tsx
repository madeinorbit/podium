import { asMachineId, asSessionId, type BuiltinHarnessKind } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  launch: vi.fn(() => ({ sessionId: 'new-session' })),
  kill: vi.fn(),
  navigate: vi.fn(),
  sheet: vi.fn(),
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: async () => {},
}))
vi.mock('@podium/client-core/react', () => ({
  useCommands: () => ({ sessions: { launch: state.launch, killSession: state.kill } }),
  useUi: () => ({ navigateToSession: state.navigate }),
}))
vi.mock('../client/mobile-pool', () => ({
  useMobilePool: () => ({
    sessionObject: () => ({
      sessionId: 'old-session',
      cwd: '/synthetic/project',
      issueId: 'task',
      launch: { input: { model: 'chosen-model', effort: 'high', firstPrompt: 'Keep my task' } },
      installRecoveryHarness: {
        kind: 'codex',
        label: 'Codex',
        machine: { id: asMachineId('machine') },
      },
    }),
  }),
}))
vi.mock('./AgentSetupSheet', () => ({
  PhoneAgentSetupSheet: (props: { onStart: (harness: BuiltinHarnessKind) => void }) => {
    state.sheet(props)
    return (
      <>
        <button type="button" onClick={() => props.onStart('codex')}>
          Start current Codex
        </button>
        <button type="button" onClick={() => props.onStart('claude-code')}>
          Start Claude instead
        </button>
      </>
    )
  },
}))

import { PhoneInstallCurrentHarness } from './InstallCurrentHarness'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
it('opens focused setup, then relaunches with the original task and prompt after handback', () => {
  render(<PhoneInstallCurrentHarness sessionId={asSessionId('old-session')} />)
  expect(state.sheet).not.toHaveBeenCalled()
  expect(state.launch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Set up Codex' }))
  expect(state.sheet).toHaveBeenLastCalledWith(
    expect.objectContaining({ machineId: 'machine', origin: 'menu', focus: 'codex' }),
  )
  fireEvent.click(screen.getByText('Start current Codex'))
  expect(state.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      agentKind: 'codex',
      issueId: 'task',
      model: 'chosen-model',
      effort: 'high',
      firstPrompt: 'Keep my task',
    }),
  )
  expect(state.kill).toHaveBeenCalledWith('old-session')
  expect(state.navigate).toHaveBeenCalledWith('new-session')
})

it('uses a different harness selected in setup without carrying over incompatible model or effort', () => {
  render(<PhoneInstallCurrentHarness sessionId={asSessionId('old-session')} />)
  fireEvent.click(screen.getByRole('button', { name: 'Set up Codex' }))
  fireEvent.click(screen.getByText('Start Claude instead'))
  expect(state.launch).toHaveBeenCalledWith({
    target: { path: '/synthetic/project', repoPath: '/synthetic/project', machineId: 'machine' },
    agentKind: 'claude-code',
    issueId: 'task',
    firstPrompt: 'Keep my task',
  })
  expect(state.kill).toHaveBeenCalledWith('old-session')
  expect(state.navigate).toHaveBeenCalledWith('new-session')
})
