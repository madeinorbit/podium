import { asIssueId, asRepoId, asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { MergeQueuePanelView } from './MergeQueuePanel'
import type { QueueLock, QueuePanelState } from './merge-queue-model'

const scope = { repoId: asRepoId('repo-main'), repoPath: '/repo' }
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
    sessionId: asSessionId('session-holder'),
    issueId: asIssueId('holder'),
    label: 'Merge driver',
    acquiredAt: '2026-08-06T12:00:00.000Z',
    expiresAt: '2026-08-06T12:04:05.000Z',
    secondsLeft: 125,
    note: null,
  },
  queue: [
    {
      sessionId: asSessionId('session-next'),
      issueId: asIssueId('next'),
      label: 'Queued agent',
      position: 1,
      enqueuedAt: '2026-08-06T12:01:00.000Z',
    },
    {
      sessionId: asSessionId('session-unattached'),
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
  it('pins merge alone, ordered active, next, ready', () => {
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
    expect(
      within(merge)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['Merge queue', 'MERGING NOW', 'NEXT UP', 'READY'])
    expect(within(merge).getByText('Waiting 1m 00s')).toBeTruthy()
    expect(within(merge).getByText('Waiting 30s')).toBeTruthy()
    expect(within(merge).getByText('2m 05s left')).toBeTruthy()
    // Nothing else is held, so the heavy lane takes no room at all.
    expect(screen.queryByText('Heavy test queue')).toBeNull()
    expect(within(queueGroup('Live lanes')).getByText('No lane is held right now.')).toBeTruthy()

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

  // POD-1076: the heavy lane is no longer pinned, so it has to arrive the way
  // every other lane does — while held, keeping its own icon and vocabulary.
  it('renders the heavy-test lane dynamically, with its FIFO wait time', () => {
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
                sessionId: asSessionId('test-holder'),
                issueId: null,
                label: 'Browser test lane',
                acquiredAt: '2026-08-06T12:00:00.000Z',
                expiresAt: '2026-08-06T12:12:00.000Z',
                secondsLeft: 600,
                note: null,
              },
              queue: [
                {
                  sessionId: asSessionId('test-next'),
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

    const heavy = queueGroup('TESTING NOW test:heavy')
    expect(within(heavy).getByText('Browser test lane')).toBeTruthy()
    expect(within(heavy).getByText('Integration lane')).toBeTruthy()
    expect(within(heavy).getByText('Waiting 45s')).toBeTruthy()
    expect(within(heavy).getByLabelText('Work in progress').className).toContain('animate-spin')
    // A held lane spends no row saying it is held, and the band drops its
    // teaching copy the moment it has something real to show.
    expect(screen.queryByText('No lane is held right now.')).toBeNull()
    expect(
      screen.getByText(
        'A lane appears while a session holds its lock and leaves when the lease is released.',
      ),
    ).toBeTruthy()
  })

  it('teaches the mechanic, and names what will show, while no lane is held', () => {
    render(
      <MergeQueuePanelView
        state={idle}
        issues={[]}
        scope={scope}
        onRefresh={vi.fn()}
        onSelectIssue={vi.fn()}
      />,
    )

    const band = queueGroup('Live lanes')
    expect(within(band).getByText('none held')).toBeTruthy()
    expect(within(band).getByText('No lane is held right now.')).toBeTruthy()
    expect(within(band).getByText(/Lanes are created on demand/)).toBeTruthy()
    // Examples that teach, never rows: a row would claim a lease nobody holds.
    expect(
      within(band)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['test:heavy', 'validation:watch', 'migrations', 'podium:dev-bundle'])
    expect(within(band).queryByRole('heading', { level: 3 })).toBeNull()
  })

  it('keeps lanes it watched leave as a still, past-tense tail', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T12:02:00.000Z'))
    render(
      <MergeQueuePanelView
        state={idle}
        issues={[]}
        scope={scope}
        released={[
          {
            name: 'podium:dev-bundle',
            kind: 'other',
            releasedAt: Date.parse('2026-08-06T11:56:00.000Z'),
          },
          { name: 'test:heavy', kind: 'heavy', releasedAt: Date.parse('2026-08-06T12:01:40.000Z') },
        ]}
        onRefresh={vi.fn()}
        onSelectIssue={vi.fn()}
      />,
    )

    const tail = screen.getByRole('heading', { name: 'RECENTLY RELEASED' }).closest('section')
    if (!(tail instanceof HTMLElement)) throw new Error('Released tail not found')
    expect(within(tail).getByText('podium:dev-bundle')).toBeTruthy()
    expect(within(tail).getByText('6m ago')).toBeTruthy()
    expect(within(tail).getByText('just now')).toBeTruthy()
    // History is history: nothing in the tail spins or offers a lease clock.
    expect(within(tail).queryByLabelText('Work in progress')).toBeNull()
    expect(within(tail).queryByText(/left$/)).toBeNull()
  })

  // POD-705: the lock namespace is free-form, so a panel that renders a fixed
  // pair of names hides exactly the queue nobody thought to register — here a
  // validation-admission lease with agents stacked behind it.
  it('gives every unregistered lease its own lane, behind the one pinned queue', () => {
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
                sessionId: asSessionId('admission-holder'),
                issueId: asIssueId('admit'),
                label: 'issue:#34',
                acquiredAt: '2026-08-06T12:00:00.000Z',
                expiresAt: '2026-08-06T12:05:00.000Z',
                secondsLeft: 300,
                note: 'focused package tests',
              },
              queue: [
                {
                  sessionId: asSessionId('admission-next'),
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
                sessionId: asSessionId('bundle-holder'),
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

    // The pinned queue, then one band holding every free-form lease.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Merge queue',
      'Live lanes',
    ])
    // Lanes group by kind, then name, so the band does not reshuffle.
    expect(
      within(queueGroup('Live lanes'))
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['HOLDING NOWpodium:dev-bundle', 'HOLDING NOWvalidation:admission', 'NEXT UP'])

    const admission = queueGroup('HOLDING NOW validation:admission')
    // The raw name is what the operator types into `podium lock`, so it stays.
    expect(within(admission).getByTitle('validation:admission')).toBeTruthy()
    expect(within(admission).getByText('Waiting 1m 00s')).toBeTruthy()
    expect(within(admission).getByText('3m 00s left')).toBeTruthy()

    fireEvent.click(within(admission).getByRole('button', { name: /POD-34 Admitted run/ }))
    expect(onSelectIssue).toHaveBeenLastCalledWith(holder)

    // Every held lease is counted, including the ones nobody registered.
    expect(screen.getByText('3 live')).toBeTruthy()
    expect(screen.getByText('2 held')).toBeTruthy()
    // Nobody is queued behind the bundle lease, so it renders no NEXT UP at all.
    const bundle = queueGroup('HOLDING NOW podium:dev-bundle')
    expect(within(bundle).queryByText('NEXT UP')).toBeNull()
    expect(within(bundle).queryByText('No sessions waiting.')).toBeNull()
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
      'Live lanes',
    ])
    // A cold read must not claim the repository is quiet.
    expect(screen.getByText('Reading every lease this repository holds…')).toBeTruthy()
    expect(screen.queryByText('No lane is held right now.')).toBeNull()
    expect(screen.queryByText('none held')).toBeNull()
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
