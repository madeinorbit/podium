import { fullDevice } from '@podium/client-graph/full-device-fixture'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
import { MobxPool } from '@podium/client-graph/pool'
import { act, cleanup, render, screen } from '@testing-library/react'
import { observer } from 'mobx-react-lite'
import { afterEach, expect, it, vi } from 'vitest'
import { worklistRowStatus } from '../lib/work-sections'
import { DeckGauge, DeckVitalsLine, deckVitals } from './MissionGauge'
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
  const pool = fullDevice(new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) }))
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

const Readout = observer(function Readout({ opening }: { opening: MissionScreen }) {
  const vitals = deckVitals(opening.full)
  return (
    <div role="status">
      {vitals ? (
        <>
          <DeckGauge vitals={vitals} />
          <DeckVitalsLine vitals={vitals} />
        </>
      ) : (
        'Loading tasks…'
      )}
    </div>
  )
})
function mount(opening: MissionScreen) {
  return render(<Readout opening={opening} />)
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
  mount(opening)
  const button = screen.getByRole('status')
  expect(button.textContent).toContain('1/4')
  expect(button.textContent).toContain('1 working')
  expect(screen.getByTestId('working-word')).toBeTruthy()
  expect(button.textContent).toContain(`${opening.full.phoneCounts['up-next']} up next`)
  expect(screen.getByTestId('deck-gauge-done').style.flexGrow).toBe('0.25')
  expect(screen.getByTestId('deck-gauge-working').style.flexGrow).toBe('0.25')
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
  expect(screen.queryByTestId('working-word')).toBeNull()
  expect(screen.queryByTestId('deck-gauge-working')).toBeNull()
})

it('draws all four desktop buckets in a straight bar with proportional gaps', () => {
  render(
    <DeckGauge
      vitals={{ done: 1, total: 10, needsYou: 2, working: 2, waiting: 3, todo: 4, upNext: 4 }}
    />,
  )
  const gauge = screen.getByTestId('deck-gauge')
  expect(getComputedStyle(gauge).borderRadius).toBe('0px')
  expect([...gauge.children].map((part) => (part as HTMLElement).style.flexGrow)).toEqual([
    '0.1',
    '0.2',
    '0.3',
    '0.4',
  ])
  expect(
    new Set([...gauge.children].map((part) => (part as HTMLElement).style.backgroundColor)).size,
  ).toBe(4)
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
  expect(screen.getByRole('status').textContent).toContain('0/')
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
  expect(opening.full.phoneCounts['needs-you']).toBe(1)
  expect(screen.getByRole('status').textContent).toContain('1 needs you')
  expect(screen.getByTestId('deck-gauge-working').style.flexGrow).toBe('1')
  expect(screen.queryByTestId('deck-gauge-waiting')).toBeNull()
})
