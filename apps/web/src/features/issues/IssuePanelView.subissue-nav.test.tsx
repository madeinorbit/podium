// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssuePanelView } from './IssuePanelView'
import { makeIssue } from '@/lib/test-issue'

const PARENT = makeIssue({
  id: 'p',
  repoPath: '/r',
  seq: 1,
  title: 'Epic',
  worktreePath: '/r',
  childCount: 1,
  childDoneCount: 0,
})
const CHILD = makeIssue({
  id: 'c',
  repoPath: '/r',
  seq: 2,
  title: 'Live child',
  parentId: 'p',
})

const setOpenIssueId = vi.fn()
const setView = vi.fn()

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: { issues: { comments: { query: vi.fn(async () => []) } } },
      httpOrigin: '',
      openFileInWorktree: vi.fn(),
      uiState: { get: () => null, set: vi.fn() },
      issues: [PARENT, CHILD],
      sessions: [],
      setOpenIssueId,
      setView,
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

describe('IssuePanelView subissue rows', () => {
  it('navigates to the subissue page when a row is clicked', () => {
    render(<IssuePanelView cwd="/r" />)
    const list = screen.getByTestId('dock-subissues')
    fireEvent.click(within(list).getByText('Live child'))
    expect(setOpenIssueId).toHaveBeenCalledWith('c')
    expect(setView).toHaveBeenCalledWith('issues')
  })
})
