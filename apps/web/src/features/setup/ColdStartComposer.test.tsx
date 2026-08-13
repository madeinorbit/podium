// @vitest-environment happy-dom
import { asIssueId, asMachineId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColdStartComposer } from './ColdStartComposer'

const create = vi.fn()
const start = vi.fn()
const setSelectedIssueId = vi.fn()
const uiValues = new Map<string, string>()
const machineId = asMachineId('machine-a')

const store = {
  repos: [
    { path: '/work/podium', kind: 'repository' as const, branch: 'main', worktrees: [], machineId },
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
        agents: [{ kind: 'codex' as const, installed: true, login: { state: 'in' as const } }],
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
  setSelectedIssueId,
  trpc: {
    settings: {
      get: {
        query: vi.fn(async () => ({
          sessionDefaults: { agent: 'codex' },
          gitWorkflow: { defaultParentBranch: 'main' },
        })),
      },
    },
    issues: { create: { mutate: create }, start: { mutate: start } },
  },
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (value: typeof store) => unknown) => selector(store),
}))

vi.mock('@/lib/ModelEffortPicker', () => ({
  ModelPicker: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange('gpt-5.6-sol')}>
      Model
    </button>
  ),
  EffortPicker: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange('high')}>
      Effort
    </button>
  ),
}))

afterEach(() => {
  cleanup()
  uiValues.clear()
  create.mockReset()
  start.mockReset()
  setSelectedIssueId.mockClear()
})

describe('ColdStartComposer', () => {
  it('uses the reusable first-run wording and production task path', async () => {
    const issueId = asIssueId('issue-first')
    create.mockResolvedValue({ id: issueId })
    start.mockResolvedValue({ id: issueId })
    render(<ColdStartComposer first />)

    expect(screen.getByRole('heading', { name: 'Start your first thing in' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
      target: { value: 'Ship the new onboarding\nKeep the empty state subtle.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        repoPath: '/work/podium',
        machineId: 'machine-a',
        title: 'Ship the new onboarding',
        description: 'Ship the new onboarding\nKeep the empty state subtle.',
        parentBranch: 'main',
        defaultAgent: 'codex',
        defaultModel: 'gpt-5.6-sol',
        defaultEffort: 'high',
        startNow: false,
        mutationId: expect.any(String),
      }),
    )
    expect(start).toHaveBeenCalledWith({ id: issueId, mutationId: expect.any(String) })
    expect(setSelectedIssueId).toHaveBeenCalledWith(issueId)
  })

  it('switches to reusable workspace wording when tasks already exist', () => {
    render(<ColdStartComposer first={false} />)
    expect(screen.getByRole('heading', { name: 'What do you want to work on in' })).toBeTruthy()
  })
})
