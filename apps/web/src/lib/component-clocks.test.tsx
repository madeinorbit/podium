import type { ConnectionHealth } from '@podium/client-core/socket-transport'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SyncLoader } from '@/app/SyncLoader'
import { ConnectionIndicator, describeHealth } from '@/features/machines/ConnectionIndicator'
import { HostInfoView } from '@/features/machines/HostMemoryView'
import { formatHandoverElapsed, HandoverPane } from '@/features/terminal/HandoverPane'
import { SyncProgressStore } from './sync-progress'

const health: ConnectionHealth = { status: 'down', rttMs: null, since: 90_000 }
vi.mock('@/app/header-data', () => ({ usePoolHeaderConnection: () => health }))
vi.mock('@/app/store', () => ({ useHostMetrics: () => [] }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  TooltipContent: () => null,
}))
vi.mock('@/components/ui/dialog', () => {
  const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return { Dialog: Part, DialogContent: Part, DialogHeader: Part, DialogTitle: Part }
})
vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: ReactNode }) => <>{children}</>,
  TabsList: () => null,
  TabsContent: ({ value, children }: { value: string; children: ReactNode }) =>
    value === 'connection' ? <>{children}</> : null,
}))

afterEach(() => { cleanup(); vi.useRealTimers() })

it('keeps the sync elapsed answer at one-second precision', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const store = new SyncProgressStore()
  const view = render(<SyncLoader store={store} reposLoaded={false} repoCount={0} worktreeCount={0} />)
  const clock = () => view.container.querySelector('.sync-loader-foot-clock')?.textContent
  expect(clock()).toBe('0:00')
  act(() => vi.advanceTimersByTime(999))
  expect(clock()).toBe('0:00')
  act(() => vi.advanceTimersByTime(1))
  expect(clock()).toBe('0:01')
  act(() => vi.advanceTimersByTime(60_000))
  expect(clock()).toBe('1:01')
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the handover elapsed answer at one-second precision', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const view = render(<HandoverPane view={{ from: 'home', to: 'remote', phase: 'transit' }} background="black" />)
  expect(screen.getByText(formatHandoverElapsed(0))).toBeTruthy()
  act(() => vi.advanceTimersByTime(999))
  expect(screen.getByText(formatHandoverElapsed(0))).toBeTruthy()
  act(() => vi.advanceTimersByTime(1))
  expect(screen.getByText(formatHandoverElapsed(1))).toBeTruthy()
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps both unhealthy connection descriptions in step with their old answers', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const view = render(<><ConnectionIndicator health={health} /><HostInfoView initialTab="connection" onClose={() => {}} /></>)
  const label = (at: number) => {
    const { headline, detail } = describeHealth(health, at)
    expect(screen.getByRole('button', { name: `${headline}. ${detail}` })).toBeTruthy()
    expect(screen.getByText(detail)).toBeTruthy()
  }
  label(100_000)
  act(() => vi.advanceTimersByTime(999))
  label(100_000)
  act(() => vi.advanceTimersByTime(1))
  label(101_000)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
