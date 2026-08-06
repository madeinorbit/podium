import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { MergeQueuePanelView } from './MergeQueuePanel'
import type { MergeQueuePanelState } from './merge-queue-model'

const scope = { repoId: 'repo-main', repoPath: '/repo' }
const ready = (over: Parameters<typeof makeIssue>[0]) =>
  makeIssue({
    repoId: 'repo-main',
    repoPath: '/repo',
    stage: 'done',
    branch: 'issue/ready',
    gitState: {
      updatedAt: '2026-08-06T12:00:00.000Z',
      branch: 'issue/ready',
      shared: false,
      merged: false,
      ahead: 2,
      dirtyFiles: 0,
    },
    ...over,
  })

const populated: MergeQueuePanelState = {
  status: 'ready',
  lock: {
    holder: {
      sessionId: 'session-holder',
      issueId: 'holder',
      label: 'Merge driver',
      acquiredAt: '2026-08-06T12:00:00.000Z',
      expiresAt: new Date(Date.now() + 125_000).toISOString(),
      secondsLeft: 125,
      note: null,
    },
    queue: [
      {
        sessionId: 'session-next',
        issueId: 'next',
        label: 'Queued agent',
        position: 1,
        enqueuedAt: '2026-08-06T12:01:00.000Z',
      },
      {
        sessionId: 'session-unattached',
        issueId: null,
        label: 'Release shell',
        position: 2,
        enqueuedAt: '2026-08-06T12:01:30.000Z',
      },
    ],
  },
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MergeQueuePanelView', () => {
  it('separates human-ordered candidates, the active lease, and FIFO waiters', () => {
    const onSelectIssue = vi.fn()
    const issues = [
      ready({ id: 'later', seq: 12, displayRef: 'POD-12', title: 'Later candidate', sortKey: 'r' }),
      ready({ id: 'first', seq: 11, displayRef: 'POD-11', title: 'First candidate', sortKey: 'c' }),
      ready({ id: 'holder', seq: 13, displayRef: 'POD-13', title: 'Lease holder' }),
      ready({ id: 'next', seq: 14, displayRef: 'POD-14', title: 'First waiter' }),
      ready({ id: 'ordinary', seq: 15, title: 'Ordinary ready work', stage: 'planning' }),
      ready({ id: 'other-repo', seq: 16, title: 'Other project', repoId: 'elsewhere' }),
    ]

    render(
      <MergeQueuePanelView
        state={populated}
        issues={issues}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={onSelectIssue}
      />,
    )

    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'READY',
      'MERGING NOW',
      'NEXT',
    ])
    const first = screen.getByRole('button', { name: /POD-11 First candidate/ })
    const later = screen.getByRole('button', { name: /POD-12 Later candidate/ })
    expect(first.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(screen.getByText('Lease holder')).toBeTruthy()
    expect(screen.getByText('2m 05s left')).toBeTruthy()
    expect(screen.getByText('Queue position 1:')).toBeTruthy()
    expect(screen.getByText('First waiter')).toBeTruthy()
    expect(screen.getByText('Release shell')).toBeTruthy()
    expect(screen.getByText('No task attached')).toBeTruthy()
    expect(screen.queryByText('Ordinary ready work')).toBeNull()
    expect(screen.queryByText('Other project')).toBeNull()

    fireEvent.click(first)
    expect(onSelectIssue).toHaveBeenLastCalledWith(issues[1])
    fireEvent.click(screen.getByRole('button', { name: /POD-13 Lease holder/ }))
    expect(onSelectIssue).toHaveBeenLastCalledWith(issues[2])
    fireEvent.click(screen.getByRole('button', { name: /Queue position 1: POD-14 First waiter/ }))
    expect(onSelectIssue).toHaveBeenLastCalledWith(issues[3])
  })

  it('renders static, accessible loading geometry', () => {
    const { container } = render(
      <MergeQueuePanelView
        state={{ status: 'loading' }}
        issues={[]}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={vi.fn()}
      />,
    )

    expect(screen.getByText('Loading merge queue…')).toBeTruthy()
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'READY',
      'MERGING NOW',
      'NEXT',
    ])
    expect(container.innerHTML).not.toMatch(/animate-|amber|yellow|attention/)
  })

  it('offers a retry for an honest error state', () => {
    const onRefresh = vi.fn()
    render(
      <MergeQueuePanelView
        state={{ status: 'error', message: 'The daemon did not answer.' }}
        issues={[]}
        scope={scope}
        onRefresh={onRefresh}
        onSelectIssue={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert').textContent).toContain('The daemon did not answer.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('keeps a last-good reading visible while admitting a failed refresh', () => {
    render(
      <MergeQueuePanelView
        state={{ ...populated, warning: 'The latest refresh failed.' }}
        issues={[ready({ id: 'holder', seq: 13, displayRef: 'POD-13', title: 'Lease holder' })]}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={vi.fn()}
      />,
    )

    expect(screen.getByRole('status').textContent).toContain('The latest refresh failed.')
    expect(screen.getByText('Lease holder')).toBeTruthy()
  })

  it('states each empty fact without implying that data is still loading', () => {
    render(
      <MergeQueuePanelView
        state={{ status: 'ready', lock: null }}
        issues={[]}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={vi.fn()}
      />,
    )

    expect(screen.getByText('No branches ready to merge.')).toBeTruthy()
    expect(screen.getByText('No active merge lease.')).toBeTruthy()
    expect(screen.getByText('No sessions waiting.')).toBeTruthy()
    expect(screen.queryByText(/loading/i)).toBeNull()
  })

  it('counts the active lease down from its expiry instead of freezing a sampled value', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T12:00:00.000Z'))
    const state: MergeQueuePanelState = {
      status: 'ready',
      lock: {
        holder: {
          sessionId: 's',
          issueId: null,
          label: 'Merge worker',
          acquiredAt: '2026-08-06T11:59:00.000Z',
          expiresAt: '2026-08-06T12:01:05.000Z',
          secondsLeft: 999,
          note: null,
        },
        queue: [],
      },
    }
    render(
      <MergeQueuePanelView
        state={state}
        issues={[]}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={vi.fn()}
      />,
    )

    expect(screen.getByText('1m 05s left')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('1m 04s left')).toBeTruthy()
    vi.useRealTimers()
  })

  it('refreshes from the panel header and does not expose internal issue ids', () => {
    const onRefresh = vi.fn()
    const missingIssueState: MergeQueuePanelState = {
      status: 'ready',
      lock: {
        holder: {
          sessionId: 's',
          issueId: 'iss_internal_only',
          label: 'Merge worker',
          acquiredAt: '2026-08-06T12:00:00.000Z',
          expiresAt: '2026-08-06T12:00:30.000Z',
          secondsLeft: 30,
          note: null,
        },
        queue: [],
      },
    }
    const { container } = render(
      <MergeQueuePanelView
        state={missingIssueState}
        issues={[]}
        scope={scope}
        onRefresh={onRefresh}
        onSelectIssue={vi.fn()}
      />,
    )

    expect(screen.getByText('Merge worker')).toBeTruthy()
    expect(screen.getByText('Issue unavailable')).toBeTruthy()
    expect(container.textContent).not.toContain('iss_internal_only')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh merge queue' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
