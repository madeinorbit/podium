import type { CredentialView } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialView } from '@/test-support/credential-view'
import { CredentialRow } from './credential-row'
import type { CredentialDeps } from './credentials-deps'

const fixture = vi.hoisted(() => ({ present: true, navigate: vi.fn() }))
vi.mock('@/features/settings/stable-access', () => ({
  useSettingsClient: () => ({ navigateToSession: fixture.navigate }),
}))
vi.mock('@/features/settings/readers', () => ({
  useSettingsSessionPresent: () => fixture.present,
}))

function setup(over: Partial<CredentialView> = {}) {
  const view = credentialView({
    label: 'Found Codex', type: 'openai.chatgpt-login', access: 'owner',
    identity: { email: 'person@example.test', fingerprint: 'fp-codex' },
    nativeLogin: {
      harness: 'codex', required: true, useOnMyMachines: false,
      machines: [{ id: 'desk', name: 'Desk', state: 'out' }, { id: 'laptop', name: 'Laptop', state: 'out' }],
      keptOn: [{ id: 'occupied', name: 'Occupied' }],
    } as CredentialView['nativeLogin'],
    ...over,
  })
  const login = vi.fn(async () => ({ sessionId: 'login-session' }))
  const choose = vi.fn(async (_input: { enabled: boolean }) => ({ ok: true }))
  const reload = vi.fn()
  const deps = {
    commands: { login: { mutate: login }, useOnMyMachines: { mutate: choose } },
    reload, now: () => 0, nameOf: () => 'Owner', machineName: (id: string) => id,
  } as unknown as CredentialDeps
  const onOpen = vi.fn()
  const row = (v = view) => <CredentialRow view={v} deps={deps} onOpen={onOpen} />
  return { view, login, choose, reload, onOpen, row }
}
afterEach(() => { cleanup(); vi.clearAllMocks(); fixture.present = true })

describe('found-login row actions', () => {
  it('keeps identity and preserved-copy feedback beside the switch and persists its choice', async () => {
    const f = setup()
    const page = render(f.row())
    expect(screen.getByText('person@example.test')).toBeTruthy()
    expect(screen.getByText(/Not copied to Occupied/)).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: /Use on all my machines.*person@example.test/ })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(f.choose).toHaveBeenCalledWith({ harness: 'codex', fingerprint: 'fp-codex', enabled: true }))
    await waitFor(() => expect(f.reload).toHaveBeenCalled())
    page.rerender(f.row({ ...f.view, nativeLogin: { ...f.view.nativeLogin!, useOnMyMachines: true } }))
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(f.onOpen).not.toHaveBeenCalled()
    // A later authoritative update follows the same row rather than a sticky optimistic value.
    page.rerender(f.row())
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
  it('starts the selected machine login and waits for the session to arrive before navigating', async () => {
    fixture.present = false
    const f = setup()
    const page = render(f.row())
    fireEvent.change(screen.getByLabelText('Found Codex login machine'), { target: { value: 'laptop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await waitFor(() => expect(f.login).toHaveBeenCalledWith({ harness: 'codex', machineId: 'laptop' }))
    expect(fixture.navigate).not.toHaveBeenCalled()
    fixture.present = true
    page.rerender(f.row())
    await waitFor(() => expect(fixture.navigate).toHaveBeenCalledWith('login-session'))
    expect(f.onOpen).not.toHaveBeenCalled()
  })
  it('refreshes and reports a refused copy without opening the credential', async () => {
    const f = setup()
    f.choose.mockRejectedValue(new Error('Copy refused'))
    render(f.row())
    fireEvent.click(screen.getByRole('switch'))
    expect((await screen.findByRole('alert')).textContent).toBe('Copy refused')
    expect(f.reload).toHaveBeenCalled()
    expect(f.onOpen).not.toHaveBeenCalled()
  })
  it('does not show personal machine actions for shared credentials', () => {
    const f = setup({ access: 'manage' })
    render(f.row())
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull()
  })
  it('shows running and failed attempts on the row and reuses the open login', async () => {
    const f = setup()
    const attempt = { sessionId: 'login-session', machineId: 'desk', machineName: 'Desk', status: 'running' } as const
    const page = render(f.row({ ...f.view, nativeLogin: { ...f.view.nativeLogin!, attempt: attempt as never } }))
    expect(screen.getByRole('status').textContent).toBe('Login open on Desk')
    fireEvent.click(screen.getByRole('button', { name: 'Open sign-in' }))
    await waitFor(() => expect(fixture.navigate).toHaveBeenCalledWith('login-session'))
    page.rerender(f.row({ ...f.view, nativeLogin: { ...f.view.nativeLogin!, attempt: { ...attempt, status: 'failed', error: 'Login failed on Desk' } as never } }))
    expect(screen.getByRole('status').textContent).toBe('Login failed on Desk')
  })
})
