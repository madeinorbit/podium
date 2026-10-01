import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { worklistSlice } from '@podium/client-core/viewmodels'
import { asSessionId, asUserId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '@/app/CommandPalette'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { createSidebarFixture } from '../../../test/sidebar-fixture'
import { SidebarRail } from './SidebarRail'
import { SidebarUnified } from './SidebarUnified'

const mode = vi.hoisted(() => ({
  value: 'pool' as 'legacy' | 'pool',
  reads: 0,
  commits: new Map<string, number>(),
}))
vi.mock('@/lib/sidebar-data-layer', () => ({
  sidebarDataLayer: () => mode.value,
  initializeSidebarDataLayer: () => {},
  sidebarCheckRequested: () => false,
}))
vi.mock('@/app/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/app/store')>()
  return {
    ...original,
    useSlice: (definition: unknown) => {
      if (definition === worklistSlice) {
        mode.reads += 1
        if (mode.value === 'pool') throw new Error('Pool path read worklistSlice')
      }
      return original.useSlice(definition as Parameters<typeof original.useSlice>[0])
    },
  }
})
vi.mock('./sidebar-measurements', async (importOriginal) => {
  const original = await importOriginal<typeof import('./sidebar-measurements')>()
  const { useLayoutEffect } = await import('react')
  return {
    ...original,
    measureSidebarRow:
      (Row: (props: Record<string, unknown>) => unknown) => (props: Record<string, unknown>) => {
        const row = props['row'] as { issue?: { id: string } } | undefined
        const issue = props['issue'] as { id: string } | undefined
        const session = props['session'] as { sessionId: string } | undefined
        const id = row?.issue?.id ?? issue?.id ?? session?.sessionId
        useLayoutEffect(() => {
          if (id) mode.commits.set(id, (mode.commits.get(id) ?? 0) + 1)
        })
        return Row(props)
      },
    sidebarMeasurementsRequested: () => false,
  }
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

async function mount(layer: 'legacy' | 'pool', rail = false, count = 12) {
  localStorage.clear()
  mode.value = layer
  mode.reads = 0
  mode.commits.clear()
  pool = null
  const fixture = createSidebarFixture(count, NOW)
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
    await runtime.getSnapshot().refreshRepos()
  })
  await waitFor(() =>
    expect(screen.getByTestId(rail ? 'sidebar-rail' : 'work-scroll')).toBeTruthy(),
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

function rowPaint() {
  return [...document.querySelectorAll('[data-testid="unified-issue-row"]')].map((row) => ({
    id: row.getAttribute('data-issue-row'),
    text: row.textContent,
    selected: row.getAttribute('data-selected'),
    unread: row.getAttribute('data-unread'),
    class: row.className,
  }))
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('real sidebar pool cutover', () => {
  it('draws the same rows, bands and folds as legacy, without a worklistSlice read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    await mount('legacy')
    const legacy = rowPaint()
    const bands = screen.getAllByTestId('project-group-label').map((node) => node.textContent)
    expect(mode.reads).toBeGreaterThan(0)
    cleanup()
    await mount('pool')
    expect(mode.reads).toBe(0)
    expect(rowPaint()).toEqual(legacy)
    expect(screen.getAllByTestId('project-group-label').map((node) => node.textContent)).toEqual(
      bands,
    )
    fireEvent.click(screen.getByTestId('snoozed-fold-toggle'))
    fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    expect(screen.getAllByTestId('folded-work-row')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('manage-projects'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => {
      runtime.getSnapshot().setPaletteOpen(true)
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
    expect(runtime.getSnapshot().selectedIssueId).toBe('synthetic-11')
    expect(runtime.getSnapshot().paneA).toBe('synthetic-session-11')
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
    mode.value = 'pool'
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
    for (const layer of ['legacy', 'pool'] as const) {
      const fixture = await mount(layer)
      await act(async () => {
        fixture.patch('session', 'synthetic-session-11', { status: 'exited' })
        runtime.getSnapshot().setPane('A', asSessionId('synthetic-guest-1'))
      })
      fireEvent.click(screen.getByText('Only responsive target'))
      expect(runtime.getSnapshot().paneA).toBe('synthetic-session-11')
      await act(async () => {
        fixture.patch('session', 'synthetic-session-11', { status: 'live', headless: true })
        runtime.getSnapshot().setPane('A', asSessionId('synthetic-guest-1'))
      })
      fireEvent.click(screen.getByText('Only responsive target'))
      expect(runtime.getSnapshot().paneA).toBe('synthetic-guest-1')
      await act(async () => {
        fixture.patch('session', 'synthetic-session-11', { headless: false, archived: true })
        fixture.patch('session', 'synthetic-guest-0', {
          archived: true,
          lastActiveAt: new Date(NOW).toISOString(),
        })
      })
      fireEvent.click(screen.getByText('Only responsive target'))
      expect(runtime.getSnapshot().paneA).toBe('synthetic-guest-1')
      await act(async () => runtime.getSnapshot().setPane('A', null))
      fireEvent.click(screen.getByText('project · guests'))
      expect(runtime.getSnapshot().paneA).toBe('synthetic-guest-1')
      cleanup()
    }
  })
})
