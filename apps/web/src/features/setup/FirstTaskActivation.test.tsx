// @vitest-environment happy-dom
import { asIssueId, asMachineId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FirstTaskActivation } from './FirstTaskActivation'

const create = vi.fn()
const start = vi.fn()
const login = vi.fn()
const navigateToSession = vi.fn()
const uiValues = new Map<string, string>()
const uiSet = vi.fn((key: string, value: string | null) => {
  if (value === null) uiValues.delete(key)
  else uiValues.set(key, value)
})

const machineId = asMachineId('machine-a')
const repo = {
  path: '/work/podium',
  kind: 'repository' as const,
  branch: 'main',
  worktrees: [],
  machineId,
}

let codexLogin: 'in' | 'out' | 'unknown' = 'in'

function store() {
  return {
    repos: [repo],
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
          ],
          tools: [],
        },
      },
    ],
    uiState: {
      get: (key: string) => uiValues.get(key) ?? null,
      set: uiSet,
    },
    navigateToSession,
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
      issues: { create: { mutate: create }, start: { mutate: start } },
    },
  }
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (value: ReturnType<typeof store>) => unknown) => selector(store()),
}))

vi.mock('@/lib/ModelEffortPicker', () => ({
  ModelPicker: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange('gpt-5.6-sol')}>
      Choose model
    </button>
  ),
  EffortPicker: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange('high')}>
      Choose effort
    </button>
  ),
}))

afterEach(() => {
  cleanup()
  uiValues.clear()
  uiSet.mockClear()
  create.mockReset()
  start.mockReset()
  login.mockReset()
  navigateToSession.mockClear()
  codexLogin = 'in'
})

function seedDraft(overrides: Record<string, unknown> = {}): void {
  uiValues.set(
    'podium.firstTaskActivation.draft',
    JSON.stringify({
      repoPath: repo.path,
      agent: 'codex',
      model: 'auto',
      effort: 'auto',
      title: '',
      description: '',
      ...overrides,
    }),
  )
}

describe('FirstTaskActivation', () => {
  it('selects a genuinely ready configured agent before advancing', async () => {
    const onRouteChange = vi.fn()
    render(
      <FirstTaskActivation
        route="agent"
        onRouteChange={onRouteChange}
        onExplore={vi.fn()}
        onComplete={vi.fn()}
      />,
    )

    const codex = await screen.findByRole('button', { name: /Codex Ready on Studio Mac/ })
    await waitFor(() => expect(codex.getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByText(/Claude Code is not installed on Studio Mac/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Continue to first task' }))
    expect(onRouteChange).toHaveBeenCalledWith('first-task')
  })

  it('opens the supported login flow without discarding the saved task draft', async () => {
    codexLogin = 'out'
    seedDraft({ title: 'Keep this task' })
    login.mockResolvedValue({ sessionId: 'login-session' })
    const onExplore = vi.fn()

    render(
      <FirstTaskActivation
        route="agent"
        onRouteChange={vi.fn()}
        onExplore={onExplore}
        onComplete={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Log in to Codex' }))
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({ harness: 'codex', machineId: 'machine-a' }),
    )
    expect(onExplore).toHaveBeenCalledOnce()
    expect(navigateToSession).toHaveBeenCalledWith('login-session')
    expect([...uiValues.values()].some((value) => value.includes('Keep this task'))).toBe(true)
  })

  it('uses the production task mutation and completes only after it starts successfully', async () => {
    seedDraft()
    const issueId = asIssueId('issue-first')
    create.mockResolvedValue({ id: issueId })
    start.mockResolvedValue({ id: issueId })
    const onComplete = vi.fn()

    render(
      <FirstTaskActivation
        route="first-task"
        onRouteChange={vi.fn()}
        onExplore={vi.fn()}
        onComplete={onComplete}
      />,
    )

    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Ship the activation flow' },
    })
    fireEvent.change(screen.getByLabelText('Task context'), {
      target: { value: 'Keep the success boundary explicit.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose effort' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start first task' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        repoPath: '/work/podium',
        title: 'Ship the activation flow',
        description: 'Keep the success boundary explicit.',
        parentBranch: 'main',
        defaultAgent: 'codex',
        defaultModel: 'gpt-5.6-sol',
        defaultEffort: 'high',
        startNow: false,
        mutationId: expect.any(String),
      }),
    )
    expect(start).toHaveBeenCalledWith({ id: issueId, mutationId: expect.any(String) })
    expect(onComplete).toHaveBeenCalledWith(issueId)
    expect(uiSet).toHaveBeenLastCalledWith('podium.firstTaskActivation.draft', null)
  })

  it('keeps the composer and activation incomplete when task start fails', async () => {
    seedDraft({ title: 'Retry me', description: 'This must survive.' })
    const issueId = asIssueId('issue-retry')
    create.mockResolvedValue({ id: issueId })
    start.mockRejectedValueOnce(new Error('agent did not start')).mockResolvedValue({ id: issueId })
    const onComplete = vi.fn()

    render(
      <FirstTaskActivation
        route="first-task"
        onRouteChange={vi.fn()}
        onExplore={vi.fn()}
        onComplete={onComplete}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start first task' }))

    expect((await screen.findByRole('alert')).textContent).toContain('agent did not start')
    expect((screen.getByLabelText('Task title') as HTMLInputElement).value).toBe('Retry me')
    expect(onComplete).not.toHaveBeenCalled()
    expect(uiValues.get('podium.firstTaskActivation.draft')).toContain('This must survive.')

    fireEvent.click(screen.getByRole('button', { name: 'Retry starting task' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(issueId))
    expect(create).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls[1]?.[0]).toEqual(start.mock.calls[0]?.[0])
  })
})
