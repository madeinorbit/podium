// @vitest-environment happy-dom
import { asMachineId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstTaskActivation } from './FirstTaskActivation'

const login = vi.fn()
const telemetryState = vi.fn()
const telemetrySet = vi.fn()
const uiValues = new Map<string, string>()
let codexLogin: 'in' | 'out' | 'unknown' = 'in'
const machineId = asMachineId('machine-a')

function store() {
  return {
    repos: [
      {
        path: '/work/podium',
        kind: 'repository' as const,
        branch: 'main',
        worktrees: [],
        machineId,
      },
    ],
    machines: [
      {
        id: machineId,
        name: 'Studio Mac',
        hostname: 'studio',
        online: true,
        lastSeenAt: new Date(0).toISOString(),
        inventory: {
          os: 'darwin' as const,
          arch: 'arm64' as const,
          agents: [
            { kind: 'codex' as const, installed: true, login: { state: codexLogin } },
            { kind: 'claude-code' as const, installed: false, login: { state: 'out' as const } },
            { kind: 'opencode' as const, installed: false, login: { state: 'out' as const } },
            { kind: 'cursor' as const, installed: false, login: { state: 'out' as const } },
          ],
          tools: [],
        },
      },
    ],
    uiState: {
      get: (key: string) => uiValues.get(key) ?? null,
      set: (key: string, value: string | null) => {
        if (value === null) uiValues.delete(key)
        else uiValues.set(key, value)
      },
    },
    trpc: {
      settings: {
        get: {
          query: vi.fn(async () => ({
            sessionDefaults: { agent: 'codex' },
            gitWorkflow: { defaultParentBranch: 'main' },
          })),
        },
      },
      accounts: { login: { mutate: login } },
      telemetry: {
        state: { query: telemetryState },
        set: { mutate: telemetrySet },
      },
    },
  }
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (value: ReturnType<typeof store>) => unknown) => selector(store()),
}))

vi.mock('@/app/SetupLoginTerminalDialog', () => ({
  SetupLoginTerminalDialog: ({ sessionId }: { sessionId: string | null }) =>
    sessionId ? (
      <div>
        <h2>Finish agent sign-in</h2>
        <div>Login terminal {sessionId}</div>
      </div>
    ) : null,
}))

beforeEach(() => {
  telemetryState.mockReset()
  telemetryState.mockResolvedValue({
    usage: 'absent',
    crash: 'absent',
    endpoint: 'https://telemetry.podium.dev',
  })
  telemetrySet.mockReset()
  telemetrySet.mockResolvedValue({ usage: 'off', crash: 'off' })
})

afterEach(() => {
  cleanup()
  uiValues.clear()
  login.mockReset()
  codexLogin = 'in'
})

describe('FirstTaskActivation', () => {
  it('shows supported agents as an honest readiness checklist', async () => {
    const onRouteChange = vi.fn()
    render(
      <FirstTaskActivation
        route="agent"
        onRouteChange={onRouteChange}
        onComplete={vi.fn()}
      />,
    )

    await screen.findByText('Ready')
    expect(screen.getByText(/Install OpenCode.*opencode auth login/)).toBeTruthy()
    expect(screen.getByText(/Install the Cursor CLI.*cursor-agent login/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Set up your agents.' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Choose a project/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onRouteChange).toHaveBeenCalledWith('first-task')
  })

  it('keeps setup open and hosts login in a modal terminal', async () => {
    codexLogin = 'out'
    login.mockResolvedValue({ sessionId: 'login-session' })

    render(
      <FirstTaskActivation
        route="agent"
        onRouteChange={vi.fn()}
        onComplete={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({ harness: 'codex', machineId: 'machine-a' }),
    )
    expect(await screen.findByText('Login terminal login-session')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Finish agent sign-in' })).toBeTruthy()
  })

  it('combines the ready handoff with explicit telemetry consent', async () => {
    const onComplete = vi.fn()
    render(
      <FirstTaskActivation
        route="first-task"
        onRouteChange={vi.fn()}
        onComplete={onComplete}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Podium is good to go.' })).toBeTruthy()
    const usage = await screen.findByRole('checkbox', { name: /Send anonymous usage reports/ })
    expect((usage as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))

    await waitFor(() => expect(telemetrySet).toHaveBeenCalledWith({ usage: 'on', crash: 'off' }))
    expect(onComplete).toHaveBeenCalledOnce()
  })
})
