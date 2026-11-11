import '@/test-support/mock-core-store-handle'
// @vitest-environment happy-dom
import { asMachineId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstTaskActivation } from './FirstTaskActivation'

const login = vi.fn()
const useOnMyMachines = vi.fn()
/** What `accounts.list` reports: no detected account unless a test says so. */
let accounts: unknown[] = []
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
        serviceAssignment: { server: false, agentExecution: true },
        availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
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
      // The pool fixture attaches a preference source, which subscribes.
      subscribe: () => () => {},
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
      accounts: {
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

// The detected-accounts card reads `accounts.list` into the shared record pool,
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
  uiValues.clear()
  login.mockReset()
  useOnMyMachines.mockReset()
  accounts = []
  codexLogin = 'in'
})

describe('FirstTaskActivation', () => {
  it('shows supported agents as an honest readiness checklist', async () => {
    const onRouteChange = vi.fn()
    render(<FirstTaskActivation route="agent" onRouteChange={onRouteChange} onComplete={vi.fn()} />)

    await screen.findByText('Ready')
    expect(screen.getByText(/Install OpenCode.*opencode auth login/)).toBeTruthy()
    // Cursor states its install step as prose around a copyable command chip,
    // so the sentence is spread across elements; assert on the row that holds it.
    const cursorHint = screen.getByText('Install the CLI, then run').closest('p')
    expect(cursorHint?.textContent).toContain('cursor-agent login')
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
    expect(telemetryState).not.toHaveBeenCalled()
    expect(telemetrySet).not.toHaveBeenCalled()
  })

  // POD-6301 (D11): onboarding shows the box, unticked, for each detected account.
  it('shows an unticked "use on my machines" box for each detected account', async () => {
    accounts = [
      {
        id: 'native:codex',
        provider: 'openai',
        source: 'native',
        harness: 'codex',
        identity: 'alice@example.com',
        identityFingerprint: 'fp-alice',
        status: 'connected',
        useOnMyMachines: false,
        keptOn: [],
      },
      {
        id: 'native:claude-code',
        provider: 'anthropic',
        source: 'native',
        harness: 'claude-code',
        identity: 'alice@work.example',
        identityFingerprint: 'fp-alice-work',
        status: 'connected',
        useOnMyMachines: false,
        keptOn: [],
      },
      // No known identity, and a managed key: neither has the box.
      {
        id: 'native:grok',
        provider: 'xai',
        source: 'native',
        harness: 'grok',
        status: 'connected',
      },
      { id: 'managed:anthropic', provider: 'anthropic', source: 'managed', status: 'connected' },
    ]
    useOnMyMachines.mockResolvedValue({ ok: true, enabled: true })
    render(<FirstTaskActivation route="agent" onRouteChange={vi.fn()} onComplete={vi.fn()} />)

    const section = await screen.findByRole('region', { name: 'Detected accounts' })
    const boxes = await within(section).findAllByRole('checkbox', {
      name: /Use on all my machines/,
    })
    expect(boxes).toHaveLength(2)
    expect(boxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    expect(within(section).getByText('alice@example.com')).toBeTruthy()

    fireEvent.click(boxes[0] as HTMLElement)
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
