import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installed, missing, setupFixture } from '../../harness/agent-setup-fixture'
import { AgentSetupPanel } from './AgentSetupPanel'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: async () => {},
}))
vi.mock('./BottomSheet', () => ({
  BottomSheet: ({
    visible,
    head,
    children,
    footer,
    onClose,
    mode,
  }: {
    visible: boolean
    head: React.ReactNode
    children: React.ReactNode
    footer: React.ReactNode
    onClose: () => void
    mode: string
  }) => (
    <div data-mode={mode}>
      {visible ? (
        <>
          {head}
          {children}
          {footer}
        </>
      ) : (
        <button type="button" onClick={onClose}>
          Finish dismissal
        </button>
      )}
    </div>
  ),
}))
afterEach(cleanup)

function mount(options: Parameters<typeof setupFixture>[0] = {}) {
  const fixture = setupFixture(options)
  const onClose = vi.fn()
  render(<AgentSetupPanel view={fixture.view} onClose={onClose} />)
  return { ...fixture, onClose }
}

describe('phone agent setup', () => {
  it('shows the shared groups, round selections, and one explicit bulk install', () => {
    const { actions } = mount()
    for (const title of [
      'Installing',
      'Ready',
      'Needs sign-in',
      'Not installed',
      'Can’t install here',
    ])
      expect(screen.getByRole('heading', { name: title })).toBeTruthy()
    expect(actions).toEqual([])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install Codex' }))
    expect(
      screen.getByRole('checkbox', { name: 'Install Codex' }).getAttribute('aria-checked'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install Grok' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install 2 agents' }))
    expect(actions.map(({ harness, action }) => [harness, action])).toEqual([
      ['codex', 'install'],
      ['grok', 'install'],
    ])
    expect(screen.getAllByRole('progressbar')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: 'Install 2 agents' })).toBeNull()
  })
  it('renders reported progress without moving backwards, then sends an explicit cancel', () => {
    const { machine, actions } = mount()
    expect(
      screen.getByRole('progressbar', { name: 'Downloading 62%…' }).getAttribute('aria-valuenow'),
    ).toBe('62')
    act(() =>
      machine.patch('opencode', {
        install: {
          managed: {
            paused: false,
            installing: { progress: { phase: 'download', receivedBytes: 10, totalBytes: 100 } },
          },
        },
      }),
    )
    expect(
      screen.getByRole('progressbar', { name: 'Downloading 10%…' }).getAttribute('aria-valuenow'),
    ).toBe('62')
    act(() =>
      machine.patch('opencode', {
        install: { managed: { paused: false, installing: { progress: { phase: 'verify' } } } },
      }),
    )
    expect(
      screen.getByRole('progressbar', { name: 'Checking download…' }).getAttribute('aria-valuenow'),
    ).toBe('62')
    expect(actions).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel install OpenCode' }))
    expect(actions.at(-1)?.action).toBe('cancel-install')
  })
  it('keeps older daemons on an indeterminate bar without offering cancel', () => {
    const fixture = setupFixture()
    runInAction(() => {
      fixture.machine.deliveryCaps = []
    })
    fixture.machine.patch('opencode', { install: { managed: { paused: false, installing: {} } } })
    render(<AgentSetupPanel view={fixture.view} onClose={() => {}} />)
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Cancel install OpenCode' })).toBeNull()
  })
  it('shows checking before inventory and refuses actions offline', () => {
    const { view, machine, actions } = setupFixture()
    runInAction(() => {
      machine.inventory = undefined
    })
    const ui = render(<AgentSetupPanel view={view} onClose={() => {}} />)
    expect(screen.getByText('Checking agents…')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Not installed' })).toBeNull()
    ui.unmount()
    const offline = setupFixture()
    runInAction(() => {
      offline.machine.online = false
    })
    render(<AgentSetupPanel view={offline.view} onClose={() => {}} />)
    expect(
      screen.getByRole('checkbox', { name: 'Install Codex' }).getAttribute('aria-disabled'),
    ).toBe('true')
    expect(actions).toEqual([])
  })
  it('moves failures into Didn’t install and lets the person retry', async () => {
    const { actions } = mount()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install Codex' }))
    await act(async () => actions[0]!.resolve({ ok: false, error: 'No space left' }))
    expect(screen.getByRole('heading', { name: 'Didn’t install' })).toBeTruthy()
    expect(screen.getByText('No space left')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again Codex' }))
    expect(actions.at(-1)?.action).toBe('install')
  })
  it('preserves every detail action and asks before removing a copy or home', async () => {
    const { view, actions } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code, ready' }))
    expect(view.detail?.item.kind).toBe('claude-code')
    expect(
      (screen.getByRole('switch', { name: 'Pause updates' }) as HTMLInputElement).checked,
    ).toBe(false)
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy my settings into Podium’s' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Podium’s copy' }))
    expect(actions).toEqual([])
    expect(view.detail?.confirmingRemove).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(actions).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Podium home…' }))
    await act(async () =>
      actions[0]!.resolve({
        ok: true,
        homeExists: true,
        conversations: [{ id: 'conversation', title: 'Upload fix' }],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete Podium home' }))
    expect(actions).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('Upload fix')
    const confirm = screen.getByRole('heading', { name: 'Confirm removal' }).parentElement!
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete Podium home' }))
    expect(actions.at(-1)?.action).toBe('remove-home')
  })
  it('offers browser, saved credential and later, and hands back the chosen harness', async () => {
    const onStart = vi.fn()
    const { view, logins, machine, saves } = mount({ origin: { kind: 'menu', onStart } })
    fireEvent.click(screen.getByRole('button', { name: 'Pi, needs sign-in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your browser' }))
    await act(async () => logins[0]!.resolve({ sessionId: 'login-session' as never }))
    expect(view.itemFor('pi')?.signIn.loginSessionId).toBe('login-session')
    fireEvent.click(screen.getByRole('button', { name: 'Use a saved credential' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Work key' })))
    expect(saves).toEqual([{ pi: 'saved-key' }])
    // A fixture's preference writer does not publish a feed: demonstrate the
    // machine report and the alternative Later choice independently.
    act(() => machine.patch('pi', installed('pi', 'out')))
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start Pi' }))
    expect(onStart).toHaveBeenCalledWith('pi')
  })
  it('retargets handback after installing an agent and leaves Settings with Done', async () => {
    const onStart = vi.fn()
    const { machine, actions, onClose } = mount({ origin: { kind: 'menu', onStart } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install Codex' }))
    await act(async () => {
      actions[0]!.resolve({ ok: true })
      machine.patch('codex', installed('codex'))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex' }))
    expect(onStart).toHaveBeenCalledWith('codex')
    fireEvent.click(screen.getByRole('button', { name: 'Finish dismissal' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
