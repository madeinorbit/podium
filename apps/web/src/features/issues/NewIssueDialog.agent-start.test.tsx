import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InputHTMLAttributes } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { NewIssueDialog } from './NewIssueDialog'

// Typed input so the assertions below can read back the payload create received.
const create = vi.fn(async (_input: Record<string, unknown>) => makeIssue({ id: 'new-issue' }))
const update = vi.fn(async () => ({}))
const { machines } = vi.hoisted(() => ({ machines: [] as Array<Record<string, unknown>> }))

vi.mock('@/app/store', () => {
  const useStore = () => ({
    repos: [
      {
        path: '/repo',
        branch: 'main',
        machineId: 'mine',
        worktrees: [
          { path: '/repo/.worktrees/feature-auth', branch: 'feature-auth' },
          { path: '/repo/.worktrees/bugfix-login', branch: 'bugfix-login' },
        ],
      },
      { path: '/other', branch: 'trunk', worktrees: [] },
      { path: '/repo/.worktrees/side', kind: 'worktree', branch: 'side', worktrees: [] },
    ],
    issues: [],
    machines,
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
      },
    },
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    useReplicaIssues: () => useStore().issues,
  }
})

type CheckboxMockProps = {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
} & InputHTMLAttributes<HTMLInputElement>

vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))
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
  machines.length = 0
})

describe('NewIssueDialog start-work band', () => {
  it('preselects the default agent and sends the one you pick', async () => {
    render(<NewIssueDialog onClose={vi.fn()} />)

    const agentTrigger = screen.getByRole('button', { name: 'Agent' })
    expect(agentTrigger.textContent).toContain('Claude Code')
    expect(agentTrigger.textContent).not.toContain('default')
    fireEvent.click(agentTrigger)
    expect(await screen.findByRole('menuitem', { name: 'Claude Code' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cursor' }))

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Cursor task' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Cursor task',
          defaultAgent: 'cursor',
          startNow: true,
        }),
      ),
    )
  })

  it('greys out harnesses unavailable on every repo host', async () => {
    machines.push({
      id: 'mine',
      name: 'mine',
      hostname: 'mine',
      online: true,
      inventory: {
        agents: [
          { kind: 'claude-code', installed: true, login: { state: 'in' } },
          { kind: 'cursor', installed: false, login: { state: 'unknown' } },
        ],
      },
    })
    render(<NewIssueDialog onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
    const cursor = await screen.findByRole('menuitem', { name: /Cursor/ })
    expect(cursor.textContent).toContain('not installed')
    expect(cursor.getAttribute('data-refused')).toBe('true')
    fireEvent.click(cursor)
    expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('Claude Code')

    const claude = screen.getByRole('menuitem', { name: 'Claude Code' })
    expect(claude.getAttribute('data-refused')).toBeNull()
  })

  it('collapses the band and files a bare ticket when start-now is off', async () => {
    render(<NewIssueDialog onClose={vi.fn()} />)

    // Chosen while the band is open…
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cursor' }))

    const startNow = screen.getByRole('checkbox', { name: 'Start work now' }) as HTMLInputElement
    fireEvent.click(startNow)
    expect(startNow.checked).toBe(false)
    // …and gone with the band, which says so in as many words.
    expect(screen.queryByRole('button', { name: 'Agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Machine' })).toBeNull()
    expect(screen.getByText(/chosen when you start it/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Deferred task' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ title: 'Deferred task', startNow: false }),
    )
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('defaultAgent')
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('machineId')
  })

  it('toggles the band with ⌥S', () => {
    render(<NewIssueDialog onClose={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Agent' })).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText('Title'), { code: 'KeyS', altKey: true })
    expect(screen.queryByRole('button', { name: 'Agent' })).toBeNull()
    fireEvent.keyDown(screen.getByLabelText('Title'), { code: 'KeyS', altKey: true })
    expect(screen.getByRole('button', { name: 'Agent' })).toBeTruthy()
  })

  it('lets you pick a model and passes it to create', async () => {
    // (Effort is per-model and needs the live catalog, so the effort→create wiring is
    // covered in ModelEffortPicker.live.test.tsx; here we cover model selection.)
    render(<NewIssueDialog onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Opus' }))

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tune the model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Tune the model', defaultModel: 'opus' }),
      ),
    )
  })

  it('resets a chosen model when the agent changes (model is agent-scoped)', async () => {
    render(<NewIssueDialog onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Opus' }))
    // Switch agent → the model pill falls back to Auto (Opus is a Claude alias).
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cursor' }))

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Switched agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ defaultAgent: 'cursor' }))
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('defaultModel')
  })

  it('scopes the header to repo and stage — branch, type, labels and assignee are gone', async () => {
    render(<NewIssueDialog onClose={vi.fn()} />)

    const repoButton = screen.getByRole('button', { name: 'repo' })
    expect(repoButton.querySelector('svg')).toBeTruthy()
    fireEvent.click(repoButton)
    expect(await screen.findByRole('menuitem', { name: 'repo' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'other' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'side' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'main (default)' })).toBeNull()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    // The glyph carries its own label, so the stage pill's name doubles it.
    expect(screen.getByRole('button', { name: /Backlog/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'main (default)' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Labels' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Assignee' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'task' })).toBeNull()
  })

  it('keeps pasted URLs as plain description text and has no Linear control', async () => {
    render(<NewIssueDialog onClose={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /Linear/ })).toBeNull()
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'context: https://linear.app/acme/issue/ENG-412/fix-the-login' },
    })

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Context link' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        description: 'context: https://linear.app/acme/issue/ENG-412/fix-the-login',
      }),
    )
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('linear')
  })
})
