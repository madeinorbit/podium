import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { referenceState } from '../../../../../tests/worklist/diagnostics/reference-state'
import type { ClientRuntime } from '@podium/client-core/engine'
import { beginSwitch } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { worklistSlice } from '../../../../../tests/worklist/diagnostics/reference/worklist'
import { sessionUserStateRowId } from '@podium/model'
import {
  asIssueId,
  asSessionId,
  asUserId,
  issueUserStateRowId,
  type SessionId,
} from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '@/app/CommandPalette'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { expectPoolOutput } from '../../../../../tests/worklist/harness/src/oracle/pool-output'
import { createSidebarFixture } from '../../../test/sidebar-fixture'
import { SidebarRail } from './SidebarRail'
import { SidebarUnified } from './SidebarUnified'

const mode = vi.hoisted(() => ({
  reads: 0,
  commits: new Map<string, number>(),
  worktrees: new Map<
    string,
    { onSelect: () => void; onSelectPanel: (id: SessionId) => void; commits: number }
  >(),
}))
vi.mock('@podium/client-core/perf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@podium/client-core/perf')>()),
  beginSwitch: vi.fn(),
}))
vi.mock('./UnifiedWorktreeRow', async (importOriginal) => {
  const original = await importOriginal<typeof import('./UnifiedWorktreeRow')>()
  const { useLayoutEffect } = await import('react')
  return {
    ...original,
    UnifiedWorktreeRow: (props: Parameters<typeof original.UnifiedWorktreeRow>[0]) => {
      useLayoutEffect(() => {
        const path = (props.model?.worktree ?? props.row!.worktree).path
        mode.worktrees.set(path, {
          onSelect: props.onSelect,
          onSelectPanel: props.onSelectPanel,
          commits: (mode.worktrees.get(path)?.commits ?? 0) + 1,
        })
      })
      return original.UnifiedWorktreeRow(props)
    },
  }
})

vi.mock('./UnifiedIssueRow', async (importOriginal) => {
  const original = await importOriginal<typeof import('./UnifiedIssueRow')>()
  const React = await import('react')
  const { memo, useLayoutEffect } = React
  const Counted = memo((props: Parameters<typeof original.UnifiedIssueRow>[0]) => {
    // Props carry the issue model under different keys depending on the caller.
    const record = props as unknown as Record<string, unknown>
    const row = record['row'] as { issue?: { id: string } } | undefined
    const issue = (record['issue'] as { id: string } | undefined) ?? row?.issue
    const id = issue?.id ?? (record['issueId'] as string | undefined)
    useLayoutEffect(() => {
      if (id) mode.commits.set(id, (mode.commits.get(id) ?? 0) + 1)
    })
    return React.createElement(original.UnifiedIssueRow, props)
  })
  return { ...original, UnifiedIssueRow: Counted }
})
vi.mock('./sidebar-common', async (importOriginal) => {
  const original = await importOriginal<typeof import('./sidebar-common')>()
  const { useLayoutEffect } = await import('react')
  const CountedPanelRow = (props: Parameters<typeof original.PanelRow>[0]) => {
    const session = (props as unknown as { session?: { sessionId: string } }).session
    const id = session?.sessionId
    useLayoutEffect(() => {
      if (id) mode.commits.set(id, (mode.commits.get(id) ?? 0) + 1)
    })
    return original.PanelRow(props)
  }
  return { ...original, PanelRow: CountedPanelRow }
})
vi.mock('./work-folds', async (importOriginal) => {
  const original = await importOriginal<typeof import('./work-folds')>()
  const { useLayoutEffect } = await import('react')
  const CountedFolded = (props: Parameters<typeof original.FoldedWorkRow>[0]) => {
    const record = props as unknown as Record<string, unknown>
    const row = record['row'] as { issue?: { id: string } } | undefined
    const issue = (record['issue'] as { id: string } | undefined) ?? row?.issue
    const session = record['session'] as { sessionId: string } | undefined
    const id = issue?.id ?? session?.sessionId
    useLayoutEffect(() => {
      if (id) mode.commits.set(id, (mode.commits.get(id) ?? 0) + 1)
    })
    return original.FoldedWorkRow(props)
  }
  return { ...original, FoldedWorkRow: CountedFolded }
})
vi.mock('@/features/mobile-handoff/MobilePromoCard', () => ({ MobilePromoCard: () => null }))

let runtime: ClientRuntime
let pool: ReturnType<typeof useWorklistPool> = null
function Capture() {
  runtime = useStoreHandle() as ClientRuntime
  pool = useWorklistPool()
  return null
}
const NOW = Date.parse('2026-10-01T08:00:00Z')
const LAYERS = ['pool'] as const

function guestUserStateId(layer: 'pool') {
  return sessionUserStateRowId(asUserId(`sidebar-${layer}`), asSessionId('synthetic-guest-0'))
}

async function mount(layer: 'pool', rail = false, count = 12) {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  mode.reads = 0
  mode.commits.clear()
  mode.worktrees.clear()
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
        {rail ? <SidebarRail /> : <SidebarUnified />}
        <CommandPalette />
      </ConfirmProvider>
    </StoreProvider>,
  )
  await act(async () => {
    await referenceState(runtime).refreshRepos()
  })
  await waitFor(
    () => expect(screen.getByTestId(rail ? 'sidebar-rail' : 'work-scroll')).toBeTruthy(),
    { timeout: 10000 },
  )
  if (layer === 'pool') await waitFor(() => expect(pool).not.toBeNull())
  await waitFor(() => expect(screen.getByText('Only responsive target')).toBeTruthy(), {
    timeout: 10000,
  })
  await waitFor(
    () => expect(document.querySelectorAll('[data-session^="synthetic-guest-"]')).toHaveLength(2),
    { timeout: 10000 },
  )
  return fixture
}

function worktreeHandlers(path: string) {
  const handlers = mode.worktrees.get(path)
  if (!handlers) throw new Error(`Worktree row not mounted: ${path}`)
  return handlers
}

function rowPaint() {
  return [...document.querySelectorAll('[data-testid="unified-issue-row"]')].map((row) => {
    const body = row.querySelector('[data-issue-row]') ?? row
    return {
      id: body.getAttribute('data-issue-row'),
      text: row.textContent,
      selected: body.getAttribute('data-selected'),
      unread: body.getAttribute('data-unread'),
      class: body.className,
    }
  })
}

/** Drive the same runtime publication as the wall clock without faking DOM polling timers. */
async function advanceClock(byMs: number) {
  const now = referenceState(runtime).coarseNow + byMs
  await act(async () => {
    vi.setSystemTime(now)
    const clockPublisher = runtime as unknown as { apply(patch: { coarseNow: number }): void }
    clockPublisher.apply({ coarseNow: now })
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('real sidebar pool cutover', () => {
  it('retires collapsed group rows and reveals current data on expansion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fixture = await mount('pool')
    const row = document.querySelector('[data-issue-row="synthetic-11"]')!
    const group = row.closest('[data-testid="project-group"]')!
    const button = group.querySelector('[data-testid="project-group-label"]')!
    const reads = vi.spyOn(sidebarView(pool!), 'row')
    const trees = vi.spyOn(sidebarView(pool!), 'worktree')
    try {
      await act(async () => {
        fireEvent.click(button)
      })
      await waitFor(() =>
        expect(group.querySelector('[data-testid="project-group-rows"]')).toBeNull(),
      )
      expect(row.isConnected).toBe(false)
      reads.mockClear()
      trees.mockClear()
      mode.commits.clear()
      await act(async () => {
        fixture.patch('issueProjection', 'synthetic-11', { title: 'Changed while folded' })
        fixture.patch('session', 'synthetic-guest-0', { title: 'Guest changed while folded' })
      })
      await advanceClock(60_000)
      expect(reads.mock.calls.filter(([id]) => id === 'synthetic-11')).toEqual([])
      expect(trees.mock.calls.filter(([path]) => path === '/synthetic/project/guests')).toEqual([])
      await act(async () => {
        fireEvent.click(button)
      })
      await waitFor(() =>
        expect(group.querySelector('[data-issue-row="synthetic-11"]')?.textContent).toContain(
          'Changed while folded',
        ),
      )
      expect(group.querySelector('[data-session="synthetic-guest-0"]')!.textContent).toContain(
        'Guest changed while folded',
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
      trees.mockRestore()
    }
  })

  it.each(
    LAYERS,
  )('%s guest rows preserve the clock behavior of their data layer', async (layer) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fixture = await mount(layer)
    await act(async () => {
      fixture.patch('sessionUserState', guestUserStateId(layer), {
        snoozedUntil: new Date(NOW + 120_000).toISOString(),
      })
    })
    mode.commits.clear()
    await advanceClock(60_000)
    expect(referenceState(runtime).coarseNow).toBe(NOW + 60_000)
    const guests = Object.fromEntries(
      [...mode.commits].filter(([id]) => id.startsWith('synthetic-guest-')),
    )
    expect(guests).toEqual({})
    await advanceClock(60_000)
    expect(document.querySelector('[data-session="synthetic-guest-0"]')!.textContent).toContain(
      'Unsnoozed',
    )
    if (layer === 'pool') expect(mode.reads).toBe(0)
  })

  it('expires a pool guest snooze only at its deadline and handles a clock rewind', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fixture = await mount('pool')
    await act(async () => {
      fixture.patch('sessionUserState', guestUserStateId('pool'), {
        snoozedUntil: new Date(NOW + 120_000).toISOString(),
      })
    })
    const guest = () => document.querySelector('[data-session="synthetic-guest-0"]')!
    expect(guest().textContent).not.toContain('Unsnoozed')
    expect(guest().querySelector('button[aria-haspopup="menu"]')).not.toBeNull()
    mode.commits.clear()
    await advanceClock(60_000)
    expect(Object.fromEntries(mode.commits)).toEqual({})
    await advanceClock(60_000)
    expect(Object.fromEntries(mode.commits)).toEqual({ 'synthetic-guest-0': 1 })
    expect(guest().textContent).toContain('Unsnoozed')
    expect(guest().querySelector('button[aria-haspopup="menu"]')).toBeNull()
    mode.commits.clear()
    await advanceClock(60_000)
    expect(Object.fromEntries(mode.commits)).toEqual({})
    await advanceClock(-120_000)
    expect(Object.fromEntries(mode.commits)).toEqual({ 'synthetic-guest-0': 1 })
    expect(guest().textContent).not.toContain('Unsnoozed')
    expect(guest().querySelector('button[aria-haspopup="menu"]')).not.toBeNull()
    expect(mode.reads).toBe(0)
  })

  it.each([
    null,
    'not-a-date',
  ])('keeps a pool guest with snooze %s cold across ticks', async (snoozedUntil) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fixture = await mount('pool')
    await act(async () => {
      fixture.patch('sessionUserState', guestUserStateId('pool'), { snoozedUntil })
    })
    mode.commits.clear()
    await advanceClock(120_000)
    expect(Object.fromEntries(mode.commits)).toEqual({})
    expect(document.querySelector('[data-session="synthetic-guest-0"]')!.textContent).not.toContain(
      'Unsnoozed',
    )
    expect(mode.reads).toBe(0)
  })

  it('redraws only the folded pool row whose displayed age crosses an hour boundary', async () => {
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
      fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    })
    expect(screen.getByTestId('folded-work-row').textContent).toContain('2h ago')
    mode.commits.clear()
    await advanceClock(60_000)
    expect(Object.fromEntries(mode.commits)).toEqual({})
    await advanceClock(60_000)
    expect(Object.fromEntries(mode.commits)).toEqual({ 'synthetic-5': 1 })
    expect(screen.getByTestId('folded-work-row').textContent).toContain('3h ago')
    mode.commits.clear()
    await advanceClock(60_000)
    expect(Object.fromEntries(mode.commits)).toEqual({})
    expect(mode.reads).toBe(0)
  })

  it.each(LAYERS)('%s worktree header ignores a session archived after mount', async (layer) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fixture = await mount(layer)
    const path = '/synthetic/project/guests'
    const handlers = worktreeHandlers(path)
    await act(async () => {
      fixture.patch('session', 'synthetic-guest-0', {
        archived: true,
        lastActiveAt: new Date(NOW).toISOString(),
      })
      referenceState(runtime).setPane('A', null)
    })
    await waitFor(() =>
      expect(document.querySelector('[data-session="synthetic-guest-0"]')).toBeNull(),
    )
    expect(worktreeHandlers(path).onSelect).toBe(handlers.onSelect)
    expect(worktreeHandlers(path).onSelectPanel).toBe(handlers.onSelectPanel)
    fireEvent.click(screen.getByTitle(path))
    expect(referenceState(runtime).paneA).toBe('synthetic-guest-1')
    expect(referenceState(runtime).selectedWorktree).toBe(path)
  })

  it.each(LAYERS)('%s worktree header preserves the current pane session', async (layer) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fixture = await mount(layer)
    const path = '/synthetic/project/guests'
    const handlers = worktreeHandlers(path)
    await act(async () => {
      fixture.patch('session', 'synthetic-guest-0', {
        lastActiveAt: new Date(NOW).toISOString(),
      })
      referenceState(runtime).setPane('A', asSessionId('synthetic-guest-1'))
    })
    expect(worktreeHandlers(path).onSelect).toBe(handlers.onSelect)
    expect(worktreeHandlers(path).onSelectPanel).toBe(handlers.onSelectPanel)
    fireEvent.click(screen.getByTitle(path))
    expect(referenceState(runtime).paneA).toBe('synthetic-guest-1')
  })

  it('pool worktree panel uses the current pane without restarting a switch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    await mount('pool')
    expect(referenceState(runtime).paneA).not.toBe('synthetic-guest-1')
    const path = '/synthetic/project/guests'
    const handlers = worktreeHandlers(path)
    await act(async () => {
      referenceState(runtime).setPane('A', asSessionId('synthetic-guest-1'))
    })
    expect(worktreeHandlers(path).onSelectPanel).toBe(handlers.onSelectPanel)
    vi.mocked(beginSwitch).mockClear()
    fireEvent.click(screen.getByText('Synthetic guest 1'))
    expect(referenceState(runtime).selectedWorktree).toBe(path)
    expect(referenceState(runtime).paneA).toBe('synthetic-guest-1')
    expect(beginSwitch).not.toHaveBeenCalled()
  })

  it('keeps the pool worktree row cold when another issue changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fixture = await mount('pool')
    const path = '/synthetic/project/guests'
    const before = worktreeHandlers(path)
    await act(async () => {
      fixture.patch('issueProjection', 'synthetic-11', { title: 'Changed visible title' })
    })
    expect(screen.getByText('Changed visible title')).toBeTruthy()
    expect(worktreeHandlers(path)).toBe(before)
  })

  it('draws the same rows, bands and folds as legacy, without a worklistSlice read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    await mount('pool')
    expect(mode.reads).toBe(0)
    expectPoolOutput(
      {
        rows: rowPaint(),
        bands: screen.getAllByTestId('project-group-label').map((node) => node.textContent),
      },
      'rows and bands',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('snoozed-fold-toggle'))
      fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    })
    expect(screen.getAllByTestId('folded-work-row')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('manage-projects'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => {
      referenceState(runtime).setPaletteOpen(true)
    })
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
      fixture.patch('session', 'synthetic-guest-0', { name: 'Changed guest name' })
    })
    expect(Object.fromEntries(mode.commits)).toEqual({ 'synthetic-guest-0': 1 })
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
    expect(screen.getByTestId('work-search-count').textContent).toBe('1/9')
    expect(mode.reads).toBe(0)
  })

  it('keeps the collapsed rail off the legacy worklist', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    mode.reads = 0
    const fixture = createSidebarFixture(12, NOW)
    render(
      <StoreProvider
        principal={asClientPrincipal(asUserId('rail-pool'))}
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
        <Capture />
        <SidebarRail />
      </StoreProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('sidebar-rail')).toBeTruthy())
    expect(mode.reads).toBe(0)
    expect(screen.getAllByTestId('issue-id-square').length).toBeGreaterThan(0)
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
