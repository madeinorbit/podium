import { asCredentialId, asMachineId, asSessionId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  install: vi.fn(),
  launch: vi.fn(),
  kill: vi.fn(),
  navigate: vi.fn(),
  reload: vi.fn(),
  managed: undefined as { active: { version: string } } | undefined,
}))
vi.mock('@podium/client-core/react', () => ({
  useRequestClient: () => ({ harnessInstalls: { action: { mutate: state.install } } }),
  useCommands: () => ({ sessions: { launch: state.launch, killSession: state.kill } }),
  useUi: () => ({ navigateToSession: state.navigate }),
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => ({
    sessionObject: () => ({
      sessionId: 'failed-session',
      cwd: '/project',
      launch: { input: { issueId: 'issue-1', model: 'chosen-model', effort: 'high' } },
      installRecoveryHarness: {
        kind: 'codex',
        machine: { id: 'test-machine' },
        canAct: true,
        managed: state.managed,
        inventory: { management: { installable: true } },
      },
    }),
  }),
}))
vi.mock('@/features/credentials/session/SessionCredentialNotice', () => ({
  useOpenCredentials: () => () => {},
}))
vi.mock('@/features/credentials/session/use-session-credentials', () => ({
  useHarnessAccepts: () => () => [{ type: 'openai.api-key' }],
  useSessionCredentials: () => ({
    views: [
      {
        id: 'cred_00000000-0000-4000-8000-000000000001',
        type: 'openai.api-key',
        label: 'Project key',
        ownerUserId: 'person',
        status: 'ready',
        homes: [],
        allowedMachines: ['test-machine'],
      },
    ],
    custodianOf: () => 'person',
    reload: state.reload,
  }),
}))
// Keep this on the recovery handoff, without portal or pointer machinery.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ render }: { render: ReactNode }) => render,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode
    onClick: () => void
    disabled: boolean
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}))

import { InstallCurrentHarness } from './InstallCurrentHarness'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  state.managed = undefined
  state.install.mockResolvedValue({ ok: true })
  state.launch.mockReturnValue({ sessionId: asSessionId('managed-session') })
})

describe('too-old start recovery', () => {
  it('installs only on request, then launches on the chosen credential with the original launch input', async () => {
    render(
      <InstallCurrentHarness
        sessionId={asSessionId('failed-session')}
        firstPrompt="Continue the task"
      />,
    )
    expect(state.install).not.toHaveBeenCalled()
    expect(state.launch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Install a current version for Podium' }))
    await screen.findByRole('button', { name: 'Choose credential and start' })
    expect(state.install).toHaveBeenCalledWith({
      machineId: asMachineId('test-machine'),
      harness: 'codex',
      action: 'install',
    })
    expect(state.launch).not.toHaveBeenCalled()
    expect(screen.queryByText('Its own login')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Project key/ }))
    expect(state.launch).toHaveBeenCalledWith({
      target: { path: '/project', repoPath: '/project', machineId: 'test-machine' },
      agentKind: 'codex',
      credentialId: asCredentialId('cred_00000000-0000-4000-8000-000000000001'),
      issueId: 'issue-1',
      model: 'chosen-model',
      effort: 'high',
      firstPrompt: 'Continue the task',
    })
    expect(state.kill).toHaveBeenCalledWith('failed-session')
    expect(state.navigate).toHaveBeenCalledWith('managed-session')
  })

  it('keeps a refused install visible and does not launch', async () => {
    state.install.mockResolvedValue({ ok: false, error: 'The release could not be verified.' })
    render(<InstallCurrentHarness sessionId={asSessionId('failed-session')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Install a current version for Podium' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('The release could not be verified.'),
    )
    expect(state.launch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Choose credential and start' })).toBeNull()
  })

  it('returns to credential selection when the install already completed', () => {
    state.managed = { active: { version: '0.171.0' } }
    render(<InstallCurrentHarness sessionId={asSessionId('failed-session')} />)
    expect(screen.getByRole('button', { name: 'Choose credential and start' })).toBeTruthy()
    expect(state.install).not.toHaveBeenCalled()
  })
})
