import { MissionScreen } from '@podium/client-graph/mission-screen'
import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
import { MobxPool } from '@podium/client-graph/pool'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { worklistRowStatus } from '../lib/work-sections'
import { MissionBar } from './MissionBar'
import { RowProgressMeter } from './WorkRowParts'

vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))
vi.mock('./WorkingMark', () => ({ WorkingMark: () => <span data-testid="working-mark" /> }))

const openings: MissionScreen[] = []
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  for (const opening of openings.splice(0)) {
    opening.close()
    opening.pool.dispose()
  }
})

const stamp = '2026-10-29T12:00:00Z'
const issue = (id: string, stage: string, patch: Record<string, unknown> = {}) => ({
  id,
  stage,
  seq: 1,
  title: id,
  parentId: id === 'root' ? null : 'root',
  repoPath: '/mission',
  deps: [],
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
})
const session = (sessionId: string, issueId: string, phase: string) => ({
  sessionId,
  issueId,
  status: 'live',
  archived: false,
  agentKind: 'codex',
  cwd: '/mission',
  createdAt: stamp,
  lastActiveAt: stamp,
  agentState: { phase },
})

function open(issues: Record<string, unknown>[], sessions: Record<string, unknown>[] = []) {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) })
  attachMissionTestPreferences(pool)
  pool.apply({
    type: 'replace',
    rows: [
      ...issues.map((value) => ({ kind: 'issue' as const, id: value.id as string, value })),
      ...sessions.map((value) => ({
        kind: 'session' as const,
        id: value.sessionId as string,
        value,
      })),
    ],
  })
  const opening = new MissionScreen(pool, 'root', { fullOnly: true })
  openings.push(opening)
  return opening
}

function mount(opening: MissionScreen, attention = 0) {
  const onOpen = vi.fn()
  const view = render(
    <MissionBar full={opening.full} live={0} working={0} attention={attention} onOpen={onOpen} />,
  )
  return { ...view, onOpen }
}

it('shares accepted leaf counts with the deck and updates working tasks to waiting', () => {
  const opening = open(
    [
      issue('root', 'in_progress'),
      issue('done', 'done'),
      issue('busy', 'in_progress'),
      issue('review', 'review'),
      issue('unstarted', 'backlog', { blocked: true }),
      issue('cancelled', 'done', { closedReason: 'cancelled' }),
      issue('proposal', 'proposed'),
    ],
    [session('worker', 'busy', 'working'), session('coordinator', 'root', 'working')],
  )
  const { onOpen } = mount(opening, 1)
  const button = screen.getByRole('button', { name: /^Mission details/ })
  expect(button.textContent).toContain('1 done1 working1 waiting1 to do1 asking')
  expect(button.getAttribute('aria-label')).toBe(
    'Mission details, 1 of 4 tasks done, 1 working, 1 waiting, 1 to do, 1 asking',
  )
  expect(screen.getByTestId('mission-bar-working').style.flexGrow).toBe('1')
  expect(screen.getByTestId('mission-bar-waiting').style.flexGrow).toBe('1')
  expect(screen.getByTestId('working-mark')).toBeTruthy()
  const row = opening.pool.worklistRow('root')
  if (!row) throw new Error('The mission root must have a work row')
  expect(worklistRowStatus(row)).toBe('1/4 subtasks done · 1 working')
  let progress: unknown
  const stop = autorun(() => {
    progress = opening.progress
  })
  expect(progress).toEqual({ total: 4, done: 1, working: 1, waiting: 1, todo: 1 })
  stop()

  act(() => opening.full.setFilter('needs-you'))
  expect(button.textContent).toContain('1 done1 working1 waiting1 to do')
  act(() =>
    opening.pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'session',
          id: 'worker',
          value: session('worker', 'busy', 'idle'),
        },
      ],
    }),
  )
  expect(button.textContent).toContain('1 done2 waiting1 to do')
  expect(button.getAttribute('aria-label')).toContain('0 working, 2 waiting, 1 to do')
  expect(screen.queryByTestId('working-mark')).toBeNull()
  expect(screen.queryByTestId('mission-bar-working')).toBeNull()
  expect(worklistRowStatus(row)).toBe('1/4 subtasks done · 2 waiting')
  fireEvent.click(button)
  expect(onOpen).toHaveBeenCalledOnce()
})

it('shows shipping as working without animating an absent agent', () => {
  mount(open([issue('root', 'shipping')]))
  expect(screen.getByRole('button').textContent).toBe('1 working')
  expect(screen.queryByTestId('working-mark')).toBeNull()
})

it('keeps zero buckets in the accessible reading for a waiting mission', () => {
  mount(open([issue('root', 'review')]))
  expect(screen.getByRole('button').textContent).toBe('1 waiting')
  expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
    'Mission details, 0 of 1 tasks done, 0 working, 1 waiting, 0 to do',
  )
})

it('keeps cold task counts pending', () => {
  const opening = open([issue('root', 'in_progress')])
  vi.spyOn(opening.full, 'ready', 'get').mockReturnValue(false)
  mount(opening)
  expect(screen.getByText('Loading tasks…')).toBeTruthy()
  expect(screen.queryByText('0 tasks')).toBeNull()
})

it('shows no accepted tasks without a filled meter', () => {
  mount(
    open([issue('root', 'in_progress'), issue('cancelled', 'done', { closedReason: 'cancelled' })]),
  )
  expect(screen.getByText('0 tasks')).toBeTruthy()
  expect(screen.queryByTestId('mission-bar-done')).toBeNull()
})

it('uses the same bucket reading for the mobile work-row meter', () => {
  render(
    <RowProgressMeter progress={{ total: 4, done: 1, working: 1, waiting: 1, todo: 1 }} working />,
  )
  expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe(
    '1 of 4 tasks done, 1 working, 1 waiting, 1 to do',
  )
})
