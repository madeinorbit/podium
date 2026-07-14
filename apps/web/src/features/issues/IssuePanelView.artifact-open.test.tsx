// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssuePanelView } from './IssuePanelView'
import { makeIssue } from './test-issue'

// Snapshotted artifact ([spec:SP-0fc9]) on an issue whose repoPath exists:
// clicking must open the permanent snapshot, NOT a live worktree file tab
// (the source file may be deleted, and openFileInWorktree re-navigates the
// sidebar to whatever workspace contains repoPath — #441 regression).
const ISSUE = makeIssue({
  id: 'i1',
  repoPath: '/r',
  seq: 1,
  title: 'With artifacts',
  worktreePath: '/r',
  panel: {
    todos: [],
    deferred: [],
    artifacts: [
      { path: 'proof.html', title: 'Proof', addedAt: '2026-07-14', artifactId: 'art1' },
      { path: 'legacy.html', title: 'Legacy', addedAt: '2026-07-14' },
    ],
  },
})

const openFileInWorktree = vi.fn()

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: { issues: { comments: { query: vi.fn(async () => []) } } },
      httpOrigin: 'http://h',
      openFileInWorktree,
      uiState: { get: () => null, set: vi.fn() },
      issues: [ISSUE],
      sessions: [],
      setOpenIssueId: vi.fn(),
      setView: vi.fn(),
    }) as never
  return {
    useStore: () => state(),
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state()),
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('IssuePanelView artifact click', () => {
  it('opens a snapshotted artifact from the permanent store, not a worktree file tab', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<IssuePanelView cwd="/r" />)
    fireEvent.click(screen.getByText('Proof'))
    expect(open).toHaveBeenCalledWith(
      'http://h/files/artifact/i1/art1/proof.html',
      '_blank',
      'noopener',
    )
    expect(openFileInWorktree).not.toHaveBeenCalled()
  })

  it('legacy path-only artifacts still open as live worktree files', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<IssuePanelView cwd="/r" />)
    fireEvent.click(screen.getByText('Legacy'))
    expect(openFileInWorktree).toHaveBeenCalledWith({
      machineId: undefined,
      root: '/r',
      path: '/r/legacy.html',
    })
    expect(open).not.toHaveBeenCalled()
  })
})
