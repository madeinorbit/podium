// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperatorFocusProvider } from '@/app/operator-focus'
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

const CHILD_SESSION = {
  sessionId: 'cs',
  issueId: 'c',
  archived: false,
  status: 'live',
  lastActiveAt: '2026-08-06T00:00:00.000Z',
} as never

const setPane = vi.fn()
const setView = vi.fn()
const markIssueRead = vi.fn()
const markSessionRead = vi.fn()

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: {
        issues: {
          comments: { query: vi.fn(async () => []) },
          events: { query: vi.fn(async () => []) },
        },
      },
      httpOrigin: '',
      openFileInWorktree: vi.fn(),
      uiState: { get: () => null, set: vi.fn() },
      issues: [PARENT, CHILD, RELATED],
      sessions: [CHILD_SESSION],
      setPane,
      setView,
      markIssueRead,
      markSessionRead,
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
  // Subtree rows are cross-column FOCUS, not page navigation: clicking one
  // inspects that task and brings its session forward in the workspace, so the
  // operator never loses the mission they are supervising.
  it('focuses the subissue and its session in the workspace when a row is clicked', () => {
    render(
      <OperatorFocusProvider missionId="p">
        <IssuePanelView cwd="/r" />
      </OperatorFocusProvider>,
    )
    const list = screen.getByTestId('dock-subissues')
    fireEvent.click(within(list).getByText('Live child'))
    expect(markIssueRead).toHaveBeenCalledWith('c')
    expect(setPane).toHaveBeenCalledWith('A', 'cs')
    expect(setView).toHaveBeenCalledWith('workspace')
  })

  it('shows the target status icon in relation rows', () => {
    render(<IssuePanelView cwd="/r" />)
    const relations = screen.getByTestId('dock-relations')

    expect(within(relations).getByRole('img', { name: 'Review' })).toBeTruthy()
    expect(within(relations).getByText('Review dependency')).toBeTruthy()
  })
})
