import '@/test-support/mock-core-store-handle'
// POD-3911: exercise the real pool after the provider-free action fixture.
import '@/test-support/mock-pool-fixture'
import '@/test-support/model-catalog-mock'
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DockHeaderSlotProvider } from '@/app/DockHeaderSlot'
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
  deps: [{ id: 'r', type: 'blocked-by' }],
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
  title: 'Child agent',
  agentKind: 'claude-code',
  cwd: '/r',
  archived: false,
  status: 'live',
  lastActiveAt: '2026-08-06T00:00:00.000Z',
} as never

const setPane = vi.fn()
const setView = vi.fn()
const setSelectedIssueId = vi.fn()
const setOpenIssueId = vi.fn()
const markIssueRead = vi.fn()
const markSessionRead = vi.fn()

/**
 * A draft vessel nobody ever filled: the composer minted it so a session had
 * somewhere to live, and the session never started. No worktree, no work — the
 * deck resolves it to "no mission on screen" and renders its empty state, so
 * there is nothing for a jump to arrive at.
 */
const EMPTY_DRAFT = makeIssue({
  id: 'x',
  repoPath: '/r',
  seq: 4,
  title: 'New session',
  draft: true,
  worktreePath: undefined,
})

/** Finished tasks still have a full issue page to inspect. */
const FINISHED = makeIssue({
  id: 'f',
  repoPath: '/r',
  seq: 5,
  title: 'Shipped last week',
  stage: 'done',
  closedReason: 'done',
})

let fixtureIssues = [PARENT, CHILD, RELATED, EMPTY_DRAFT, FINISHED]

// The task head's launch box carries model + effort segments, and those read
// the live catalog through a hook that hangs off the REAL store provider rather
// than the mock below.
vi.mock('@/lib/use-model-catalog', () => ({
  useModelCatalog: () => ({}),
  useModelCatalogState: () => ({ catalog: {}, status: 'unavailable' }),
}))

// A provider retains one API object; history view dependencies do too.
const trpc = {
  issues: {
    comments: { query: vi.fn(async () => []) },
    events: { query: vi.fn(async () => []) },
    mailInbox: { mutate: vi.fn(async () => []) },
  },
}

vi.mock('@/app/store', () => {
  let fixture: unknown
  const state = () => {
    fixture ??= {
      trpc,
      httpOrigin: '',
      openFileInWorktree: vi.fn(),
      uiState: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
      get issues() {
        return fixtureIssues
      },
      sessions: [CHILD_SESSION],
      machines: [],
      repos: [],
      setPane,
      setView,
      setSelectedIssueId,
      setOpenIssueId,
      markIssueRead,
      markSessionRead,
    }
    return fixture as never
  }
  return {
    useStore: () => state(),
    readFixture: (sel: (s: unknown) => unknown) => sel(state()),
  }
})

/** Mounts the panel under a dock title bar, beside the dock's close. */
function inDock(ui: JSX.Element): JSX.Element {
  const host = document.createElement('div')
  host.dataset.dockHost = ''
  document.body.appendChild(host)
  return <DockHeaderSlotProvider value={host}>{ui}</DockHeaderSlotProvider>
}

afterEach(() => {
  cleanup()
  for (const host of document.querySelectorAll('[data-dock-host]')) host.remove()
  vi.clearAllMocks()
  fixtureIssues = [PARENT, CHILD, RELATED, EMPTY_DRAFT, FINISHED]
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
    fireEvent.click(screen.getByTestId('dock-subtasks-toggle'))
    const list = screen.getByTestId('dock-subissues')
    fireEvent.click(within(list).getByText('Live child'))
    expect(markIssueRead).toHaveBeenCalledWith('c')
    expect(setSelectedIssueId).toHaveBeenCalledWith('p')
    expect(setPane).toHaveBeenCalledWith('A', 'cs')
    expect(setView).toHaveBeenCalledWith('workspace')
  })

  // In the dock the same row points the PANEL at the task instead, and leaves
  // the sidebar's selection and the workspace where they are.
  it('shows the task in the panel instead of moving the shell when docked', () => {
    const onNavigate = vi.fn()
    render(
      <OperatorFocusProvider missionId="p">
        <IssuePanelView cwd="/r" onNavigate={onNavigate} />
      </OperatorFocusProvider>,
    )
    fireEvent.click(screen.getByTestId('dock-subtasks-toggle'))
    const list = screen.getByTestId('dock-subissues')
    fireEvent.click(within(list).getByText('Live child'))

    expect(onNavigate).toHaveBeenCalledWith('c')
    expect(setPane).not.toHaveBeenCalled()
    expect(setView).not.toHaveBeenCalled()
  })

  it('opens the full issue page only from the dock', () => {
    const { unmount } = render(<IssuePanelView cwd="/r" />)
    expect(screen.queryByTestId('task-open-fullscreen')).toBeNull()
    unmount()

    render(
      inDock(
        <OperatorFocusProvider missionId="p">
          <IssuePanelView cwd="/r" onNavigate={vi.fn()} />
        </OperatorFocusProvider>,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open full screen' }))
    expect(setOpenIssueId).toHaveBeenCalledWith('p')
    expect(setView).toHaveBeenCalledWith('issues')
  })

  it('opens the displayed child rather than its mission root or session', () => {
    render(
      inDock(
        <OperatorFocusProvider missionId="p">
          <IssuePanelView cwd="/r" issueId={CHILD.id} onNavigate={vi.fn()} />
        </OperatorFocusProvider>,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open full screen' }))

    expect(setOpenIssueId).toHaveBeenCalledWith('c')
    expect(markIssueRead).toHaveBeenCalledWith('c')
    expect(setView).toHaveBeenCalledWith('issues')
    expect(setSelectedIssueId).not.toHaveBeenCalled()
    expect(setPane).not.toHaveBeenCalled()
    expect(markSessionRead).not.toHaveBeenCalled()
  })

  it.each([
    EMPTY_DRAFT,
    FINISHED,
    { ...FINISHED, archived: true },
  ])('opens $title full screen even without a workspace destination (archived=$archived)', (issue) => {
    fixtureIssues = [PARENT, CHILD, RELATED, EMPTY_DRAFT, FINISHED].map((row) =>
      row.id === issue.id ? issue : row,
    )
    render(
      inDock(
        <OperatorFocusProvider missionId="p">
          <IssuePanelView cwd="/r" issueId={issue.id} onNavigate={vi.fn()} />
        </OperatorFocusProvider>,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open full screen' }))
    expect(setOpenIssueId).toHaveBeenCalledWith(issue.id)
    expect(setView).toHaveBeenCalledWith('issues')
  })

  it('shows the target status icon in relation rows', () => {
    render(<IssuePanelView cwd="/r" />)
    const relations = screen.getByTestId('dock-relations')

    expect(within(relations).getByRole('img', { name: 'Review' })).toBeTruthy()
    expect(within(relations).getByText('Review dependency')).toBeTruthy()
  })
})
