// @vitest-environment happy-dom

import type { IssueWire, SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RightDock } from './RightDock'

const selectedIssue = {
  id: 'selected',
  title: 'Selected closed issue',
  repoPath: '/repo',
  worktreePath: null,
  machineId: 'machine-selected',
} as IssueWire
const otherIssue = {
  id: 'other',
  title: 'Other live issue',
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
  setSelectedIssueId: vi.fn(),
}

const mergeLock = vi.hoisted(() => ({
  repoPath: vi.fn(),
  refresh: vi.fn(),
  state: {
    lock: null,
    loading: false,
    refreshing: false,
    error: null,
    refreshedAt: Date.now(),
  } as {
    lock: null | {
      repoId: string
      name: string
      holder: { sessionId: string | null; issueId: string | null; label: string }
      note: string | null
      acquiredAt: string
      expiresAt: string
      secondsLeft: number
      queue: never[]
    }
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
    useMergeLockState: (repoPath: string | null) => {
      mergeLock.repoPath(repoPath)
      return { ...mergeLock.state, refresh: mergeLock.refresh }
    },
  }
})

vi.mock('./store', () => ({
  useStoreSelector: (selector: (store: typeof state) => unknown) => selector(state),
  useReplicaIssues: () => state.issues,
}))

vi.mock('@/features/issues/IssuePanelView', () => ({
  IssuePanelView: (props: { cwd: string; machineId?: string; issueId?: string }) => (
    <div
      data-testid="issue-panel"
      data-cwd={props.cwd}
      data-machine-id={props.machineId}
      data-issue-id={props.issueId}
    />
  ),
}))

afterEach(() => {
  cleanup()
  state.setSelectedIssueId.mockClear()
  mergeLock.repoPath.mockClear()
  mergeLock.refresh.mockClear()
  mergeLock.state = {
    lock: null,
    loading: false,
    refreshing: false,
    error: null,
    refreshedAt: Date.now(),
  }
})

describe('RightDock task selection', () => {
  it('shows the selected issue when it has no active sessions', () => {
    render(<RightDock tab="issue" onClose={vi.fn()} />)

    const panel = screen.getByTestId('issue-panel')
    expect(panel.getAttribute('data-issue-id')).toBe(selectedIssue.id)
    expect(panel.getAttribute('data-cwd')).toBe(selectedIssue.repoPath)
    expect(panel.getAttribute('data-machine-id')).toBe(selectedIssue.machineId)
  })

  it('renders the active repository merge queue from the live lock projection', () => {
    mergeLock.state = {
      lock: {
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
      loading: false,
      refreshing: false,
      error: null,
      refreshedAt: Date.now(),
    }

    render(<RightDock tab="merge-queue" onClose={vi.fn()} />)

    expect(mergeLock.repoPath).toHaveBeenLastCalledWith('/other')
    expect(screen.getByRole('heading', { name: 'MERGING NOW' })).toBeTruthy()
    const holder = screen.getByRole('button', { name: /Other live issue/ })
    expect(holder).toBeTruthy()

    holder.click()
    expect(state.setSelectedIssueId).toHaveBeenCalledWith(otherIssue.id)
  })

  it('maps a first-read failure to the retry interaction', () => {
    mergeLock.state = {
      lock: null,
      loading: false,
      refreshing: false,
      error: 'Lock authority unavailable.',
      refreshedAt: null,
    }

    render(<RightDock tab="merge-queue" onClose={vi.fn()} />)

    expect(screen.getByRole('alert').textContent).toContain('Lock authority unavailable.')
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(mergeLock.refresh).toHaveBeenCalledOnce()
  })
})
