import { MissionScreen } from '@podium/client-graph/mission-screen'
import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
import { MobxPool } from '@podium/client-graph/pool'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { worklistRowStatus } from '../lib/work-sections'
import { deckVitals, deckVitalsLabel, MissionBar } from './MissionBar'
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

function mount(opening: MissionScreen) {
  const onOpen = vi.fn()
  const view = render(<MissionBar full={opening.full} onOpen={onOpen} />)
  return { ...view, onOpen }
}

it('reads one vitals line from the Full deck and follows working to waiting', () => {
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
  const { onOpen } = mount(opening)
  const button = screen.getByRole('button', { name: /^Open flight deck/ })
  expect(button.getAttribute('aria-label')).toBe(
    `Open flight deck, ${deckVitalsLabel(deckVitals(opening.full)!)}`,
  )
  expect(button.textContent).toContain('1/4')
  expect(button.textContent).toContain('1 working')
  expect(button.textContent).toContain(`${opening.full.counts['up-next']} up next`)
  expect(screen.getByTestId('deck-gauge-done').style.width).toBe('25%')
  expect(screen.getByTestId('deck-gauge-working').style.width).toBe('25%')
  const row = opening.pool.worklistRow('root')
  if (!row) throw new Error('The mission root must have a work row')
  expect(worklistRowStatus(row)).toBe('1/4 subtasks done · 1 working')

  // A filter never moves the bar: it counts the whole mission.
  act(() => opening.full.setFilter('needs-you'))
  expect(button.textContent).toContain('1 working')
  act(() =>
    opening.pool.apply({
      type: 'update',
      rows: [{ kind: 'session', id: 'worker', value: session('worker', 'busy', 'idle') }],
    }),
  )
  expect(button.textContent).not.toContain('working')
  expect(screen.queryByTestId('deck-gauge-working')).toBeNull()
  fireEvent.click(button)
  expect(onOpen).toHaveBeenCalledOnce()
})

it('labels zero parts away', () => {
  expect(
    deckVitalsLabel({ done: 8, total: 14, needsYou: 1, working: 3, waiting: 1, upNext: 2 }),
  ).toBe('8/14 · 1 needs you · 3 working · 2 up next')
  expect(
    deckVitalsLabel({ done: 0, total: 2, needsYou: 0, working: 0, waiting: 0, upNext: 2 }),
  ).toBe('0/2 · 2 up next')
})

it('keeps cold task counts pending', () => {
  const opening = open([issue('root', 'in_progress')])
  vi.spyOn(opening.full, 'ready', 'get').mockReturnValue(false)
  mount(opening)
  expect(screen.getByText('Loading tasks…')).toBeTruthy()
})

it('shows no accepted tasks without a filled gauge', () => {
  mount(
    open([issue('root', 'in_progress'), issue('cancelled', 'done', { closedReason: 'cancelled' })]),
  )
  expect(screen.getByRole('button').textContent).toContain('0/')
  expect(screen.queryByTestId('deck-gauge-done')).toBeNull()
})

it('uses the same bucket reading for the mobile work-row meter', () => {
  render(
    <RowProgressMeter progress={{ total: 4, done: 1, working: 1, waiting: 1, todo: 1 }} working />,
  )
  expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe(
    '1 of 4 tasks done, 1 working, 1 waiting, 1 to do',
  )
})

it('keeps attention counts out of the disjoint execution gauge', () => {
  const opening = open(
    [issue('root', 'in_progress'), issue('busy', 'in_progress')],
    [
      {
        ...session('worker', 'busy', 'working'),
        offer: { message: 'Review this', actions: [{ label: 'Accept', prompt: 'accept' }] },
      },
    ],
  )
  mount(opening)
  expect(opening.full.counts['needs-you']).toBe(1)
  expect(screen.getByRole('button').textContent).toContain('1 needs you')
  expect(screen.getByTestId('deck-gauge-working').style.width).toBe('100%')
  expect(screen.queryByTestId('deck-gauge-waiting')).toBeNull()
})
