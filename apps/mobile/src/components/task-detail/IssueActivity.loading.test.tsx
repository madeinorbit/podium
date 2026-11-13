import type { IssueViewModel } from '@podium/client-core/replica'
import type { IssueEvent } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph/pool'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Text } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import type { MobileTrpc } from '../../client/trpc'

const host = vi.hoisted(() => ({ pool: null as MobxPool | null, api: null as MobileTrpc | null }))
vi.mock('../../client/mobile-pool', () => ({ useMobilePool: () => host.pool }))
vi.mock('../../client/hooks', () => ({ useTrpc: () => host.api }))
vi.mock('../../client/issue-opening', () => ({ useIssueOpening: () => null }))
vi.mock('./IssueNow', () => ({ IssueNow: () => null }))
vi.mock('./IssueProperties', () => ({ IssueProperties: () => null }))
vi.mock('./TaskOverview', () => ({
  GroupHeading: ({ label }: { label: string }) => <Text>{label}</Text>,
}))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))

const { PhoneTimeline } = await import('./IssueModelSections')
afterEach(() => {
  cleanup()
  host.pool?.dispose()
  host.pool = null
  host.api = null
})

const stamp = '2026-11-13T12:00:00.000Z'
const created: IssueEvent = {
  id: 1,
  ts: stamp,
  kind: 'issue.created',
  subject: 'task',
  repoPath: '/repo',
  payload: null,
}

function setup() {
  const pool = new MobxPool({ selectedIssueId: 'task', coarseNow: Date.parse(stamp) })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'task',
        value: {
          id: 'task',
          title: 'Task',
          repoPath: '/repo',
          stage: 'in_progress',
          updatedAt: stamp,
        },
      },
    ],
  })
  host.pool = pool
  let answer!: (rows: IssueEvent[]) => void
  let reject!: (error: Error) => void
  const events = vi.fn(
    () =>
      new Promise<IssueEvent[]>((resolve, fail) => {
        answer = resolve
        reject = fail
      }),
  )
  host.api = {
    issues: {
      events: { query: events },
      comments: { query: async () => [] },
      mailInbox: { mutate: async () => [] },
    },
  } as unknown as MobileTrpc
  render(
    <PhoneTimeline
      issue={pool.issueObject('task') as unknown as IssueViewModel}
      busy={false}
      commands={{} as never}
    />,
  )
  return {
    events,
    answer: (rows: IssueEvent[]) => answer(rows),
    reject: (error: Error) => reject(error),
  }
}

it.each([
  { label: 'empty', rows: [] as IssueEvent[] },
  { label: 'populated', rows: [created] },
])('keeps cold activity pending until its $label answer arrives', async ({ rows }) => {
  const request = setup()
  await waitFor(() => expect(request.events).toHaveBeenCalledOnce())
  expect(screen.getByTestId('issue-activity').getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByText(/Nothing has happened/)).toBeNull()
  await act(async () => request.answer(rows))
  if (rows.length > 0) {
    expect(screen.getByTestId('activity-event')).toBeTruthy()
    expect(screen.queryByText(/Nothing has happened/)).toBeNull()
  } else expect(screen.getByText(/Nothing has happened/)).toBeTruthy()
})

it('shows the shared retry state instead of claiming failed activity is empty', async () => {
  const request = setup()
  await waitFor(() => expect(request.events).toHaveBeenCalledOnce())
  await act(async () => request.reject(new Error('History unavailable')))
  expect(screen.queryByText(/Nothing has happened/)).toBeNull()
  expect(screen.getByText(/Could not load earlier activity: History unavailable/)).toBeTruthy()
})
