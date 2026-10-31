// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RightDock } from './RightDock'

const active = { cwd: '/other/wt', machineId: 'other-machine' }
const trpc = {
  issues: {
    resolveShipHold: { mutate: vi.fn() },
    cancelShip: { mutate: vi.fn() },
    deliveryReceipt: { query: vi.fn() },
  },
}
vi.mock('./shell-data', () => ({
  useShellActions: () => ({ trpc }),
  useShellDock: () => ({ active }),
}))

// The task panel owns which task is showing and what its header says; the
// dock's job here is to mount it and give it the header.
vi.mock('./RightDockIssuePanel', () => ({
  default: (props: { kind: 'header' | 'panel'; cwd?: string; machineId?: string }) =>
    props.kind === 'header' ? (
      <span data-testid="dock-issue-header">POD-1</span>
    ) : (
      <div data-testid="dock-issue-panel" data-cwd={props.cwd} data-machine-id={props.machineId} />
    ),
}))

afterEach(() => {
  cleanup()
})

describe('RightDock task panel', () => {
  // The dock does not resolve a task for itself: it hands the panel the
  // active worktree — which is only where a task with no checkout of its own
  // has its artifacts served from — and the panel's pointer decides what shows.
  it('mounts the task panel on the active worktree', async () => {
    render(<RightDock tab="issue" onClose={vi.fn()} />)

    const panel = await screen.findByTestId('dock-issue-panel')
    expect(panel.getAttribute('data-cwd')).toBe(active.cwd)
    expect(panel.getAttribute('data-machine-id')).toBe(active.machineId)
    expect(screen.queryByTestId('dock-title')).toBeNull()
  })

  // The Task tab is the one panel whose header is not a name: it names the
  // task by ref, and the task's own title heads the panel below.
  it('gives the Task tab header to the task panel', async () => {
    render(<RightDock tab="issue" onClose={vi.fn()} />)

    expect(await screen.findByTestId('dock-issue-header')).toBeTruthy()
    expect(screen.queryByText('Selected closed issue')).toBeNull()
  })

  it('leaves every other panel wearing its own label', () => {
    render(<RightDock tab="git" onClose={vi.fn()} />)

    const title = screen.getByText('Git')
    expect(title.dataset.dockTitle).toBe('panel')
    expect(screen.queryByTestId('dock-issue-header')).toBeNull()
  })
})
