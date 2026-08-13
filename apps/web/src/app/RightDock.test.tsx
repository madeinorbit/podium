// @vitest-environment happy-dom

import type { IssueWire, SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RightDock } from './RightDock'

const selectedIssue = {
  id: 'selected',
  title: 'Selected closed issue',
  stage: 'review',
  repoPath: '/repo',
  worktreePath: null,
  machineId: 'machine-selected',
} as IssueWire
const otherIssue = {
  id: 'other',
  seq: 22,
  displayRef: 'POD-22',
  title: 'Other live issue',
  repoId: 'repo-other',
  repoPath: '/other',
  worktreePath: '/other/wt',
} as IssueWire
const otherSession = {
  sessionId: asSessionId('other-session'),
  cwd: '/other/wt',
  issueId: otherIssue.id,
  archived: false,
  lastActiveAt: '2026-07-23T12:00:00.000Z',
} as SessionMeta

const state = {
  paneA: otherSession.sessionId,
  fileTabs: [],
  sessions: [otherSession],
  repos: [
    {
      path: '/other',
      kind: 'repository' as const,
      repoId: 'repo-other',
      worktrees: [{ path: '/other/wt', branch: 'issue/other' }],
    },
  ],
  issues: [selectedIssue, otherIssue],
  selectedIssueId: selectedIssue.id,
  shipOrders: [],
  coarseNow: Date.parse('2026-08-13T12:00:00.000Z'),
  setSelectedIssueId: vi.fn(),
}

const repoLocks = vi.hoisted(() => ({
  query: vi.fn(),
  refresh: vi.fn(),
  state: {
    locks: [],
    loading: false,
    refreshing: false,
    error: null,
    refreshedAt: Date.now(),
  } as {
    locks: {
      repoId: string
      name: string
      holder: { sessionId: string | null; issueId: string | null; label: string }
      note: string | null
      acquiredAt: string
      expiresAt: string
      secondsLeft: number
      queue: never[]
    }[]
    loading: boolean
    refreshing: boolean
    error: string | null
    refreshedAt: number | null
  },
}))

vi.mock('@podium/client-core/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/client-core/react')>()
  return {
    ...actual,
    useRepoLocks: (repoPath: string | null) => {
      repoLocks.query(repoPath)
      return { ...repoLocks.state, refresh: repoLocks.refresh }
    },
  }
})

vi.mock('./store', () => ({
  useStoreSelector: (selector: (store: typeof state) => unknown) => selector(state),
  useReplicaIssues: () => state.issues,
}))

// The explorer owns which task is showing and what the trail says (POD-743);
// the dock's job here is to mount it and give it the header.
vi.mock('./RightDockIssuePanel', () => ({
  default: (props: { kind: 'crumbs' | 'explorer'; cwd?: string; machineId?: string }) =>
    props.kind === 'crumbs' ? (
      <nav data-testid="explorer-crumbs">Tasks</nav>
    ) : (
      <div data-testid="issue-explorer" data-cwd={props.cwd} data-machine-id={props.machineId} />
    ),
}))

afterEach(() => {
  cleanup()
  state.setSelectedIssueId.mockClear()
  repoLocks.query.mockClear()
  repoLocks.refresh.mockClear()
  repoLocks.state = {
    locks: [],
    loading: false,
    refreshing: false,
    error: null,
    refreshedAt: Date.now(),
  }
})

describe('RightDock task panel', () => {
  // The dock no longer resolves a task for itself: it hands the explorer the
  // active worktree — which is only where a task with no checkout of its own
  // has its artifacts served from — and the explorer decides what is showing.
  it('mounts the explorer on the active worktree', async () => {
    render(<RightDock tab="issue" onClose={vi.fn()} />)

    const panel = await screen.findByTestId('issue-explorer')
    expect(panel.getAttribute('data-cwd')).toBe(otherSession.cwd)
    expect(screen.queryByTestId('dock-title')).toBeNull()
  })

  // POD-743: the Task tab is the one panel whose header is not a name. What
  // belongs up there is where you are and how to get back; the task's own title
  // is the head of the panel below.
  it('gives the Task tab header to the explorer trail', async () => {
    render(<RightDock tab="issue" onClose={vi.fn()} />)

    expect(await screen.findByTestId('explorer-crumbs')).toBeTruthy()
    expect(screen.queryByText('Selected closed issue')).toBeNull()
  })

  it('leaves every other panel wearing its own label', () => {
    render(<RightDock tab="git" onClose={vi.fn()} />)

    const title = screen.getByText('Git')
    expect(title.dataset.dockTitle).toBe('panel')
    expect(screen.queryByTestId('explorer-crumbs')).toBeNull()
  })

  it('renders the active repository merge queue from the live lock projection', async () => {
    repoLocks.state = {
      locks: [
        {
          repoId: 'repo-other',
          name: 'merge:main',
          holder: {
            sessionId: otherSession.sessionId,
            issueId: otherIssue.id,
            label: 'Other merge driver',
          },
          note: null,
          acquiredAt: '2026-08-06T12:00:00.000Z',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          secondsLeft: 60,
          queue: [],
        },
      ],
      loading: false,
      refreshing: false,
      error: null,
      refreshedAt: Date.now(),
    }

    render(<RightDock tab="merge-queue" onClose={vi.fn()} />)

    // One whole-repo reading, not a request per name the UI happens to know.
    expect(await screen.findByRole('heading', { name: 'MERGING NOW' })).toBeTruthy()
    expect(repoLocks.query).toHaveBeenCalledWith('/other')
    const holder = screen.getByRole('button', { name: /Other live issue/ })
    expect(holder).toBeTruthy()

    holder.click()
    expect(state.setSelectedIssueId).toHaveBeenCalledWith(otherIssue.id)
  })

  it('maps a first-read failure to the retry interaction', async () => {
    repoLocks.state = {
      locks: [],
      loading: false,
      refreshing: false,
      error: 'Lock authority unavailable.',
      refreshedAt: null,
    }

    render(<RightDock tab="merge-queue" onClose={vi.fn()} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Lock authority unavailable.')
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(repoLocks.refresh).toHaveBeenCalledOnce()
  })
})
