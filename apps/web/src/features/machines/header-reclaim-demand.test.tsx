// @vitest-environment happy-dom
import { listReclaimableWorktreesClient } from '@podium/client-core/values'
import { headerEntities } from '@podium/client-graph/header-entities'
import type { HeaderRows } from '@podium/client-graph/header-schema'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { RowRecord } from '@podium/client-graph/shared/source'
import { asMachineId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { resetPolledQueryCache } from '@/lib/use-polled-query'
import { HeaderHostIndicators } from './HostIndicators'
import { HostInfoView } from './HostMemoryView'
import type { ReclaimInventory } from './use-reclaim-inventory'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-06T12:00:00Z')
const MACHINE = asMachineId('m1')
const stamp = (at: number) => new Date(at).toISOString()
let pool: MobxPool
let rows: RowRecord[]
let occupied: string[]
let now: number

const lifecycle = {
  hibernation: { enabled: false, memoryPct: 80, idleMinutes: 30, loadPerCore: 1.5, maxIdleSessions: 8 },
  worktreeGc: { mode: 'propose', afterDays: 1 },
} as HeaderRows['lifecycle']
const metric = {
  machineId: MACHINE, hostname: 'fixture-host', sampledAt: stamp(NOW),
  memory: { totalBytes: 32e9, availableBytes: 20e9, swapTotalBytes: 0, swapFreeBytes: 0 },
  load: { one: 2, five: 1.5, fifteen: 1, cpuCount: 8 },
} as HeaderRows['hostMetric']
const inventory = (): ReclaimInventory => ({
  candidates: listReclaimableWorktreesClient({
    issues: rows.map(row => row.value as Parameters<typeof listReclaimableWorktreesClient>[0]['issues'][number]),
    occupiedRoots: occupied, afterDays: 1, nowMs: now,
  }).map(candidate => ({ ...candidate, machineId: MACHINE, present: true, protectedReason: null })),
  orphans: [], diagnostics: [],
  estimate: { status: 'unknown', recoverableBytes: null, measuredAt: null },
})
const reclaimInventory = vi.fn(async () => inventory())
const trpc = {
  hosts: {
    reclaimInventory: { mutate: reclaimInventory },
    memoryBreakdown: { mutate: vi.fn(async () => ({
      ...metric, supported: true, agents: [], projects: [], otherBytes: 12e9,
    })) },
  },
  setup: { info: { query: vi.fn(async () => ({ appVersion: '0.5.0' })) } },
  issues: { stop: { mutate: vi.fn() } },
}
const store = {
  trpc, hostMetrics: [metric], machines: [], sessions: [], outboxSize: 0,
  outboxDeadLetters: [], setView: vi.fn(), setSettingsTab: vi.fn(),
}

// Keep the real header projections and pool; only transport and unrelated
// chrome are substituted. Candidate reads are observed at the pool boundary.
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => pool,
  useWorklistPoolProjection<T>(read: (current: MobxPool) => T): T {
    const projection = useMemo(() => createPoolProjection(pool, read), [read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}))
vi.mock('@podium/client-core/react', async (original) => ({
  ...await original<typeof import('@podium/client-core/react')>(),
  useStoreHandle: () => ({ access: store }),
}))
vi.mock('@/app/store', () => ({
  useStore: () => store,
  useHostMetrics: () => store.hostMetrics,
  useRuntimeSelector: (read: (current: typeof store) => unknown) => read(store),
}))
vi.mock('./ConnectionIndicator', () => ({
  useStableConnection: () => ({ health: { status: 'ok', rttMs: 10 }, visible: false }),
  useConnectionHealth: () => ({ status: 'ok', rttMs: 10 }),
  describeHealth: () => ({ headline: 'Connected', detail: '' }),
  ConnectionIndicator: () => null,
}))
vi.mock('../chat/MessageNotices', () => ({ MessageNoticeIndicator: () => null }))
vi.mock('./OutboxRecovery', () => ({ OutboxRecoveryIndicator: () => null }))
vi.mock('./QuotaIndicator', () => ({ QuotaIndicator: () => null }))

function fixture(scale: 1 | 4) {
  const count = 128 * scale
  now = NOW
  occupied = []
  rows = Array.from({ length: count }, (_, at): RowRecord => ({
    kind: 'issue', id: `candidate-${at.toString().padStart(3, '0')}`, value: {
      id: `candidate-${at.toString().padStart(3, '0')}`, seq: at + 1, title: `Candidate ${at}`,
      repoPath: '/repo', repoId: 'repo', worktreePath: `/repo/trees/${at}`, machineId: MACHINE,
      stage: 'done', closedAt: stamp(NOW - DAY + (at === count - 1 ? 1000 : -DAY)),
      createdAt: stamp(NOW - 3 * DAY), updatedAt: stamp(NOW), description: '',
      deps: [], labels: [], archived: false, deletedAt: null,
    },
  }))
  pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW }, undefined, {
    header: true, worklist: 'demand', load: () => undefined, schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows })
  headerEntities(pool).apply([
    { kind: 'hostMetric', id: MACHINE, value: metric },
    { kind: 'lifecycle', id: 'hosts', value: lifecycle },
  ])
  return count
}

function changeTitle() {
  rows[0] = { ...rows[0]!, value: { ...rows[0]!.value, title: 'Renamed candidate' } }
  pool.apply({ type: 'update', rows: [rows[0]!] })
}
function changeOccupancy() {
  occupied = ['/repo/trees/1/src']
  pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'occupant', value: {
    sessionId: 'occupant', cwd: occupied[0], machineId: MACHINE, status: 'live',
    archived: false, lastActiveAt: stamp(NOW), agentKind: 'shell',
  } as RowRecord['value'] }] })
}
function crossDeadline() {
  now = NOW + 1000
  pool.clock.advance(now)
}

beforeAll(async () => { await import('./LoadPanel') })
beforeEach(() => {
  vi.clearAllMocks()
  resetPolledQueryCache()
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); pool?.dispose() })

// Before deleting reclaimCounts, this SAME fixture matched its four answers:
// 1x [127, 127, 126, 127], 4x [511, 511, 510, 511]. The opened panel also
// matched every issue label and title (baseline commit 9ec232383e).
it.each([1, 4] as const)('closed header reads zero reclaim candidates across title, occupancy and deadline changes at %ix', async (scale) => {
  const count = fixture(scale)
  const row = vi.spyOn(pool, 'row')
  // The header is the only mounted pool consumer: the worklist has no demand.
  // Count full rows and summaries, including the old count's summary reads.
  const candidatesRead = () => row.mock.calls.filter(
    ([entity, id]) => entity === 'issue' && id.startsWith('candidate-'),
  ).length
  const samples: Record<string, number> = {}
  render(<HeaderHostIndicators />)
  await act(async () => {})
  samples.mount = candidatesRead()
  expect(samples.mount, 'header mount must not read candidate rows').toBe(0)
  expect(reclaimInventory).not.toHaveBeenCalled()
  const chip = screen.getByRole('button', { name: /fixture-host/ })
  expect(chip.getAttribute('aria-label')).not.toContain('reclaimable worktrees')
  expect(chip.firstElementChild?.classList.contains('bg-success')).toBe(true)

  for (const [name, change] of [
    ['title', changeTitle], ['occupancy', changeOccupancy], ['deadline', crossDeadline],
  ] as const) {
    row.mockClear()
    await act(async () => { change() })
    samples[name] = candidatesRead()
    expect(samples[name], `${name} must not read reclaim candidates while closed`).toBe(0)
    expect(reclaimInventory).not.toHaveBeenCalled()
  }

  // Exercise the real onOpenReclaim route: open the load panel, then Review.
  fireEvent.click(chip)
  const review = await screen.findByRole('button', { name: 'Review' })
  expect(reclaimInventory).toHaveBeenCalledWith({ machineId: MACHINE })
  fireEvent.click(review)
  await screen.findByText(`${count - 1} candidates`)
  const dialog = screen.getByRole('dialog')
  const labels = dialog.querySelectorAll<HTMLLabelElement>('label[for^="reclaim-"]')
  const expected = Array.from({ length: count }, (_, at) => at).filter(at => at !== 1)
  expect([...labels].map(element => [element.htmlFor, element.textContent])).toEqual(
    expected.map(at => [`reclaim-candidate-${at.toString().padStart(3, '0')}`,
      at === 0 ? 'Renamed candidate' : `Candidate ${at}`]),
  )
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(count - 1)
  console.info('[closed header reclaim reads]', JSON.stringify({ scale, candidates: count, samples, opened: labels.length }))
})

it('reads inventory only on the reclaim tab and releases its polling on tab close and unmount', async () => {
  fixture(1)
  const intervals = vi.spyOn(globalThis, 'setInterval')
  const clear = vi.spyOn(globalThis, 'clearInterval')
  let answer!: (value: ReclaimInventory) => void
  reclaimInventory.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
  const view = render(<HostInfoView initialTab="connection" machineId={MACHINE} onClose={() => {}} />)
  await act(async () => {})
  expect(reclaimInventory).not.toHaveBeenCalled()
  const firstInterval = intervals.mock.calls.length
  fireEvent.click(screen.getByRole('tab', { name: 'Reclaim' }))
  expect(screen.getByText('Counting checkouts…')).toBeTruthy()
  expect(screen.getByText('Reading git worktrees…')).toBeTruthy()
  expect(screen.queryByText('Nothing reclaimable on this machine.')).toBeNull()
  await act(async () => { answer(inventory()) })
  await screen.findByText('127 candidates')
  const reclaimTimer = intervals.mock.results[firstInterval]?.value
  expect(intervals.mock.calls[firstInterval]?.[1]).toBe(5000)
  expect(reclaimInventory).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('tab', { name: 'Connection' }))
  await waitFor(() => expect(screen.queryByText('127 candidates')).toBeNull())
  expect(clear).toHaveBeenCalledWith(reclaimTimer)
  await act(async () => { changeTitle(); changeOccupancy(); crossDeadline() })
  expect(reclaimInventory).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('tab', { name: 'Reclaim' }))
  await screen.findByText('127 candidates')
  expect(reclaimInventory).toHaveBeenCalledTimes(2)
  const reopenedTimer = intervals.mock.results.at(-1)?.value
  view.unmount()
  expect(clear).toHaveBeenCalledWith(reopenedTimer)
})
