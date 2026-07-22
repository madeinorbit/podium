// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePanelView } from './IssuePanelView'

// Snapshotted artifact ([spec:SP-0fc9]) on an issue whose repoPath exists:
// clicking must open the permanent snapshot as an in-app artifact file tab,
// NOT a live worktree file tab and NOT a new browser window (the source file
// may be deleted, and openFileInWorktree re-homes the dock's Issue panel to
// whatever workspace contains repoPath — #441 regression).
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
const openArtifact = vi.fn()

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: { issues: { comments: { query: vi.fn(async () => []) } } },
      httpOrigin: 'http://h',
      openFileInWorktree,
      openArtifact,
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
  it('opens a snapshotted artifact as an in-app artifact tab, not a worktree tab or window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<IssuePanelView cwd="/r" />)
    fireEvent.click(screen.getByText('Proof'))
    expect(openArtifact).toHaveBeenCalledWith({
      issueId: 'i1',
      artifactId: 'art1',
      path: 'proof.html',
      worktreePath: '/r',
    })
    expect(openFileInWorktree).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('legacy path-only artifacts still open as live worktree files', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<IssuePanelView cwd="/r" />)
    fireEvent.click(screen.getByText('Legacy'))
    expect(openFileInWorktree).toHaveBeenCalledWith({
      machineId: undefined,
      root: '/r',
      path: '/r/legacy.html',
      // owned by the issue so the tab stays in its strip (POD-149)
      issueId: 'i1',
    })
    expect(openArtifact).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})
