import '@/test-support/mock-core-store-handle'
import '@/test-support/mock-pool-fixture'
// @vitest-environment happy-dom
import { type AgentInventory, asMachineId, BUILTIN_HARNESS_KINDS } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
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
let machineOnline = true
let inventoryReady = true
const machineId = asMachineId('machine-a')

// The shared panel owns one view per opening, keyed by the stable request client.
const trpc = {
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
    list: { query: async () => accounts },
    login: { mutate: login },
    useOnMyMachines: { mutate: useOnMyMachines },
  },
  telemetry: {
    state: { query: telemetryState },
    set: { mutate: telemetrySet },
  },
}

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
        online: machineOnline,
        serviceAssignment: { server: false, agentExecution: true },
        availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
        lastSeenAt: new Date(0).toISOString(),
        inventory: inventoryReady
          ? {
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
                ...BUILTIN_HARNESS_KINDS.filter((kind) => kind !== 'codex').map((kind) => ({
                  kind,
                  installed: false,
                  login: { state: 'out' as const },
                  management: { installable: true },
                })),
              ],
              tools: [],
            }
          : undefined,
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
    trpc,
  }
}

vi.mock('@/app/store', () => ({
  readFixture: (selector: (value: ReturnType<typeof store>) => unknown) => selector(store()),
}))

vi.mock('@/app/store-worklist-pool', async () => ({
  ...(await import('@/test-support/pool-fixture')).fixturePoolHooks,
}))

// Supply discovery at the test boundary; the fixture keeps the machine's real model.
vi.mock('@/features/settings/readers', async (original) => {
  const { here } = await import('@podium/client-graph/lookup')
  const { fixturePoolHooks } = await import('@/test-support/pool-fixture')
  return {
    ...(await original<typeof import('@/features/settings/readers')>()),
    useSettingsCatalog: () => {
      const pool = fixturePoolHooks.useWorklistPool()
      const machine = here(pool.model('machine', machineId))
      return { repos: store().repos, machines: machine ? [machine] : [] }
    },
  }
})

// Match the stable descriptor fallback used by the browser harness.
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined }),
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
  machineOnline = true
  inventoryReady = true
  harnessAction.mockReset()
})

describe('FirstTaskActivation', () => {
  it('pre-ticks suggestions without installing, then advances before installs finish', async () => {
    codexInstalled = false
    codexLogin = 'out'
    let finishInstall!: (value: unknown) => void
    harnessAction.mockReturnValue(
      new Promise((resolve) => {
        finishInstall = resolve
      }),
    )
    const onRouteChange = vi.fn()
    const { rerender } = render(
      <StrictMode>
        <FirstTaskActivation route="agent" onRouteChange={onRouteChange} onComplete={vi.fn()} />
      </StrictMode>,
    )

    expect(screen.getByText(/^Podium runs coding agents on/).textContent).toBe(
      'Podium runs coding agents on studio. Pick the ones you want and Podium installs its own copy of each; your own installs stay as they are. Sign in now or later.',
    )
    expect(screen.getByRole('region', { name: 'Not installed' })).toBeTruthy()
    expect(
      (screen.getByRole('checkbox', { name: 'Install Claude Code' }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(
      (screen.getByRole('checkbox', { name: 'Install Codex' }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(
      (screen.getByRole('checkbox', { name: 'Install OpenCode' }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(harnessAction).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Install 3 agents' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Set up agents' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue without installing' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Install 3 and continue' }))
    expect(harnessAction.mock.calls.map(([input]) => input)).toEqual([
      { machineId, harness: 'claude-code', action: 'install' },
      { machineId, harness: 'codex', action: 'install' },
      { machineId, harness: 'opencode', action: 'install' },
    ])
    expect(onRouteChange).toHaveBeenCalledOnce()
    expect(onRouteChange).toHaveBeenCalledWith('first-task')

    // Leaving drops the view's answer; it must not send a cancel to the machine.
    rerender(
      <StrictMode>
        <FirstTaskActivation
          route="first-task"
          onRouteChange={onRouteChange}
          onComplete={vi.fn()}
        />
      </StrictMode>,
    )
    expect(harnessAction).toHaveBeenCalledTimes(3)
    await act(async () => finishInstall({ ok: true, outcome: 'confirmed' }))
    expect(screen.getByRole('heading', { name: 'Podium is good to go.' })).toBeTruthy()
    expect(harnessAction).toHaveBeenCalledTimes(3)
  })

  it('keeps deselected suggestions unticked and blocks Continue with nothing ready', () => {
    codexInstalled = false
    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install Claude Code' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install Codex' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install OpenCode' }))
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    act(() => publishPoolFixture())
    expect(screen.getAllByRole('checkbox').every((box) => !(box as HTMLInputElement).checked)).toBe(
      true,
    )
    expect(harnessAction).not.toHaveBeenCalled()
  })

  it('shows why a managed install is unavailable', () => {
    codexInstalled = false
    codexInstallable = false
    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)
    const blocked = screen.getByRole('region', { name: 'Can’t install here' })
    expect(within(blocked).getByText('Codex')).toBeTruthy()
    expect(within(blocked).getByText('Not supported on this platform')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Install Codex' })).toBeNull()
    expect(harnessAction).not.toHaveBeenCalled()
  })

  it('shows a previous install failure and can continue while its retry runs', () => {
    codexInstalled = false
    codexInstall = {
      managed: {
        paused: false,
        lastError: { at: '2026-11-23T10:00:00Z', message: 'Download failed' },
      },
    }
    harnessAction.mockReturnValue(new Promise(() => {}))
    const onRouteChange = vi.fn()
    render(<FirstTaskActivation route="agent" onRouteChange={onRouteChange} onComplete={vi.fn()} />)
    const failed = screen.getByRole('region', { name: 'Didn’t install' })
    expect(within(failed).getByRole('alert').textContent).toBe('Download failed')
    for (const checkbox of screen.getAllByRole('checkbox')) {
      if ((checkbox as HTMLInputElement).checked) fireEvent.click(checkbox)
    }
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }))
    expect(harnessAction).toHaveBeenCalledWith({ machineId, harness: 'codex', action: 'install' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onRouteChange).toHaveBeenCalledWith('first-task')
  })

  it('shows supported agents as an honest readiness checklist', async () => {
    const onRouteChange = vi.fn()
    render(<FirstTaskActivation route="agent" onRouteChange={onRouteChange} onComplete={vi.fn()} />)

    expect(screen.getByRole('region', { name: 'Ready' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Install OpenCode' })).toBeTruthy()
    expect(screen.getAllByRole('checkbox').every((box) => !(box as HTMLInputElement).checked)).toBe(
      true,
    )
    expect(screen.getByRole('heading', { name: 'Set up your agents.' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Choose a project/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onRouteChange).toHaveBeenCalledWith('first-task')
    expect(harnessAction).not.toHaveBeenCalled()
  })

  it('can skip selected installs when an agent is already ready', () => {
    const onRouteChange = vi.fn()
    render(<FirstTaskActivation route="agent" onRouteChange={onRouteChange} onComplete={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install OpenCode' }))
    expect(screen.getByRole('button', { name: 'Install 1 and continue' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue without installing' }))
    expect(onRouteChange).toHaveBeenCalledWith('first-task')
    expect(harnessAction).not.toHaveBeenCalled()
  })

  it('continues while inventory reports an install already running', () => {
    codexInstalled = false
    codexInstall = { managed: { paused: false, installing: { version: '0.171.0' } } }
    const onRouteChange = vi.fn()
    render(<FirstTaskActivation route="agent" onRouteChange={onRouteChange} onComplete={vi.fn()} />)
    expect(screen.getByRole('region', { name: 'Installing' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onRouteChange).toHaveBeenCalledWith('first-task')
    expect(harnessAction).not.toHaveBeenCalled()
  })

  it('waits for inventory before choosing suggestions', () => {
    codexInstalled = false
    inventoryReady = false
    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain('Checking which agents')
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    inventoryReady = true
    act(() => publishPoolFixture())
    expect(screen.getByRole('button', { name: 'Install 3 and continue' })).toBeTruthy()
    expect(harnessAction).not.toHaveBeenCalled()
  })

  it('cannot continue using an offline machine', () => {
    machineOnline = false
    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('can return to change the project', () => {
    const onRouteChange = vi.fn()
    render(<FirstTaskActivation route="agent" onRouteChange={onRouteChange} onComplete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Change project' }))
    expect(onRouteChange).toHaveBeenCalledWith('local-project')
    expect(harnessAction).not.toHaveBeenCalled()
  })

  it('keeps setup open and hosts login in a modal terminal', async () => {
    codexLogin = 'out'
    login.mockResolvedValue({ sessionId: 'login-session' })

    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('radio', { name: /Sign in with ChatGPT/ }))
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({ harness: 'codex', machineId: 'machine-a' }),
    )
    expect(await screen.findByText('Login terminal login-session')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Finish agent sign-in' })).toBeTruthy()
  })

  it('lets an installed agent sign in later before continuing', () => {
    codexLogin = 'out'
    const onRouteChange = vi.fn()
    render(<FirstTaskActivation route="agent" onRouteChange={onRouteChange} onComplete={vi.fn()} />)
    expect(screen.getByRole('region', { name: 'Needs sign-in' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('radio', { name: /Later/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onRouteChange).toHaveBeenCalledWith('first-task')
    expect(login).not.toHaveBeenCalled()
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
