import { DEMO_QUOTA, DEMO_USAGE_BUCKETS } from '@podium/client-core/demo'
import {
  gatingQuotaRows,
  groupQuotaByAccount,
  modelShares,
  usageSummary,
  visibleFleetOperations,
} from '@podium/client-core/values'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PulseBody, type PulseBodyProps } from './PulseBody'
import { pulseHero } from './pulse-view'

afterEach(cleanup)
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
