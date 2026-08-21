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

/** Finished and filed. The deck can still show it; there is simply no work left
 *  to sit down to, which is what "Work on this" offers (POD-1269). */
const FINISHED = makeIssue({
  id: 'f',
  repoPath: '/r',
  seq: 5,
  title: 'Shipped last week',
  stage: 'done',
  closedReason: 'done',
})

// The task head's launch box carries model + effort segments, and those read
// the live catalog through a hook that hangs off the REAL store provider rather
// than the mock below.
vi.mock('@/lib/use-model-catalog', () => ({ useModelCatalog: () => ({}) }))

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
      issues: [PARENT, CHILD, RELATED, EMPTY_DRAFT, FINISHED],
      sessions: [CHILD_SESSION],
      machines: [],
      setPane,
      setView,
      setSelectedIssueId,
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

  // Inside the explorer the same row BROWSES instead: there is a trail there to
  // walk back along, and a relation click that silently re-pointed the
  // workspace would be a navigation the trail cannot show or undo.
  it('pushes a level instead of moving the shell when the explorer owns it', () => {
    const onNavigate = vi.fn()
    render(
      <OperatorFocusProvider missionId="p">
        <IssuePanelView cwd="/r" onNavigate={onNavigate} />
      </OperatorFocusProvider>,
    )
    const list = screen.getByTestId('dock-subissues')
    fireEvent.click(within(list).getByText('Live child'))

    expect(onNavigate).toHaveBeenCalledWith('c')
    expect(setPane).not.toHaveBeenCalled()
    expect(setView).not.toHaveBeenCalled()
  })

  // ...and "Work on this" is the one control that still does move it.
  it('moves the shell from Work on this, and only offers it inside the explorer', () => {
    const { unmount } = render(<IssuePanelView cwd="/r" />)
    expect(screen.queryByTestId('task-work-on-this')).toBeNull()
    unmount()

    render(
      <OperatorFocusProvider missionId="p">
        <IssuePanelView cwd="/r" onNavigate={vi.fn()} />
      </OperatorFocusProvider>,
    )
    fireEvent.click(screen.getByTestId('task-work-on-this'))
    expect(setView).toHaveBeenCalledWith('workspace')
  })

  /**
   * THE HALF THAT WAS MISSING (POD-1151). The sidebar highlights
   * `selectedIssueId`, which is a mission ROOT; focus is the pointer inside it
   * and is discarded when it names a task the selected mission does not hold.
   * Setting focus alone — which is all this used to do — therefore arrived
   * nowhere, and the control read as dead.
   */
  it('selects the top-level ancestor, not the sub-issue, when showing a child in the deck', () => {
    render(
      <OperatorFocusProvider missionId="p">
        <IssuePanelView cwd="/r" issueId={'c' as never} onNavigate={vi.fn()} />
      </OperatorFocusProvider>,
    )
    fireEvent.click(screen.getByTestId('task-work-on-this'))

    // The MISSION is the parent — that is the row the sidebar can highlight —
    // while the pane still opens the child's own session, so the operator lands
    // on the task they asked for rather than on its epic.
    expect(setSelectedIssueId).toHaveBeenCalledWith('p')
    expect(setPane).toHaveBeenCalledWith('A', 'cs')
    expect(setView).toHaveBeenCalledWith('workspace')
  })

  it('offers no jump for a task the deck cannot show', () => {
    render(
      <OperatorFocusProvider missionId="x">
        <IssuePanelView cwd="/r" issueId={'x' as never} onNavigate={vi.fn()} />
      </OperatorFocusProvider>,
    )
    // The mission resolves to nothing, so the deck would answer this jump with
    // its empty state. A link that lands nowhere is worse than no link.
    expect(screen.queryByTestId('task-work-on-this')).toBeNull()
  })

  it('offers no crossing on a task that is no longer workable', () => {
    render(
      <OperatorFocusProvider missionId="f">
        <IssuePanelView cwd="/r" issueId={'f' as never} onNavigate={vi.fn()} />
      </OperatorFocusProvider>,
    )
    // Closed with a reason: the deck could show it, but "Work on this" would be
    // an invitation to work that is over.
    expect(screen.queryByTestId('task-work-on-this')).toBeNull()
  })

  it('shows the target status icon in relation rows', () => {
    render(<IssuePanelView cwd="/r" />)
    const relations = screen.getByTestId('dock-relations')

    expect(within(relations).getByRole('img', { name: 'Review' })).toBeTruthy()
    expect(within(relations).getByText('Review dependency')).toBeTruthy()
  })
})
