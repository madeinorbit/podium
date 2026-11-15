import { DEMO_QUOTA, DEMO_USAGE_BUCKETS } from '@podium/client-core/demo'
import {
  gatingQuotaRows,
  groupQuotaByAccount,
  modelShares,
  usageSummary,
  visibleFleetOperations,
} from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph/pool'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SectionHeader } from '../components/instruments'
import { PulseBody, type PulseBodyProps } from './PulseBody'
import { pulseHero } from './pulse-view'

const dimensions = vi.hoisted(() => ({ fontScale: 1 }))
vi.mock('react-native', async (original) => ({
  ...(await original<object>()),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, ...dimensions }),
}))
afterEach(() => {
  cleanup()
  dimensions.fontScale = 1
})
const now = Date.now()
const summary = usageSummary(DEMO_USAGE_BUCKETS, now)
const props = (over: Partial<PulseBodyProps> = {}): PulseBodyProps => ({
  pool: null,
  range: 'week',
  hero: pulseHero(summary, 'week'),
  summary,
  quota: gatingQuotaRows(groupQuotaByAccount(DEMO_QUOTA), now),
  verdict: null,
  projects: null,
  tasks: [],
  tasksCold: true,
  models: modelShares(summary, 6),
  fleet: visibleFleetOperations({
    machines: [],
    hosts: [],
    capacityReadings: {},
    loadPerCore: null,
    nowMs: now,
  }),
  cold: false,
  failed: false,
  quotaCold: false,
  quotaFailed: false,
  tasksFailed: false,
  onRetry: vi.fn(),
  onOpenTask: vi.fn(),
  buildStamp: 'test build',
  ...over,
})

it('stacks the full section title and note at large sizes and keeps disclosure working', () => {
  dimensions.fontScale = 2.35
  const toggle = vi.fn()
  render(<SectionHeader title="Top projects" trailing="0% attributed" open onToggle={toggle} />)
  const title = screen.getByText('Top projects')
  const note = screen.getByText('0% attributed')
  expect(title.parentElement).toBe(note.parentElement)
  expect(getComputedStyle(title.parentElement!).flexDirection).toBe('column')
  expect(Number(getComputedStyle(title).flexGrow) || 0).toBe(0)
  expect(getComputedStyle(title).whiteSpace).not.toBe('nowrap')
  expect(getComputedStyle(note).whiteSpace).not.toBe('nowrap')
  fireEvent.click(screen.getByRole('button', { name: 'Top projects, 0% attributed, expanded' }))
  expect(toggle).toHaveBeenCalledOnce()
})

it('keeps the usage hero, quota and machines when the first task-cost read fails', () => {
  const p = props({ tasksFailed: true })
  expect(p.quota.length).toBeGreaterThan(0)
  render(<PulseBody {...p} />)
  expect(screen.getByText(/API-equivalent cost/)).toBeTruthy()
  expect(screen.getByText('Machines')).toBeTruthy()
  expect(screen.queryByText('Couldn’t read quota.')).toBeNull()
  expect(screen.getByText('Couldn’t read task costs.')).toBeTruthy()
  expect(screen.queryByText('Reading task costs…')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
  expect(p.onRetry).toHaveBeenCalledExactlyOnceWith('usage')
})

it('distinguishes a failed quota read from a successful empty quota answer', () => {
  const p = props({ quota: [], quotaCold: true, quotaFailed: true })
  const view = render(<PulseBody {...p} />)
  expect(screen.getByText('Couldn’t read quota.')).toBeTruthy()
  expect(screen.queryByText(/No machine is signed in/)).toBeNull()
  expect(screen.getByText(/API-equivalent cost/)).toBeTruthy()
  expect(screen.getByText('Machines')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
  expect(p.onRetry).toHaveBeenCalledExactlyOnceWith('quota')
  view.rerender(<PulseBody {...p} quotaCold={false} quotaFailed={false} />)
  expect(screen.getByText(/No machine is signed in/)).toBeTruthy()
  expect(screen.queryByText('Couldn’t read quota.')).toBeNull()
})

it('keeps healthy quota and machines during a usage failure and labels stale readings', () => {
  const p = props({ failed: true, cold: true })
  const view = render(<PulseBody {...p} />)
  expect(screen.getByText('Couldn’t read usage.')).toBeTruthy()
  expect(screen.getByText('Machines')).toBeTruthy()
  expect(screen.queryByText('Reading quota…')).toBeNull()
  expect(screen.queryByText(/No machine is signed in/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
  expect(p.onRetry).toHaveBeenCalledExactlyOnceWith('usage')
  view.rerender(<PulseBody {...p} cold={false} />)
  expect(screen.getByText('Couldn’t refresh usage. Showing the last reading.')).toBeTruthy()
})

it('opens a Pulse task by tap, but not after a horizontal drag in either direction or back to its start', () => {
  const stamp = '2026-10-03T12:00:00Z'
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'task',
        value: {
          id: 'task',
          seq: 1,
          title: 'Pulse task',
          stage: 'in_progress',
          createdAt: stamp,
          updatedAt: stamp,
        },
      },
    ],
  })
  const onOpenTask = vi.fn()
  const view = render(
    <PulseBody {...props({ pool, tasks: [{ issueId: 'task', windowCostUsd: 1 }], onOpenTask })} />,
  )
  try {
    const row = screen.getByRole('button', { name: /Pulse task/ })
    const touch = (pageX: number) => ({ identifier: 1, target: row, pageX, pageY: 100 })
    const touches = (pageX: number) => ({
      touches: [touch(pageX)],
      changedTouches: [touch(pageX)],
    })
    for (const distance of [80, -80, 12, -12]) {
      fireEvent.touchStart(row, touches(100))
      fireEvent.touchMove(row, touches(100 + distance))
      fireEvent.touchMove(row, touches(100))
      fireEvent.touchEnd(row, { touches: [], changedTouches: [touch(100)] })
      // Some responders still deliver a release-inside press. It must be ignored.
      fireEvent.click(row)
      expect(onOpenTask).not.toHaveBeenCalled()
    }
    fireEvent.touchStart(row, touches(100))
    fireEvent.touchEnd(row, { touches: [], changedTouches: [touch(100)] })
    fireEvent.click(row, { clientX: 100, clientY: 100 })
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('task')
  } finally {
    view.unmount()
    pool.dispose()
  }
})
