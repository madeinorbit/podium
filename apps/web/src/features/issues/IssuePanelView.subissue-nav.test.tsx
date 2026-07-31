// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePanelView } from './IssuePanelView'

const PARENT = makeIssue({
  id: 'p',
  repoPath: '/r',
  seq: 1,
  title: 'Epic',
  worktreePath: '/r',
  childCount: 1,
  deps: [{ id: 'r', type: 'blocks' }],
  childDoneCount: 0,
})
const CHILD = makeIssue({
  id: 'c',
  repoPath: '/r',
  seq: 2,
  title: 'Live child',
  parentId: 'p',
})
const RELATED = makeIssue({
  id: 'r',
  repoPath: '/r',
  seq: 3,
  title: 'Review dependency',
  stage: 'review',
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
      issues: [PARENT, CHILD, RELATED],
      sessions: [],
      setOpenIssueId,
      setView,
    }) as never
  return {
    useStore: () => state(),
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state()),
    useReplicaIssues: () => (state() as unknown as { issues: never[] }).issues,
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

  it('shows the target status icon in relation rows', () => {
    render(<IssuePanelView cwd="/r" />)
    const relations = screen.getByTestId('dock-relations')

    expect(within(relations).getByRole('img', { name: 'Review' })).toBeTruthy()
    expect(within(relations).getByText('Review dependency')).toBeTruthy()
  })
})
