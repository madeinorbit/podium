import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { refreshClocks } from '@podium/mobx-helpers'
import {
  asIssueId,
  asSessionId,
  asUserId,
  issueUserStateRowId,
} from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '@/app/CommandPalette'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { referenceState } from '../../../../../tests/worklist/diagnostics/reference-state'
import { createSidebarFixture } from '../../../test/sidebar-fixture'
import { SidebarUnified } from './SidebarUnified'

const mode = vi.hoisted(() => ({
  reads: 0,
  commits: new Map<string, number>(),
  ageCommits: new Map<string, number>(),
}))
vi.mock('@podium/client-core/perf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@podium/client-core/perf')>()),
  beginSwitch: vi.fn(),
}))
// Count the actual rendered shell: a companion now updates inside its observer,
// so a wrapper around the old copied-props boundary no longer sees those renders.
vi.mock('./WorkRowShell', async (importOriginal) => {
  const original = await importOriginal<typeof import('./WorkRowShell')>()
  const { useLayoutEffect } = await import('react')
  return {
    ...original,
    WorkRowShell: (props: Parameters<typeof original.WorkRowShell>[0]) => {
      const id = props.domMark
      useLayoutEffect(() => {
        if (id) mode.commits.set(id, (mode.commits.get(id) ?? 0) + 1)
      })
      return <original.WorkRowShell {...props} />
    },
  }
})
vi.mock('./work-folds', async (importOriginal) => {
  const original = await importOriginal<typeof import('./work-folds')>()
  const { useLayoutEffect, Profiler } = await import('react')
  const { observer } = await import('@podium/client-graph/react')
  const CountedFolded = (props: Parameters<typeof original.FoldedWorkRow>[0]) => {
    const record = props as unknown as Record<string, unknown>
    const row = record['row'] as { issue?: { id: string } } | undefined
    const model = record['model'] as { issue?: { id: string } } | undefined
    const issue = model?.issue ?? (record['issue'] as { id: string } | undefined) ?? row?.issue
    const session = record['session'] as { sessionId: string } | undefined
    const id = issue?.id ?? session?.sessionId
    useLayoutEffect(() => {
      if (id) mode.commits.set(id, (mode.commits.get(id) ?? 0) + 1)
    })
    // POD-3911: the profiler sees the clock leaf; the effect above counts row bodies.
    return (
      <Profiler
        id={`fold-age:${id}`}
        onRender={() => {
          if (id) mode.ageCommits.set(id, (mode.ageCommits.get(id) ?? 0) + 1)
        }}
      >
        {original.FoldedWorkRow(props)}
      </Profiler>
    )
  }
  return { ...original, FoldedWorkRow: CountedFolded, WorklistFoldedRow: observer(CountedFolded) }
})
vi.mock('@/features/mobile-handoff/MobilePromoCard', () => ({
  MobilePromoCard: () => <div data-testid="mobile-promo-marker" />,
}))

let runtime: ClientRuntime
let pool: ReturnType<typeof useWorklistPool> = null
function Capture() {
  runtime = useStoreHandle() as ClientRuntime
  pool = useWorklistPool()
  return null
}
const NOW = Date.parse('2026-10-01T08:00:00Z')

async function mount(layer: 'pool', count = 12) {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  mode.reads = 0
  mode.commits.clear()
  pool = null
  const fixture = createSidebarFixture(count, NOW, false, `sidebar-${layer}`)
  render(
    <StoreProvider
      principal={asClientPrincipal(asUserId(`sidebar-${layer}`))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => fixture.replica}
      networkEnabled={false}
      onFatalError={(message) => {
        throw new Error(message)
      }}
      attachRuntime={(owner) =>
        attachWorklistPool(owner, (error) => {
          throw error
        })
      }
    >
      <ConfirmProvider>
        <Capture />
        <SidebarUnified />
        <CommandPalette />
      </ConfirmProvider>
    </StoreProvider>,
  )
  await act(async () => {
    await referenceState(runtime).refreshRepos()
  })
  await waitFor(() => expect(screen.getByTestId('work-scroll')).toBeTruthy(), { timeout: 10000 })
  if (layer === 'pool') await waitFor(() => expect(pool).not.toBeNull())
  await waitFor(() => expect(screen.getByText('Only responsive target')).toBeTruthy(), {
    timeout: 10000,
  })
  return fixture
}

/** Drive the same runtime publication as the wall clock without faking DOM polling timers. */
async function advanceClock(byMs: number) {
  const now = referenceState(runtime).coarseNow + byMs
  await act(async () => {
    vi.setSystemTime(now)
    refreshClocks()
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('real sidebar pool cutover', () => {
  it('offers no phone-app banner while the app is not in the stores', async () => {
    // Its QR is a `podium:` link only the store app opens (POD-5969); none is published yet.
    await mount('pool')
    expect(screen.queryByTestId('mobile-promo-marker')).toBeNull()
  })

  it('retires collapsed group rows and reveals current data on expansion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fixture = await mount('pool')
    const row = document.querySelector('[data-issue-row="synthetic-11"]')!
    const group = row.closest('[data-testid="project-group"]')!
    const button = group.querySelector('[data-testid="project-group-label"]')!
    const reads = vi.spyOn(sidebarView(pool!), 'row')
    try {
      await act(async () => {
        fireEvent.click(button)
      })
      await waitFor(() =>
        expect(group.querySelector('[data-testid="project-group-rows"]')).toBeNull(),
      )
      expect(row.isConnected).toBe(false)
      reads.mockClear()
      mode.commits.clear()
      await act(async () => {
        fixture.patch('issueProjection', 'synthetic-11', { title: 'Changed while folded' })
      })
      await advanceClock(60_000)
      expect(reads.mock.calls.filter(([id]) => id === 'synthetic-11')).toEqual([])
      await act(async () => {
        fireEvent.click(button)
      })
      await waitFor(() =>
        expect(group.querySelector('[data-issue-row="synthetic-11"]')?.textContent).toContain(
          'Changed while folded',
        ),
      )
      await act(async () => {
        fireEvent.click(button)
      })
      await waitFor(() => expect(group.querySelector('[data-issue-row="synthetic-11"]')).toBeNull())
      await act(async () => {
        fireEvent.click(button)
      })
      expect(group.querySelector('[data-issue-row="synthetic-11"]')?.textContent).toContain(
        'Changed while folded',
      )
    } finally {
      reads.mockRestore()
    }
  })

  it('updates only the folded age leaf at its clock ticks and leaves row bodies cold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fixture = await mount('pool')
    const stamp = new Date(NOW - (2 * 60 + 28) * 60_000).toISOString()
    await act(async () => {
      fixture.patch('issueProjection', 'synthetic-5', { closedAt: stamp })
      fixture.patch(
        'issueUserState',
        issueUserStateRowId(asUserId('sidebar-pool'), asIssueId('synthetic-5')),
        { tuckedAt: stamp },
      )
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('work-lane-closed'))
    })
    expect(screen.getByTestId('folded-work-row').textContent).toContain('2h')
    mode.commits.clear()
    mode.ageCommits.clear()
    await advanceClock(60_000)
    expect(Object.fromEntries(mode.commits)).toEqual({})
    expect(Object.fromEntries(mode.ageCommits)).toEqual({ 'synthetic-5': 1 })
    expect(screen.getByTestId('folded-work-row').textContent).toContain('2h')
    mode.ageCommits.clear()
    await advanceClock(60_000)
    expect(Object.fromEntries(mode.commits)).toEqual({})
    expect(Object.fromEntries(mode.ageCommits)).toEqual({ 'synthetic-5': 1 })
    expect(screen.getByTestId('folded-work-row').textContent).toContain('3h')
    mode.commits.clear()
    mode.ageCommits.clear()
    await advanceClock(60_000)
    expect(Object.fromEntries(mode.commits)).toEqual({})
    expect(Object.fromEntries(mode.ageCommits)).toEqual({ 'synthetic-5': 1 })
    expect(mode.reads).toBe(0)
  })

  it('commits only changed displayed rows; reorder and an unused session name keep them cold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fixture = await mount('pool')
    mode.commits.clear()
    await act(async () => {
      fixture.patch('issueProjection', 'synthetic-11', { title: 'Changed visible title' })
    })
    expect(Object.fromEntries(mode.commits)).toEqual({ 'synthetic-11': 1 })
    mode.commits.clear()
    await act(async () => {
      fixture.patch('issueProjection', 'synthetic-11', { sortKey: 'a' })
    })
    expect(Object.fromEntries(mode.commits)).toEqual({})
    await act(async () => {
      fixture.patch('session', 'synthetic-session-11', { name: 'Unused roster name' })
    })
    expect(Object.fromEntries(mode.commits)).toEqual({})
    await act(async () => {
      fixture.patch('session', 'synthetic-guest-0', { geometry: { cols: 100, rows: 30 } })
    })
    expect(Object.fromEntries(mode.commits)).toEqual({})
    await act(async () => {
      fixture.patch('session', 'synthetic-guest-0', { name: 'Changed task-less session name' })
    })
    expect(Object.fromEntries(mode.commits)).toEqual({})
    expect(mode.reads).toBe(0)
  })

  it('keeps issue navigation, pane choice, folds, selection and filtered rows on the existing actions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    await mount('pool')
    fireEvent.click(screen.getByText('Only responsive target'))
    expect(referenceState(runtime).selectedIssueId).toBe('synthetic-11')
    expect(referenceState(runtime).paneA).toBe('synthetic-session-11')
    fireEvent.change(screen.getByTestId('work-search-input'), {
      target: { value: 'only responsive target' },
    })
    await waitFor(() => expect(screen.getAllByTestId('unified-issue-row')).toHaveLength(1))
    expect(screen.getByTestId('work-search-count').textContent).toBe('1/8')
    expect(mode.reads).toBe(0)
  })

  it('preserves legacy navigation membership for exited, headless and archived sessions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    for (const layer of ['pool'] as const) {
      const fixture = await mount(layer)
      await act(async () => {
        fixture.patch('session', 'synthetic-session-11', { status: 'exited' })
        referenceState(runtime).setPane('A', asSessionId('synthetic-guest-1'))
      })
      fireEvent.click(screen.getByText('Only responsive target'))
      expect(referenceState(runtime).paneA).toBe('synthetic-session-11')
      await act(async () => {
        fixture.patch('session', 'synthetic-session-11', { status: 'live', headless: true })
        referenceState(runtime).setPane('A', asSessionId('synthetic-guest-1'))
      })
      fireEvent.click(screen.getByText('Only responsive target'))
      expect(referenceState(runtime).paneA).toBe('synthetic-guest-1')
      await act(async () => {
        fixture.patch('session', 'synthetic-session-11', { headless: false, archived: true })
      })
      fireEvent.click(screen.getByText('Only responsive target'))
      expect(referenceState(runtime).paneA).toBe('synthetic-guest-1')
      cleanup()
    }
  })
})
