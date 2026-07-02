import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InputHTMLAttributes } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewIssueDialog } from './NewIssueDialog'
import { makeIssue } from './test-issue'

const create = vi.fn(async () => makeIssue({ id: 'new-issue' }))
const update = vi.fn(async () => ({}))
const linearSearch = vi.fn(async () => [])

vi.mock('./store', () => ({
  useStore: () => ({
    repos: [
      {
        path: '/repo',
        branch: 'main',
        worktrees: [
          { path: '/repo/.worktrees/feature-auth', branch: 'feature-auth' },
          { path: '/repo/.worktrees/bugfix-login', branch: 'bugfix-login' },
        ],
      },
      { path: '/other', branch: 'trunk', worktrees: [] },
      { path: '/repo/.worktrees/side', kind: 'worktree', branch: 'side', worktrees: [] },
    ],
    issues: [],
    trpc: {
      settings: {
        get: {
          query: vi.fn(async () => ({
            sessionDefaults: { agent: 'claude-code' },
            gitWorkflow: { defaultParentBranch: 'main' },
          })),
        },
      },
      issues: {
        create: { mutate: create },
        update: { mutate: update },
        linearSearch: { query: linearSearch },
      },
    },
  }),
}))

type CheckboxMockProps = {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
} & InputHTMLAttributes<HTMLInputElement>

vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange, ...props }: CheckboxMockProps) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.currentTarget.checked)}
      {...props}
    />
  ),
}))

afterEach(() => {
  cleanup()
  create.mockClear()
  update.mockClear()
  linearSearch.mockClear()
})

describe('NewIssueDialog agent start selection', () => {
  it('preselects the default agent and saves a deferred ticket with a selected agent', async () => {
    render(<NewIssueDialog onClose={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Claude Code (default)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code (default)' }))
    expect(screen.queryByRole('menuitem', { name: 'Claude Code' })).toBeNull()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cursor' }))

    const startNow = screen.getByRole('checkbox', { name: 'Start work now' }) as HTMLInputElement
    fireEvent.click(startNow)
    expect(startNow.checked).toBe(false)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Deferred cursor task' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Deferred cursor task',
          defaultAgent: 'cursor',
          startNow: false,
        }),
      ),
    )
  })

  it('lets you pick a model + effort and passes them to create', async () => {
    render(<NewIssueDialog onClose={vi.fn()} />)

    // Default agent is Claude Code → its model list (Opus/Sonnet/Haiku) + full effort ladder.
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Opus' }))

    fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'High' }))

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tune the model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Tune the model',
          defaultModel: 'opus',
          defaultEffort: 'high',
        }),
      ),
    )
  })

  it('resets a chosen model when the agent changes (model is agent-scoped)', async () => {
    render(<NewIssueDialog onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Opus' }))
    // Switch agent → the model pill falls back to Auto (Opus is a Claude alias).
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code (default)' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cursor' }))

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Switched agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ defaultAgent: 'cursor', defaultModel: undefined }),
      ),
    )
  })

  it('splits repo and branch selection into scoped menus with icons', async () => {
    render(<NewIssueDialog onClose={vi.fn()} />)

    const repoButton = screen.getByRole('button', { name: 'repo' })
    expect(repoButton.querySelector('svg')).toBeTruthy()
    fireEvent.click(repoButton)
    expect(await screen.findByRole('menuitem', { name: 'repo' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'other' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'side' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'main (default)' })).toBeNull()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    const branchButton = screen.getByRole('button', { name: 'main (default)' })
    expect(branchButton.querySelector('svg')).toBeTruthy()
    fireEvent.click(branchButton)
    expect(await screen.findByRole('menuitem', { name: 'main (default)' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'feature-auth' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'bugfix-login' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'New' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'repo' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'other' })).toBeNull()
  })
})
