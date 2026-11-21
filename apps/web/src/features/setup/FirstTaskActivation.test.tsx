import '@/test-support/mock-core-store-handle'
// @vitest-environment happy-dom
import { type AgentInventory, asMachineId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishPoolFixture } from '@/test-support/pool-fixture'
import { FirstTaskActivation } from './FirstTaskActivation'

const harnessAction = vi.fn()
const login = vi.fn()
const useOnMyMachines = vi.fn()
const finishRequest = vi.fn()
/** What `credentials.list` reports: no detected account unless a test says so. */
let accounts: unknown[] = []
const telemetryState = vi.fn()
const telemetrySet = vi.fn()
const uiValues = new Map<string, string>()
let codexInstalled = true
let codexInstall: AgentInventory['install']
let codexInstallable = true
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
        serviceAssignment: { server: false, agentExecution: true },
        availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
        lastSeenAt: new Date(0).toISOString(),
        inventory: {
          os: 'darwin' as const,
          arch: 'arm64' as const,
          agents: [
            {
              kind: 'codex' as const,
              installed: codexInstalled,
              login: { state: codexLogin },
              install: codexInstall,
              management: {
                installable: codexInstallable,
                ...(!codexInstallable ? { reason: 'Not supported on this platform' } : {}),
              },
            },
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
      // The pool fixture attaches a preference source, which subscribes.
      subscribe: () => () => {},
    },
    trpc: {
      harnessInstalls: { action: { mutate: harnessAction } },
      settings: {
        get: {
          query: vi.fn(async () => ({
            sessionDefaults: { agent: 'codex' },
            gitWorkflow: { defaultParentBranch: 'main' },
          })),
        },
      },
      credentials: {
        login: { mutate: login },
        useOnMyMachines: { mutate: useOnMyMachines },
      },
      telemetry: {
        state: { query: telemetryState },
        set: { mutate: telemetrySet },
      },
    },
  }
}

vi.mock('@/app/store', () => ({
  readFixture: (selector: (value: ReturnType<typeof store>) => unknown) => selector(store()),
}))

// The detected-accounts card reads `credentials.list` into the shared record pool,
// which this screen-pool fixture does not host: serve its rows directly.
vi.mock('@/features/settings/record-readers', async (original) => ({
  ...(await original<typeof import('@/features/settings/record-readers')>()),
  useSettingsRecords: () => ({ request: { models: accounts, loading: false }, reload: vi.fn() }),
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
  finishRequest.mockReset()
  finishRequest.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ setupFinished: true }),
  })
  vi.stubGlobal('fetch', finishRequest)
  telemetryState.mockReset()
  telemetryState.mockResolvedValue({
    usage: 'absent',
    crash: 'absent',
    endpoint: 'https://pulse.meetpodium.com/v1/u',
  })
  telemetrySet.mockReset()
  telemetrySet.mockResolvedValue({ usage: 'off', crash: 'off' })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  uiValues.clear()
  login.mockReset()
  useOnMyMachines.mockReset()
  accounts = []
  codexLogin = 'in'
  codexInstalled = true
  codexInstall = undefined
  codexInstallable = true
  harnessAction.mockReset()
})

describe('FirstTaskActivation', () => {
  it('installs the first harness and unlocks Continue only after inventory reports it', async () => {
    codexInstalled = false
    codexLogin = 'out'
    let finishInstall!: (value: unknown) => void
    harnessAction.mockReturnValue(
      new Promise((resolve) => {
        finishInstall = resolve
      }),
    )
    const onRouteChange = vi.fn()
    render(<FirstTaskActivation route="agent" onRouteChange={onRouteChange} onComplete={vi.fn()} />)

    expect(screen.getAllByRole('button', { name: 'Install', exact: true })).toHaveLength(6)
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true)
    const codex = screen.getByRole('group', { name: 'Codex actions' })
    fireEvent.click(within(codex).getByRole('button', { name: 'Install', exact: true }))
    expect(harnessAction).toHaveBeenCalledWith({ machineId, harness: 'codex', action: 'install' })
    expect(await screen.findByText('Waiting for the machine…')).toBeTruthy()
    expect(
      within(codex).getByRole('button', { name: 'Install', exact: true }).hasAttribute('disabled'),
    ).toBe(true)
    await act(async () => {
      finishInstall({ ok: true, outcome: 'confirmed' })
    })
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true)

    codexInstall = { managed: { paused: false, installing: { version: '0.171.0' } } }
    act(() => publishPoolFixture())
    expect(await screen.findByText('Installing 0.171.0…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true)

    codexInstalled = true
    codexInstall = {
      managed: {
        paused: false,
        active: { path: '/state/harnesses/codex/1/tool', version: '0.171.0', release: 1 },
      },
    }
    act(() => publishPoolFixture())
    expect(await screen.findByText('0.171.0 · managed by Podium')).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onRouteChange).toHaveBeenCalledWith('first-task')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('shows an install failure and lets the person retry without leaving setup', async () => {
    codexInstalled = false
    harnessAction
      .mockRejectedValueOnce(new Error('Download failed'))
      .mockResolvedValueOnce({ ok: true, outcome: 'confirmed' })
    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)
    const codex = screen.getByRole('group', { name: 'Codex actions' })
    fireEvent.click(within(codex).getByRole('button', { name: 'Install', exact: true }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Download failed')
    fireEvent.click(within(codex).getByRole('button', { name: 'Install', exact: true }))
    await waitFor(() => expect(harnessAction).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true)
  })

  it('shows why a managed install is unavailable', () => {
    codexInstalled = false
    codexInstallable = false
    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)
    const codex = screen.getByRole('group', { name: 'Codex actions' })
    expect(
      within(codex).getByRole('button', { name: 'Install', exact: true }).hasAttribute('disabled'),
    ).toBe(true)
    expect(screen.getByText('Not supported on this platform')).toBeTruthy()
  })

  it('shows supported agents as an honest readiness checklist', async () => {
    const onRouteChange = vi.fn()
    render(<FirstTaskActivation route="agent" onRouteChange={onRouteChange} onComplete={vi.fn()} />)

    await screen.findByText('Ready')
    expect(screen.getAllByRole('button', { name: 'Install', exact: true })).toHaveLength(5)
    expect(screen.getByRole('group', { name: 'OpenCode actions' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Set up your agents.' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Choose a project/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onRouteChange).toHaveBeenCalledWith('first-task')
  })

  it('keeps setup open and hosts login in a modal terminal', async () => {
    codexLogin = 'out'
    login.mockResolvedValue({ sessionId: 'login-session' })

    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({ harness: 'codex', machineId: 'machine-a' }),
    )
    expect(await screen.findByText('Login terminal login-session')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Finish agent sign-in' })).toBeTruthy()
  })

  it('steps from the agent page to the ready page in the same mounted component', async () => {
    // The wizard keeps one FirstTaskActivation across both routes. A hook below the
    // first-task early return made this step render fewer hooks (React error #300).
    const { rerender } = render(
      <FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />,
    )
    rerender(
      <FirstTaskActivation route="first-task" onRouteChange={vi.fn()} onComplete={vi.fn()} />,
    )
    expect(screen.getByRole('heading', { name: 'Podium is good to go.' })).toBeTruthy()
  })

  it('finishes without a telemetry question — it is a setting, not a setup step (POD-5922)', async () => {
    const onComplete = vi.fn()
    render(
      <FirstTaskActivation route="first-task" onRouteChange={vi.fn()} onComplete={onComplete} />,
    )

    expect(screen.getByRole('heading', { name: 'Podium is good to go.' })).toBeTruthy()
    expect(screen.queryByText(/telemetry|usage reports|crash reports/i)).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
    expect(finishRequest).toHaveBeenCalledWith(
      expect.stringContaining('/auth/admin/setup/finish'),
      expect.objectContaining({ method: 'POST' }),
    )
    expect(telemetryState).not.toHaveBeenCalled()
    expect(telemetrySet).not.toHaveBeenCalled()
  })

  it('keeps setup open until completion is saved and lets a failed save retry', async () => {
    const onComplete = vi.fn()
    let release!: (value: unknown) => void
    finishRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    render(
      <FirstTaskActivation route="first-task" onRouteChange={vi.fn()} onComplete={onComplete} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    expect(onComplete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Finishing setup…' }).hasAttribute('disabled')).toBe(
      true,
    )
    release({ ok: false, status: 503, json: async () => ({ error: 'Could not save setup' }) })
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save setup')
    expect(onComplete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
    expect(finishRequest).toHaveBeenCalledTimes(2)
  })

  // POD-6301 (D11): onboarding shows the box, unticked, for each detected account.
  it('shows an unticked "use on my machines" box for each detected account', async () => {
    accounts = [
      ...['codex', 'claude-code'].map((harness, index) => ({
        id: `cred_found-${harness}`,
        label: harness,
        access: 'owner',
        identity: {
          email: index ? 'alice@work.example' : 'alice@example.com',
          fingerprint: index ? 'fp-alice-work' : 'fp-alice',
        },
        nativeLogin: { harness, useOnMyMachines: false, keptOn: [] },
      })),
      { id: 'cred_key', label: 'API key', access: 'owner' },
    ]
    useOnMyMachines.mockResolvedValue({ ok: true, enabled: true })
    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)

    const section = await screen.findByRole('region', { name: 'Detected accounts' })
    const boxes = await within(section).findAllByRole('switch', {
      name: /Use on all my machines/,
    })
    expect(boxes).toHaveLength(2)
    expect(boxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    expect(within(section).getByText('alice@example.com')).toBeTruthy()

    await userEvent.click(within(section).getAllByText('Use on all my machines')[0]!)
    await waitFor(() =>
      expect(useOnMyMachines).toHaveBeenCalledWith({
        harness: 'codex',
        fingerprint: 'fp-alice',
        enabled: true,
      }),
    )
  })

  it('shows no account section when nothing was detected', async () => {
    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)
    await screen.findByText('Ready')
    expect(screen.queryByRole('region', { name: 'Detected accounts' })).toBeNull()
  })
})
