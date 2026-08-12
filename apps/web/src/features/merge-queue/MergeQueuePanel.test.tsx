import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { MergeQueuePanelView } from './MergeQueuePanel'
import type { QueueLock, QueuePanelState } from './merge-queue-model'

const scope = { repoId: 'repo-main', repoPath: '/repo' }
const idle: QueuePanelState = { status: 'ready', locks: [] }
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

const mergeLock: QueueLock = {
  name: 'merge:main',
  holder: {
    sessionId: 'session-holder',
    issueId: 'holder',
    label: 'Merge driver',
    acquiredAt: '2026-08-06T12:00:00.000Z',
    expiresAt: '2026-08-06T12:04:05.000Z',
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
}

const populated: QueuePanelState = { status: 'ready', locks: [mergeLock] }

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function queueGroup(name: string): HTMLElement {
  const group = screen.getByRole('heading', { name }).closest('section')
  if (!(group instanceof HTMLElement)) throw new Error(`Queue group not found: ${name}`)
  return group
}

describe('MergeQueuePanelView', () => {
  it('keeps merge and heavy-test queues separate and orders each active, next, ready', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T12:02:00.000Z'))
    const onSelectIssue = vi.fn()
    const issues = [
      ready({
        id: 'later',
        seq: 12,
        displayRef: 'POD-12',
        title: 'Later candidate',
        sortKey: 'r',
      }),
      ready({
        id: 'first',
        seq: 11,
        displayRef: 'POD-11',
        title: 'First candidate',
        sortKey: 'c',
      }),
      ready({
        id: 'holder',
        seq: 13,
        displayRef: 'POD-13',
        title: 'Lease holder',
      }),
      ready({
        id: 'next',
        seq: 14,
        displayRef: 'POD-14',
        title: 'First waiter',
      }),
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

    const merge = queueGroup('Merge queue')
    const heavy = queueGroup('Heavy test queue')
    expect(
      within(merge)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['Merge queue', 'MERGING NOW', 'NEXT UP', 'READY'])
    expect(
      within(heavy)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['Heavy test queue', 'TESTING NOW', 'NEXT UP', 'READY'])
    expect(within(merge).getByText('Waiting 1m 00s')).toBeTruthy()
    expect(within(merge).getByText('Waiting 30s')).toBeTruthy()
    expect(within(merge).getByText('2m 05s left')).toBeTruthy()
    expect(within(heavy).getByText('Ready for the next heavy test run.')).toBeTruthy()

    const first = within(merge).getByRole('button', {
      name: /POD-11 First candidate/,
    })
    const later = within(merge).getByRole('button', {
      name: /POD-12 Later candidate/,
    })
    expect(first.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(within(merge).getByRole('button', { name: /POD-13 Lease holder/ }))
    expect(onSelectIssue).toHaveBeenLastCalledWith(issues[2])
  })

  it('renders heavy-test activity and FIFO wait time from its own lock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T12:02:00.000Z'))
    render(
      <MergeQueuePanelView
        state={{
          status: 'ready',
          locks: [
            {
              name: 'test:heavy',
              holder: {
                sessionId: 'test-holder',
                issueId: null,
                label: 'Browser test lane',
                acquiredAt: '2026-08-06T12:00:00.000Z',
                expiresAt: '2026-08-06T12:12:00.000Z',
                secondsLeft: 600,
                note: null,
              },
              queue: [
                {
                  sessionId: 'test-next',
                  issueId: null,
                  label: 'Integration lane',
                  position: 1,
                  enqueuedAt: '2026-08-06T12:01:15.000Z',
                },
              ],
            },
          ],
        }}
        issues={[]}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={vi.fn()}
      />,
    )

    const heavy = queueGroup('Heavy test queue')
    expect(within(heavy).getByText('Browser test lane')).toBeTruthy()
    expect(within(heavy).getByText('Integration lane')).toBeTruthy()
    expect(within(heavy).getByText('Waiting 45s')).toBeTruthy()
    expect(
      within(heavy).getByText('New runs join this queue when they request the heavy-test lease.'),
    ).toBeTruthy()
    expect(within(heavy).getByLabelText('Work in progress').className).toContain('animate-spin')
  })

  // POD-705: the lock namespace is free-form, so a panel that renders a fixed
  // pair of names hides exactly the queue nobody thought to register — here a
  // validation-admission lease with agents stacked behind it.
  it('gives every unregistered lease its own queue, behind the two pinned lanes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T12:02:00.000Z'))
    const onSelectIssue = vi.fn()
    const holder = ready({ id: 'admit', seq: 34, displayRef: 'POD-34', title: 'Admitted run' })
    render(
      <MergeQueuePanelView
        state={{
          status: 'ready',
          locks: [
            {
              name: 'validation:admission',
              holder: {
                sessionId: 'admission-holder',
                issueId: 'admit',
                label: 'issue:#34',
                acquiredAt: '2026-08-06T12:00:00.000Z',
                expiresAt: '2026-08-06T12:05:00.000Z',
                secondsLeft: 300,
                note: 'focused package tests',
              },
              queue: [
                {
                  sessionId: 'admission-next',
                  issueId: null,
                  label: 'issue:#78',
                  position: 1,
                  enqueuedAt: '2026-08-06T12:01:00.000Z',
                },
              ],
            },
            {
              name: 'podium:dev-bundle',
              holder: {
                sessionId: 'bundle-holder',
                issueId: null,
                label: 'operator',
                acquiredAt: '2026-08-06T12:00:00.000Z',
                expiresAt: '2026-08-06T12:15:00.000Z',
                secondsLeft: 780,
                note: null,
              },
              queue: [],
            },
            mergeLock,
          ],
        }}
        issues={[holder]}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={onSelectIssue}
      />,
    )

    // Pinned lanes first, then the free-form leases in name order.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Merge queue',
      'Heavy test queue',
      'Podium dev bundle',
      'Validation admission',
    ])

    const admission = queueGroup('Validation admission')
    // The raw name is what the operator types into `podium lock`, so it stays.
    expect(within(admission).getByTitle('validation:admission')).toBeTruthy()
    expect(
      within(admission)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
      // A free-form lease has no notion of what is READY to request it.
    ).toEqual(['Validation admission', 'HOLDING NOW', 'NEXT UP'])
    expect(within(admission).getByText('Waiting 1m 00s')).toBeTruthy()
    expect(within(admission).getByText('3m 00s left')).toBeTruthy()

    fireEvent.click(within(admission).getByRole('button', { name: /POD-34 Admitted run/ }))
    expect(onSelectIssue).toHaveBeenLastCalledWith(holder)

    // Every held lease is counted, including the ones nobody registered.
    expect(screen.getByText('3 held')).toBeTruthy()
    expect(within(queueGroup('Podium dev bundle')).getByText('No sessions waiting.')).toBeTruthy()
  })

  it('renders accessible loading geometry in the requested order', () => {
    const { container } = render(
      <MergeQueuePanelView
        state={{ status: 'loading' }}
        issues={[]}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={vi.fn()}
      />,
    )

    expect(screen.getAllByText('Loading queue…')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(2)
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Merge queue',
      'MERGING NOW',
      'NEXT UP',
      'READY',
      'Heavy test queue',
      'TESTING NOW',
      'NEXT UP',
      'READY',
    ])
  })

  it('offers a retry when the one repository reading fails', () => {
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
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('keeps the last good reading on screen when a refresh fails', () => {
    render(
      <MergeQueuePanelView
        state={{ status: 'ready', locks: [mergeLock], warning: 'The daemon did not answer.' }}
        issues={[]}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={vi.fn()}
      />,
    )

    expect(screen.getByRole('status').textContent).toContain(
      'Showing the last queue reading. The daemon did not answer.',
    )
    expect(within(queueGroup('Merge queue')).getByText('Merge driver')).toBeTruthy()
  })

  it('counts active lease and queue wait clocks live', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T12:02:00.000Z'))
    render(
      <MergeQueuePanelView
        state={populated}
        issues={[]}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={vi.fn()}
      />,
    )

    expect(screen.getByText('2m 05s left')).toBeTruthy()
    expect(screen.getByText('Waiting 1m 00s')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('2m 04s left')).toBeTruthy()
    expect(screen.getByText('Waiting 1m 01s')).toBeTruthy()
  })

  it('refreshes the whole repository reading from the shared toolbar', () => {
    const onRefresh = vi.fn()
    render(
      <MergeQueuePanelView
        state={idle}
        issues={[]}
        scope={scope}
        onRefresh={onRefresh}
        onSelectIssue={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh queues' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
